// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
//
// Additional permission under GNU GPL version 3 section 7:
// the output of this back-end (.stc files), including any part of this file
// copied into it, may be distributed under terms of your choice.
/**
 * AxesBrain .stc back-end (prototype 0.1).
 *
 * Reads the analyzed CompilationUnit produced by the STruC++ front-end and
 * emits bytecode for the AxesBrain virtual machine. Supported subset:
 * elementary types, 1-D arrays of elementary types, FUNCTION, FUNCTION_BLOCK,
 * PROGRAM, CONFIGURATION/TASK, located variables, IF/CASE/FOR/WHILE/REPEAT/
 * EXIT/RETURN, user function and FB calls, a set of standard functions and
 * native functions declared with {external native NAME}.
 */

import type {
  CompilationUnit,
  Expression,
  FunctionBlockDeclaration,
  FunctionCallExpression,
  FunctionDeclaration,
  ProgramDeclaration,
  Statement,
  TypeReference,
  VarBlock,
  VariableExpression,
} from "../frontend/ast.js";
import {
  Base,
  IoArea,
  IoSize,
  Kind,
  kindSize,
  MathFn,
  Op,
  PouKind,
} from "./stc-format.js";
import { exactIntegerLiteralValue } from "../literal-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScalarT {
  t: "scalar";
  name: string;
  kind: Kind;
}
export interface ArrayT {
  t: "array";
  elem: ScalarT;
  lo: number;
  hi: number;
}
export interface FbT {
  t: "fb";
  name: string;
}
export type VT = ScalarT | ArrayT | FbT;

const ELEMENTARY: Record<string, Kind> = {
  BOOL: Kind.U8,
  BYTE: Kind.U8,
  USINT: Kind.U8,
  CHAR: Kind.U8,
  SINT: Kind.I8,
  WORD: Kind.U16,
  UINT: Kind.U16,
  INT: Kind.I16,
  DWORD: Kind.U32,
  UDINT: Kind.U32,
  DINT: Kind.I32,
  LINT: Kind.I64,
  TIME: Kind.I64,
  LTIME: Kind.I64,
  DATE: Kind.I64,
  TIME_OF_DAY: Kind.I64,
  TOD: Kind.I64,
  DATE_AND_TIME: Kind.I64,
  DT: Kind.I64,
  LWORD: Kind.U64,
  ULINT: Kind.U64,
  REAL: Kind.F32,
  LREAL: Kind.F64,
};

function scalar(name: string): ScalarT | undefined {
  const k = ELEMENTARY[name];
  return k === undefined ? undefined : { t: "scalar", name, kind: k };
}
const T_BOOL = scalar("BOOL")!;
const T_LINT = scalar("LINT")!;
const T_LREAL = scalar("LREAL")!;
const T_TIME = scalar("TIME")!;

const isFloat = (s: ScalarT) => s.kind === Kind.F32 || s.kind === Kind.F64;
const isUnsigned = (s: ScalarT) =>
  s.kind === Kind.U8 ||
  s.kind === Kind.U16 ||
  s.kind === Kind.U32 ||
  s.kind === Kind.U64;
const isBool = (s: ScalarT) => s.name === "BOOL";

export class StcError extends Error {
  constructor(
    message: string,
    public line = 0,
    public column = 0,
    public file = "",
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface VarSlot {
  name: string;
  type: VT;
  off: number;
  section: string; // VAR, VAR_INPUT, VAR_OUTPUT, VAR_TEMP, RETURN
  init?: Expression;
  address?: string;
}

interface Layout {
  size: number;
  vars: Map<string, VarSlot>;
  order: VarSlot[];
}

interface PouInfo {
  index: number;
  kind: PouKind;
  name: string;
  decl: FunctionDeclaration | FunctionBlockDeclaration | ProgramDeclaration;
  layout: Layout; // frame (FUNCTION) or instance (FB / PROGRAM)
  params: VarSlot[]; // FUNCTION inputs, in order
  ret?: VarSlot; // FUNCTION return value
  code: number[];
  native?: string; // FUNCTION implemented by the host
  hiddenCount: number;
}

interface Place {
  base: Base;
  off: number;
  type: VT;
}

const align = (n: number, a: number) => Math.ceil(n / a) * a;

// ---------------------------------------------------------------------------
// Literal helpers
// ---------------------------------------------------------------------------

/** Parse an IEC duration literal (T#1h2m3s4ms5us6ns, T#1.5s, -T#2s) to ns. */
export function parseTimeLiteral(raw: string): bigint {
  let s = raw.toUpperCase().replace(/_/g, "");
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(hash + 1);
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  const units: Record<string, number> = {
    D: 86400e9,
    H: 3600e9,
    M: 60e9,
    S: 1e9,
    MS: 1e6,
    US: 1e3,
    NS: 1,
  };
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(MS|US|NS|D|H|M|S)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(s)) !== null) {
    total += parseFloat(m[1]!) * units[m[2]!]!;
    consumed += m[0].length;
  }
  if (consumed !== s.length) {
    throw new StcError(`Letterale di tempo non valido: ${raw}`);
  }
  const v = BigInt(Math.round(total));
  return neg ? -v : v;
}

// ---------------------------------------------------------------------------
// Code buffer
// ---------------------------------------------------------------------------

class Code {
  bytes: number[] = [];
  get pc() {
    return this.bytes.length;
  }
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >> 8);
  }
  u32(v: number) {
    for (let i = 0; i < 4; i++) this.u8((v >>> (8 * i)) & 0xff);
  }
  i32(v: number) {
    this.u32(v >>> 0);
  }
  i64(v: bigint) {
    let x = BigInt.asUintN(64, v);
    for (let i = 0; i < 8; i++) {
      this.u8(Number(x & 0xffn));
      x >>= 8n;
    }
  }
  f64(v: number) {
    const b = new Uint8Array(new Float64Array([v]).buffer);
    for (const x of b) this.u8(x);
  }
  op(o: Op) {
    this.u8(o);
  }
  /** Emit a jump with a placeholder; returns the position to patch. */
  jump(o: Op.JMP | Op.JZ | Op.JNZ): number {
    this.op(o);
    const at = this.pc;
    this.i32(0);
    return at;
  }
  patch(at: number, target: number) {
    const rel = target - (at + 4);
    const u = rel >>> 0;
    for (let i = 0; i < 4; i++) this.bytes[at + i] = (u >>> (8 * i)) & 0xff;
  }
  jumpTo(o: Op.JMP | Op.JZ | Op.JNZ, target: number) {
    const at = this.jump(o);
    this.patch(at, target);
  }
}

// ---------------------------------------------------------------------------
// Output model (serialized by stc-writer.ts)
// ---------------------------------------------------------------------------

export interface StcPou {
  kind: PouKind;
  name: string;
  code: number[];
  frameSize: number;
  instSize: number;
  params: Array<{ kind: Kind; off: number }>;
  ret?: { kind: Kind; off: number };
}
export interface StcTask {
  name: string;
  intervalNs: bigint;
  priority: number;
  programs: Array<{ pou: number; instOff: number }>;
}
export interface StcIo {
  area: IoArea;
  size: IoSize;
  byte: number;
  bit: number;
  kind: Kind;
  gOff: number;
}
export interface StcNative {
  name: string;
  params: Kind[];
  ret: Kind | 0;
}
export interface StcSymbol {
  name: string;
  kind: Kind;
  gOff: number;
  /** Element count for arrays (1 for scalars). */
  count: number;
}
export interface StcLine {
  pou: number;
  pc: number;
  line: number;
  col: number;
}
export interface StcModule {
  data: Uint8Array;
  pous: StcPou[];
  tasks: StcTask[];
  io: StcIo[];
  natives: StcNative[];
  symbols: StcSymbol[];
  lines: StcLine[];
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface StcOptions {
  /** Default task period when no CONFIGURATION is present (ns). */
  defaultIntervalNs?: bigint;
}

export class StcGenerator {
  private fbDecls = new Map<string, FunctionBlockDeclaration>();
  private fnDecls = new Map<string, FunctionDeclaration>();
  private progDecls = new Map<string, ProgramDeclaration>();
  private fbLayouts = new Map<string, Layout>();
  private pous: PouInfo[] = [];
  private pouByName = new Map<string, PouInfo>();
  private natives: StcNative[] = [];
  private nativeByName = new Map<string, number>();
  private globals: Layout = { size: 0, vars: new Map(), order: [] };
  private gSize = 0;
  private data: number[] = [];
  private lines: StcLine[] = [];
  private symbols: StcSymbol[] = [];
  private io: StcIo[] = [];
  private tasks: StcTask[] = [];

  // per-POU state
  private cur!: PouInfo;
  private code!: Code;
  private loopExits: number[][] = [];
  private returnJumps: number[] = [];

  constructor(private options: StcOptions = {}) {}

  generate(ast: CompilationUnit): StcModule {
    for (const f of ast.functionBlocks) this.fbDecls.set(f.name, f);
    for (const f of ast.functions) this.fnDecls.set(f.name, f);
    for (const p of ast.programs) this.progDecls.set(p.name, p);

    // POU table: functions, function blocks, programs.
    for (const f of ast.functions) this.declarePou(PouKind.FUNCTION, f);
    for (const f of ast.functionBlocks)
      this.declarePou(PouKind.FUNCTION_BLOCK, f);
    for (const p of ast.programs) this.declarePou(PouKind.PROGRAM, p);

    // Global segment: VAR_GLOBAL blocks, then program instances.
    const globalBlocks: VarBlock[] = [
      ...ast.globalVarBlocks,
      ...ast.configurations.flatMap((c) => c.varBlocks),
    ];
    for (const b of globalBlocks) {
      for (const d of b.declarations) {
        for (const n of d.names) {
          const type = this.resolveType(d.type);
          const off = this.allocGlobal(type);
          const slot: VarSlot = {
            name: n,
            type,
            off,
            section: "VAR_GLOBAL",
            ...(d.initialValue ? { init: d.initialValue } : {}),
            ...(d.address ? { address: d.address } : {}),
          };
          this.globals.vars.set(n, slot);
          this.globals.order.push(slot);
        }
      }
    }

    // Program instances and tasks.
    const instances: Array<{ name: string; prog: string; task?: string }> = [];
    const taskDecls: Array<{
      name: string;
      interval: bigint;
      priority: number;
    }> = [];
    for (const c of ast.configurations) {
      for (const r of c.resources) {
        for (const t of r.tasks) {
          let interval = this.options.defaultIntervalNs ?? 10_000_000n;
          let priority = 0;
          const iv = t.properties.get("INTERVAL");
          if (iv && iv.kind === "LiteralExpression") {
            interval = parseTimeLiteral(String(iv.rawValue));
          }
          const pr = t.properties.get("PRIORITY");
          if (pr && pr.kind === "LiteralExpression")
            priority = Number(pr.value);
          taskDecls.push({ name: t.name, interval, priority });
        }
        for (const pi of r.programInstances) {
          instances.push({
            name: pi.instanceName,
            prog: pi.programType,
            ...(pi.taskName ? { task: pi.taskName } : {}),
          });
        }
      }
    }
    if (instances.length === 0) {
      for (const p of ast.programs)
        instances.push({ name: p.name, prog: p.name, task: "__DEFAULT" });
      taskDecls.push({
        name: "__DEFAULT",
        interval: this.options.defaultIntervalNs ?? 10_000_000n,
        priority: 0,
      });
    }
    const instOffsets: Array<{
      name: string;
      pou: PouInfo;
      off: number;
      task?: string;
    }> = [];
    for (const inst of instances) {
      const pou = this.pouByName.get(inst.prog);
      if (!pou || pou.kind !== PouKind.PROGRAM) {
        throw new StcError(`PROGRAM ${inst.prog} non trovato`);
      }
      const off = this.allocGlobal({ t: "fb", name: inst.prog }, pou.layout);
      instOffsets.push({
        name: inst.name,
        pou,
        off,
        ...(inst.task ? { task: inst.task } : {}),
      });
    }
    for (const t of taskDecls) {
      this.tasks.push({
        name: t.name,
        intervalNs: t.interval,
        priority: t.priority,
        programs: instOffsets
          .filter((i) => i.task === t.name)
          .map((i) => ({ pou: i.pou.index, instOff: i.off })),
      });
    }

    // Initial data image.
    this.data = new Array<number>(this.gSize).fill(0);
    for (const g of this.globals.order) {
      this.initSlot(g, g.off);
      this.symbolsFor(g.name, g.type, g.off);
      if (g.address) this.addIo(g.address, g.type, g.off);
    }
    for (const i of instOffsets) {
      this.initInstance(i.pou.layout, i.off, i.name, true);
    }

    // Code.
    for (const p of this.pous) {
      if (!p.native) this.genPou(p);
    }

    return {
      data: Uint8Array.from(this.data),
      pous: this.pous.map((p) => ({
        kind: p.kind,
        name: p.name,
        code: p.code,
        frameSize: p.kind === PouKind.FUNCTION ? p.layout.size : 0,
        instSize: p.kind === PouKind.FUNCTION ? 0 : p.layout.size,
        params: p.params.map((s) => ({
          kind: (s.type as ScalarT).kind,
          off: s.off,
        })),
        ...(p.ret
          ? { ret: { kind: (p.ret.type as ScalarT).kind, off: p.ret.off } }
          : {}),
      })),
      tasks: this.tasks,
      io: this.io,
      natives: this.natives,
      symbols: this.symbols,
      lines: this.lines,
    };
  }

  // -------------------------------------------------------------------------
  // Declarations and layout
  // -------------------------------------------------------------------------

  private declarePou(
    kind: PouKind,
    decl: FunctionDeclaration | FunctionBlockDeclaration | ProgramDeclaration,
  ) {
    const info: PouInfo = {
      index: this.pous.length,
      kind,
      name: decl.name,
      decl,
      layout: { size: 0, vars: new Map(), order: [] },
      params: [],
      code: [],
      hiddenCount: 0,
    };
    if (kind === PouKind.FUNCTION) {
      const fn = decl as FunctionDeclaration;
      const nativePragma = fn.body.find((s) => s.kind === "ExternalCodePragma");
      if (nativePragma && nativePragma.kind === "ExternalCodePragma") {
        const m = /^\s*native\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(
          nativePragma.code,
        );
        if (!m)
          this.fail(
            `Pragma {external} non supportato: ${nativePragma.code}`,
            nativePragma,
          );
        info.native = m[1]!.toUpperCase();
      }
    }
    this.pous.push(info);
    this.pouByName.set(decl.name, info);
    // Layout is computed lazily for FBs (may reference other FBs).
    if (kind !== PouKind.FUNCTION_BLOCK) this.layoutOf(info);
    else info.layout = this.fbLayout(decl.name);
    if (info.native) {
      const idx = this.natives.length;
      this.natives.push({
        name: info.native,
        params: info.params.map((p) => (p.type as ScalarT).kind),
        ret: info.ret ? (info.ret.type as ScalarT).kind : 0,
      });
      this.nativeByName.set(decl.name, idx);
    }
  }

  private fbLayout(name: string): Layout {
    const existing = this.fbLayouts.get(name);
    if (existing) return existing;
    const decl = this.fbDecls.get(name);
    if (!decl) throw new StcError(`FUNCTION_BLOCK ${name} non trovato`);
    if (decl.extends || decl.methods.length > 0) {
      this.fail(
        `FUNCTION_BLOCK ${name}: EXTENDS e metodi non ancora supportati`,
        decl,
      );
    }
    const layout: Layout = { size: 0, vars: new Map(), order: [] };
    this.fbLayouts.set(name, layout); // guards recursion
    this.fillLayout(layout, decl.varBlocks, false);
    layout.size = align(layout.size, 8);
    return layout;
  }

  private layoutOf(info: PouInfo) {
    const decl = info.decl;
    if (info.kind === PouKind.FUNCTION) {
      const fn = decl as FunctionDeclaration;
      const rt = this.resolveType(fn.returnType);
      if (rt.t !== "scalar")
        this.fail(`FUNCTION ${fn.name}: tipo di ritorno non supportato`, fn);
      const ret: VarSlot = {
        name: fn.name,
        type: rt,
        off: 0,
        section: "RETURN",
      };
      info.layout.size = 8;
      info.layout.vars.set(fn.name, ret);
      info.layout.order.push(ret);
      info.ret = ret;
      this.fillLayout(info.layout, fn.varBlocks, true);
      info.params = info.layout.order.filter((s) => s.section === "VAR_INPUT");
      for (const p of info.params) {
        if (p.type.t !== "scalar")
          this.fail(
            `FUNCTION ${fn.name}: parametro ${p.name} non elementare`,
            fn,
          );
      }
    } else {
      this.fillLayout(info.layout, decl.varBlocks, false);
    }
    info.layout.size = align(info.layout.size, 8);
  }

  private fillLayout(layout: Layout, blocks: VarBlock[], isFunction: boolean) {
    for (const b of blocks) {
      if (
        b.blockType === "VAR_IN_OUT" ||
        b.blockType === "VAR_EXTERNAL" ||
        b.blockType === "VAR_INST"
      ) {
        if (b.blockType === "VAR_EXTERNAL") continue; // resolved against globals by name
        this.fail(`${b.blockType} non ancora supportato`, b);
      }
      if (isFunction && b.blockType === "VAR_OUTPUT") {
        this.fail("VAR_OUTPUT nelle FUNCTION non ancora supportato", b);
      }
      for (const d of b.declarations) {
        for (const n of d.names) {
          const type = this.resolveType(d.type);
          const size = this.sizeOf(type);
          const off = align(layout.size, this.alignOf(type));
          layout.size = off + size;
          const slot: VarSlot = {
            name: n,
            type,
            off,
            section: b.blockType,
            ...(d.initialValue ? { init: d.initialValue } : {}),
            ...(d.address ? { address: d.address } : {}),
          };
          if (layout.vars.has(n))
            this.fail(`Variabile ${n} dichiarata due volte`, d);
          layout.vars.set(n, slot);
          layout.order.push(slot);
        }
      }
    }
  }

  private resolveType(tr: TypeReference): VT {
    if (tr.referenceKind && tr.referenceKind !== "none") {
      this.fail("Riferimenti e puntatori non ancora supportati", tr);
    }
    const s = scalar(tr.name);
    if (s) return s;
    if (tr.arrayDimensions && tr.elementTypeName) {
      if (tr.arrayDimensions.length !== 1)
        this.fail("Solo array a una dimensione", tr);
      const el = scalar(tr.elementTypeName);
      if (!el)
        this.fail(`Array di ${tr.elementTypeName} non ancora supportato`, tr);
      return {
        t: "array",
        elem: el,
        lo: tr.arrayDimensions[0]!.start,
        hi: tr.arrayDimensions[0]!.end,
      };
    }
    if (this.fbDecls.has(tr.name)) return { t: "fb", name: tr.name };
    this.fail(`Tipo ${tr.name} non ancora supportato`, tr);
  }

  private sizeOf(t: VT): number {
    if (t.t === "scalar") return kindSize(t.kind);
    if (t.t === "array") return kindSize(t.elem.kind) * (t.hi - t.lo + 1);
    return this.fbLayout(t.name).size;
  }
  private alignOf(t: VT): number {
    if (t.t === "scalar") return kindSize(t.kind);
    if (t.t === "array") return kindSize(t.elem.kind);
    return 8;
  }

  private allocGlobal(t: VT, layout?: Layout): number {
    const size = layout ? layout.size : this.sizeOf(t);
    const off = align(this.gSize, layout ? 8 : this.alignOf(t));
    this.gSize = off + size;
    return off;
  }

  // -------------------------------------------------------------------------
  // Initial values, symbols, located variables
  // -------------------------------------------------------------------------

  private initInstance(
    layout: Layout,
    base: number,
    prefix: string,
    isProgram: boolean,
  ) {
    for (const v of layout.order) {
      const abs = base + v.off;
      this.initSlot(v, abs);
      const name = `${prefix}.${v.name}`;
      this.symbolsFor(name, v.type, abs);
      if (v.address) {
        if (!isProgram)
          this.fail(
            `Variabile con indirizzo ${v.name} ammessa solo in PROGRAM o globali`,
          );
        this.addIo(v.address, v.type, abs);
      }
    }
  }

  private initSlot(v: VarSlot, abs: number) {
    if (v.type.t === "fb") {
      for (const f of this.fbLayout(v.type.name).order)
        this.initSlot(f, abs + f.off);
      return;
    }
    if (!v.init) return;
    if (v.type.t === "array") {
      if (v.init.kind !== "ArrayLiteralExpression")
        this.fail("Inizializzatore di array non supportato", v.init);
      const el = v.type.elem;
      const items =
        (v.init as unknown as { elements: Expression[] }).elements ?? [];
      items.forEach((e, i) =>
        this.writeData(abs + i * kindSize(el.kind), el, this.constValue(e, el)),
      );
      return;
    }
    this.writeData(abs, v.type, this.constValue(v.init, v.type));
  }

  private writeData(off: number, t: ScalarT, v: bigint | number) {
    const size = kindSize(t.kind);
    let bytes: Uint8Array;
    if (t.kind === Kind.F32)
      bytes = new Uint8Array(new Float32Array([Number(v)]).buffer);
    else if (t.kind === Kind.F64)
      bytes = new Uint8Array(new Float64Array([Number(v)]).buffer);
    else {
      let x = BigInt.asUintN(
        64,
        typeof v === "bigint" ? v : BigInt(Math.trunc(v)),
      );
      bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        bytes[i] = Number(x & 0xffn);
        x >>= 8n;
      }
    }
    for (let i = 0; i < size; i++) this.data[off + i] = bytes[i]!;
  }

  private symbolsFor(name: string, t: VT, abs: number) {
    if (t.t === "scalar")
      this.symbols.push({ name, kind: t.kind, gOff: abs, count: 1 });
    else if (t.t === "array")
      this.symbols.push({
        name,
        kind: t.elem.kind,
        gOff: abs,
        count: t.hi - t.lo + 1,
      });
    else {
      const l = this.fbLayout(t.name);
      for (const v of l.order)
        this.symbolsFor(`${name}.${v.name}`, v.type, abs + v.off);
    }
  }

  private addIo(address: string, t: VT, abs: number) {
    const m = /^%([IQM])([XBWDL])?(\d+)(?:\.(\d+))?$/.exec(
      address.toUpperCase(),
    );
    if (!m) this.fail(`Indirizzo non valido: ${address}`);
    if (t.t !== "scalar")
      this.fail(`Indirizzo ${address}: solo variabili elementari`);
    const area = { I: IoArea.I, Q: IoArea.Q, M: IoArea.M }[
      m[1] as "I" | "Q" | "M"
    ];
    const sz = m[2] ?? "X";
    const size = {
      X: IoSize.X,
      B: IoSize.B,
      W: IoSize.W,
      D: IoSize.D,
      L: IoSize.L,
    }[sz as "X"];
    this.io.push({
      area,
      size,
      byte: Number(m[3]),
      bit: m[4] ? Number(m[4]) : 0,
      kind: t.kind,
      gOff: abs,
    });
  }

  /** Evaluate a constant initializer. */
  private constValue(e: Expression, t: ScalarT): bigint | number {
    if (e.kind === "ParenthesizedExpression")
      return this.constValue(e.expression, t);
    if (e.kind === "UnaryExpression" && e.operator === "-") {
      const v = this.constValue(e.operand, t);
      return typeof v === "bigint" ? -v : -v;
    }
    if (e.kind === "LiteralExpression") {
      switch (e.literalType) {
        case "BOOL":
          return e.value ? 1n : 0n;
        case "TIME":
          return parseTimeLiteral(String(e.rawValue));
        case "REAL":
          return isFloat(t)
            ? Number(e.value)
            : BigInt(Math.trunc(Number(e.value)));
        case "INT": {
          const raw = String(e.rawValue).replace(/^[A-Z_]+#(?=[0-9+-])/i, "");
          const v =
            exactIntegerLiteralValue(raw) ??
            BigInt(Math.trunc(Number(e.value)));
          return isFloat(t) ? Number(v) : v;
        }
      }
    }
    this.fail("Valore iniziale non costante non ancora supportato", e);
  }

  // -------------------------------------------------------------------------
  // POU code
  // -------------------------------------------------------------------------

  private genPou(p: PouInfo) {
    this.cur = p;
    this.code = new Code();
    this.loopExits = [];
    this.returnJumps = [];
    // FUNCTION prologue: locals with initial values (frame is zeroed by the VM).
    if (p.kind === PouKind.FUNCTION) {
      for (const v of p.layout.order) {
        if (v.section === "VAR" || v.section === "VAR_TEMP") {
          if (v.init && v.type.t === "scalar") {
            this.pushConst(v.type, this.constValue(v.init, v.type));
            this.store(v.type, Base.F, v.off);
          }
        }
      }
    }
    this.genStatements(p.decl.body);
    const end = this.code.pc;
    for (const j of this.returnJumps) this.code.patch(j, end);
    this.code.op(Op.RET);
    p.code = this.code.bytes;
  }

  private genStatements(list: Statement[]) {
    for (const s of list) this.genStatement(s);
  }

  private genStatement(s: Statement) {
    this.lines.push({
      pou: this.cur.index,
      pc: this.code.pc,
      line: s.sourceSpan?.startLine ?? 0,
      col: s.sourceSpan?.startCol ?? 0,
    });
    switch (s.kind) {
      case "AssignmentStatement":
        return this.genAssign(s.target, s.value);
      case "IfStatement": {
        const ends: number[] = [];
        const clauses = [
          { cond: s.condition, body: s.thenStatements },
          ...s.elsifClauses.map((c) => ({
            cond: c.condition,
            body: c.statements,
          })),
        ];
        for (const c of clauses) {
          this.genExpr(c.cond, T_BOOL);
          const jz = this.code.jump(Op.JZ);
          this.genStatements(c.body);
          ends.push(this.code.jump(Op.JMP));
          this.code.patch(jz, this.code.pc);
        }
        this.genStatements(s.elseStatements);
        for (const e of ends) this.code.patch(e, this.code.pc);
        return;
      }
      case "CaseStatement": {
        const selT = this.typeOf(s.selector);
        if (!selT || isFloat(selT))
          this.fail("CASE: selettore intero richiesto", s);
        const tmp = this.hiddenSlot();
        this.genExpr(s.selector, T_LINT);
        this.store(T_LINT, tmp.base, tmp.off);
        const ends: number[] = [];
        for (const el of s.cases) {
          const bodyJumps: number[] = [];
          for (const lab of el.labels) {
            this.load(T_LINT, tmp.base, tmp.off);
            if (lab.end) {
              // lo <= sel <= hi
              this.genExpr(lab.start, T_LINT);
              this.code.op(Op.GEI);
              const jz = this.code.jump(Op.JZ);
              this.load(T_LINT, tmp.base, tmp.off);
              this.genExpr(lab.end, T_LINT);
              this.code.op(Op.LEI);
              bodyJumps.push(this.code.jump(Op.JNZ));
              this.code.patch(jz, this.code.pc);
            } else {
              this.genExpr(lab.start, T_LINT);
              this.code.op(Op.EQI);
              bodyJumps.push(this.code.jump(Op.JNZ));
            }
          }
          const skip = this.code.jump(Op.JMP);
          for (const j of bodyJumps) this.code.patch(j, this.code.pc);
          this.genStatements(el.statements);
          ends.push(this.code.jump(Op.JMP));
          this.code.patch(skip, this.code.pc);
        }
        this.genStatements(s.elseStatements);
        for (const e of ends) this.code.patch(e, this.code.pc);
        return;
      }
      case "ForStatement": {
        const ctl = this.resolveVar(s.controlVariable, s);
        if (ctl.type.t !== "scalar" || isFloat(ctl.type))
          this.fail("FOR: variabile intera richiesta", s);
        const ct = ctl.type;
        this.genExpr(s.start, ct);
        this.store(ct, ctl.base, ctl.off);
        let descending = false;
        if (s.step) {
          const sv = this.literalInt(s.step);
          descending = sv !== undefined && sv < 0n;
        }
        const top = this.code.pc;
        this.load(ct, ctl.base, ctl.off);
        this.genExpr(s.end, ct);
        this.code.op(descending ? Op.GEI : Op.LEI);
        const exit = this.code.jump(Op.JZ);
        this.loopExits.push([]);
        this.genStatements(s.body);
        this.load(ct, ctl.base, ctl.off);
        if (s.step) this.genExpr(s.step, ct);
        else (this.code.op(Op.PUSHI), this.code.i64(1n));
        this.code.op(Op.ADDI);
        this.store(ct, ctl.base, ctl.off);
        this.code.jumpTo(Op.JMP, top);
        this.code.patch(exit, this.code.pc);
        for (const j of this.loopExits.pop()!) this.code.patch(j, this.code.pc);
        return;
      }
      case "WhileStatement": {
        const top = this.code.pc;
        this.genExpr(s.condition, T_BOOL);
        const exit = this.code.jump(Op.JZ);
        this.loopExits.push([]);
        this.genStatements(s.body);
        this.code.jumpTo(Op.JMP, top);
        this.code.patch(exit, this.code.pc);
        for (const j of this.loopExits.pop()!) this.code.patch(j, this.code.pc);
        return;
      }
      case "RepeatStatement": {
        const top = this.code.pc;
        this.loopExits.push([]);
        this.genStatements(s.body);
        this.genExpr(s.condition, T_BOOL);
        this.code.jumpTo(Op.JZ, top);
        for (const j of this.loopExits.pop()!) this.code.patch(j, this.code.pc);
        return;
      }
      case "ExitStatement": {
        const top = this.loopExits[this.loopExits.length - 1];
        if (!top) this.fail("EXIT fuori da un ciclo", s);
        top.push(this.code.jump(Op.JMP));
        return;
      }
      case "ReturnStatement":
        this.returnJumps.push(this.code.jump(Op.JMP));
        return;
      case "FunctionCallStatement": {
        if (s.call.kind !== "FunctionCallExpression")
          this.fail("Chiamata di metodo non ancora supportata", s);
        const call = s.call;
        if (this.isFbInstance(call.functionName)) {
          this.genFbCall(call);
        } else {
          const t = this.genCall(call);
          if (t) this.code.op(Op.POP);
        }
        return;
      }
      case "ExternalCodePragma":
        return; // native FUNCTION bodies are not generated
      default:
        this.fail(`Istruzione ${s.kind} non ancora supportata`, s);
    }
  }

  // -------------------------------------------------------------------------
  // Variables
  // -------------------------------------------------------------------------

  private hiddenSlot(): Place {
    // Hidden 8-byte temporary in the current frame/instance.
    const l = this.cur.layout;
    const name = `__TMP${this.cur.hiddenCount++}`;
    const off = align(l.size, 8);
    l.size = off + 8;
    const slot: VarSlot = { name, type: T_LINT, off, section: "VAR_TEMP" };
    l.vars.set(name, slot);
    if (this.cur.kind !== PouKind.FUNCTION) {
      // instance size grew: only allowed before data allocation; use frame-less
      // functions only. Instances: fall back to a dedicated global slot.
      l.vars.delete(name);
      l.size = off;
      const g = this.allocGlobal(T_LINT);
      this.data.push(
        ...new Array<number>(Math.max(0, this.gSize - this.data.length)).fill(
          0,
        ),
      );
      return { base: Base.G, off: g, type: T_LINT };
    }
    return { base: Base.F, off, type: T_LINT };
  }

  private resolveVar(name: string, node?: unknown): Place {
    const l = this.cur.layout;
    const v = l.vars.get(name);
    if (v) {
      const base = this.cur.kind === PouKind.FUNCTION ? Base.F : Base.I;
      return { base, off: v.off, type: v.type };
    }
    const g = this.globals.vars.get(name);
    if (g) return { base: Base.G, off: g.off, type: g.type };
    this.fail(`Variabile ${name} non trovata`, node);
  }

  private isFbInstance(name: string): boolean {
    const l = this.cur.layout.vars.get(name) ?? this.globals.vars.get(name);
    return !!l && l.type.t === "fb";
  }

  /**
   * Resolve a variable expression to a place. Field accesses on FB instances
   * are folded into the offset. Returns indexed=true when an array subscript
   * needs a computed address (the address is then on the operand stack).
   */
  private genPlace(e: VariableExpression): { place: Place; indexed: boolean } {
    let p = this.resolveVar(e.name, e);
    const chain = e.accessChain ?? [
      ...e.fieldAccess.map((f) => ({ kind: "field" as const, name: f })),
      ...(e.subscripts.length
        ? [{ kind: "subscript" as const, indices: e.subscripts }]
        : []),
    ];
    let indexed = false;
    for (const step of chain) {
      if (step.kind === "field") {
        if (p.type.t !== "fb")
          this.fail(`${e.name}: accesso a campo non supportato`, e);
        const layout = this.fbLayout(p.type.name);
        const f = layout.vars.get(step.name);
        if (!f) this.fail(`${p.type.name} non ha il campo ${step.name}`, e);
        p = { base: p.base, off: p.off + f.off, type: f.type };
      } else if (step.kind === "subscript") {
        if (p.type.t !== "array" || step.indices.length !== 1)
          this.fail("Indice di array non supportato", e);
        if (indexed) this.fail("Array annidati non supportati", e);
        const at = p.type;
        this.code.op(Op.ADDR);
        this.code.u8(p.base);
        this.code.u32(p.off);
        this.genExpr(step.indices[0]!, T_LINT);
        this.code.op(Op.IDX);
        this.code.i32(at.lo);
        this.code.i32(at.hi);
        this.code.u32(kindSize(at.elem.kind));
        p = { base: Base.P, off: 0, type: at.elem };
        indexed = true;
      } else {
        this.fail("Dereferenziazione non supportata", e);
      }
    }
    return { place: p, indexed };
  }

  private load(t: ScalarT, base: Base, off: number) {
    this.code.op(Op.LD);
    this.code.u8(t.kind);
    this.code.u8(base);
    this.code.u32(off);
  }
  private store(t: ScalarT, base: Base, off: number) {
    this.code.op(Op.ST);
    this.code.u8(t.kind);
    this.code.u8(base);
    this.code.u32(off);
  }

  private genAssign(target: Expression, value: Expression) {
    if (target.kind !== "VariableExpression")
      this.fail("Destinazione di assegnamento non supportata", target);
    const { place } = this.genPlace(target);
    if (place.type.t !== "scalar")
      this.fail("Assegnamento di array o FB non ancora supportato", target);
    const t = place.type;
    this.genExpr(value, t);
    this.store(t, place.base, place.off);
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private literalInt(e: Expression): bigint | undefined {
    if (e.kind === "LiteralExpression" && e.literalType === "INT")
      return BigInt(Math.trunc(Number(e.value)));
    if (e.kind === "UnaryExpression" && e.operator === "-") {
      const v = this.literalInt(e.operand);
      return v === undefined ? undefined : -v;
    }
    if (e.kind === "ParenthesizedExpression")
      return this.literalInt(e.expression);
    return undefined;
  }

  /** Static type of an expression; undefined for untyped literals. */
  private typeOf(e: Expression): ScalarT | undefined {
    switch (e.kind) {
      case "LiteralExpression":
        if (e.literalType === "BOOL") return T_BOOL;
        if (e.literalType === "TIME") return T_TIME;
        if (e.typePrefix) return scalar(e.typePrefix.toUpperCase());
        return undefined;
      case "ParenthesizedExpression":
        return this.typeOf(e.expression);
      case "VariableExpression": {
        const p = this.peekPlace(e);
        return p && p.t === "scalar" ? p : undefined;
      }
      case "UnaryExpression":
        return e.operator === "NOT"
          ? (this.typeOf(e.operand) ?? T_BOOL)
          : this.typeOf(e.operand);
      case "BinaryExpression": {
        if (["=", "<>", "<", ">", "<=", ">="].includes(e.operator))
          return T_BOOL;
        const a = this.typeOf(e.left);
        const b = this.typeOf(e.right);
        if (e.operator === "**")
          return a && a.kind === Kind.F64
            ? T_LREAL
            : b && b.kind === Kind.F64
              ? T_LREAL
              : scalar("REAL");
        return this.common(a, b);
      }
      case "FunctionCallExpression":
        return this.callType(e);
      default: {
        const rt = (e as { resolvedType?: { typeKind: string; name?: string } })
          .resolvedType;
        return rt && rt.typeKind === "elementary" && rt.name
          ? scalar(rt.name)
          : undefined;
      }
    }
  }

  private peekPlace(e: VariableExpression): VT | undefined {
    const v = this.cur.layout.vars.get(e.name) ?? this.globals.vars.get(e.name);
    if (!v) {
      // enum or constant from the front-end: fall back to resolvedType
      return undefined;
    }
    let t: VT = v.type;
    const chain = e.accessChain ?? [
      ...e.fieldAccess.map((f) => ({ kind: "field" as const, name: f })),
      ...(e.subscripts.length
        ? [{ kind: "subscript" as const, indices: e.subscripts }]
        : []),
    ];
    for (const step of chain) {
      if (step.kind === "field" && t.t === "fb") {
        const f = this.fbLayout(t.name).vars.get(step.name);
        if (!f) return undefined;
        t = f.type;
      } else if (step.kind === "subscript" && t.t === "array") {
        t = t.elem;
      } else return undefined;
    }
    return t;
  }

  private common(a?: ScalarT, b?: ScalarT): ScalarT | undefined {
    if (!a) return b;
    if (!b) return a;
    if (isFloat(a) || isFloat(b)) {
      return a.kind === Kind.F64 || b.kind === Kind.F64
        ? T_LREAL
        : isFloat(a)
          ? a
          : b;
    }
    return kindSize(a.kind) >= kindSize(b.kind) ? a : b;
  }

  private pushConst(t: ScalarT, v: bigint | number) {
    if (isFloat(t)) {
      this.code.op(Op.PUSHF);
      this.code.f64(t.kind === Kind.F32 ? Math.fround(Number(v)) : Number(v));
    } else {
      this.code.op(Op.PUSHI);
      this.code.i64(typeof v === "bigint" ? v : BigInt(Math.trunc(v)));
    }
  }

  /** Convert the value on top of the stack from `from` to `to`. */
  private convert(from: ScalarT, to: ScalarT) {
    if (isFloat(to)) {
      if (!isFloat(from))
        this.code.op(from.kind === Kind.U64 ? Op.U2F : Op.I2F);
      if (to.kind === Kind.F32 && from.kind !== Kind.F32) this.code.op(Op.F32R);
      return;
    }
    if (isFloat(from)) {
      this.code.op(Op.F2IR);
    }
    if (isBool(to) && !isBool(from)) {
      this.code.op(Op.PUSHI);
      this.code.i64(0n);
      this.code.op(Op.NEI);
      return;
    }
    if (
      kindSize(to.kind) < 8 &&
      (kindSize(to.kind) < kindSize(from.kind) ||
        isUnsigned(to) !== isUnsigned(from) ||
        isFloat(from))
    ) {
      this.code.op(Op.TRUNC);
      this.code.u8(to.kind);
    }
  }

  /**
   * Generate an expression, leaving its value on the operand stack converted
   * to `want` when given. Returns the type of the value left on the stack.
   */
  private genExpr(e: Expression, want?: ScalarT): ScalarT {
    const t = this.genExprRaw(e, want);
    if (want && t.kind !== want.kind) {
      this.convert(t, want);
      return want;
    }
    return t;
  }

  private genExprRaw(e: Expression, want?: ScalarT): ScalarT {
    switch (e.kind) {
      case "ParenthesizedExpression":
        return this.genExprRaw(e.expression, want);
      case "LiteralExpression": {
        if (e.literalType === "STRING" || e.literalType === "WSTRING")
          this.fail("STRING non ancora supportato", e);
        let t: ScalarT;
        if (e.literalType === "BOOL") t = T_BOOL;
        else if (e.literalType === "TIME") t = T_TIME;
        else if (e.typePrefix && scalar(e.typePrefix.toUpperCase()))
          t = scalar(e.typePrefix.toUpperCase())!;
        else if (e.literalType === "REAL")
          t = want && isFloat(want) ? want : T_LREAL;
        else t = want ?? T_LINT;
        this.pushConst(t, this.constValue(e, t));
        return t;
      }
      case "VariableExpression": {
        const v =
          this.cur.layout.vars.get(e.name) ?? this.globals.vars.get(e.name);
        if (!v) {
          // Enum value or global constant resolved by the front-end.
          this.fail(`Variabile ${e.name} non trovata`, e);
        }
        const { place } = this.genPlace(e);
        if (place.type.t !== "scalar")
          this.fail(`${e.name}: valore non elementare in un'espressione`, e);
        this.load(place.type, place.base, place.off);
        return place.type;
      }
      case "UnaryExpression": {
        if (e.operator === "NOT") {
          const t = this.genExpr(
            e.operand,
            this.typeOf(e.operand) ?? want ?? T_BOOL,
          );
          if (isBool(t)) this.code.op(Op.NOTB);
          else {
            this.code.op(Op.NOTI);
            if (kindSize(t.kind) < 8) {
              this.code.op(Op.TRUNC);
              this.code.u8(t.kind);
            }
          }
          return t;
        }
        const t = this.genExpr(e.operand, this.typeOf(e.operand) ?? want);
        if (e.operator === "-") {
          this.code.op(isFloat(t) ? Op.NEGF : Op.NEGI);
          this.wrap(t);
        }
        return t;
      }
      case "BinaryExpression":
        return this.genBinary(e.operator, e.left, e.right, want);
      case "FunctionCallExpression": {
        if (this.isFbInstance(e.functionName))
          this.fail("Chiamata di FB dentro un'espressione", e);
        const t = this.genCall(e, want);
        if (!t) this.fail(`${e.functionName} non restituisce un valore`, e);
        return t;
      }
      default:
        this.fail(`Espressione ${e.kind} non ancora supportata`, e);
    }
  }

  /** Wrap an integer result to the width of its type (C++ semantics). */
  private wrap(t: ScalarT) {
    if (t.kind === Kind.F32) this.code.op(Op.F32R);
    else if (!isFloat(t) && kindSize(t.kind) < 8) {
      // C++ promotes 8/16-bit operands to int: wrap only at 32 bits.
      this.code.op(Op.TRUNC);
      this.code.u8(
        isUnsigned(t) && kindSize(t.kind) === 4 ? Kind.U32 : Kind.I32,
      );
    }
  }

  private genBinary(
    op: string,
    l: Expression,
    r: Expression,
    want?: ScalarT,
  ): ScalarT {
    const cmp: Record<string, [Op, Op, Op]> = {
      "=": [Op.EQI, Op.EQI, Op.EQF],
      "<>": [Op.NEI, Op.NEI, Op.NEF],
      "<": [Op.LTI, Op.LTU, Op.LTF],
      "<=": [Op.LEI, Op.LEU, Op.LEF],
      ">": [Op.GTI, Op.GTU, Op.GTF],
      ">=": [Op.GEI, Op.GEU, Op.GEF],
    };
    if (cmp[op]) {
      const t = this.common(this.typeOf(l), this.typeOf(r)) ?? T_LINT;
      this.genExpr(l, t);
      this.genExpr(r, t);
      const [si, ui, f] = cmp[op];
      this.code.op(isFloat(t) ? f : t.kind === Kind.U64 ? ui : si);
      return T_BOOL;
    }
    if (op === "AND" || op === "OR" || op === "XOR") {
      const t = this.common(this.typeOf(l), this.typeOf(r)) ?? want ?? T_BOOL;
      this.genExpr(l, t);
      this.genExpr(r, t);
      this.code.op(op === "AND" ? Op.AND : op === "OR" ? Op.OR : Op.XOR);
      return t;
    }
    if (op === "**") {
      const t =
        this.typeOf(l)?.kind === Kind.F64 || this.typeOf(r)?.kind === Kind.F64
          ? T_LREAL
          : scalar("REAL")!;
      this.genExpr(l, T_LREAL);
      this.genExpr(r, T_LREAL);
      this.code.op(Op.MATH);
      this.code.u8(MathFn.POW);
      if (t.kind === Kind.F32) this.code.op(Op.F32R);
      return t;
    }
    const t = this.common(this.typeOf(l), this.typeOf(r)) ?? want ?? T_LINT;
    this.genExpr(l, t);
    this.genExpr(r, t);
    const f = isFloat(t);
    const u = t.kind === Kind.U64;
    switch (op) {
      case "+":
        this.code.op(f ? Op.ADDF : Op.ADDI);
        break;
      case "-":
        this.code.op(f ? Op.SUBF : Op.SUBI);
        break;
      case "*":
        this.code.op(f ? Op.MULF : Op.MULI);
        break;
      case "/":
        this.code.op(f ? Op.DIVF : u ? Op.DIVU : Op.DIVI);
        break;
      case "MOD":
        if (f) this.fail("MOD su reali", l);
        this.code.op(u ? Op.MODU : Op.MODI);
        break;
      default:
        this.fail(`Operatore ${op} non supportato`, l);
    }
    this.wrap(t);
    return t;
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private callType(e: FunctionCallExpression): ScalarT | undefined {
    const name = e.functionName;
    const user = this.fnDecls.get(name);
    if (user) {
      const rt = this.resolveType(user.returnType);
      return rt.t === "scalar" ? rt : undefined;
    }
    const conv = /^([A-Z_]+)_TO_([A-Z_]+)$/.exec(name);
    if (conv && scalar(conv[2]!)) return scalar(conv[2]!);
    const argT = e.arguments[0] ? this.typeOf(e.arguments[0].value) : undefined;
    switch (name) {
      case "ABS":
      case "MIN":
      case "MAX":
      case "MOVE":
        return this.common(
          argT,
          e.arguments[1] ? this.typeOf(e.arguments[1].value) : undefined,
        );
      case "LIMIT":
        return e.arguments[1] ? this.typeOf(e.arguments[1].value) : undefined;
      case "SEL":
        return e.arguments[1]
          ? this.common(
              this.typeOf(e.arguments[1].value),
              e.arguments[2] ? this.typeOf(e.arguments[2].value) : undefined,
            )
          : undefined;
      case "SQRT":
      case "LN":
      case "LOG":
      case "EXP":
      case "SIN":
      case "COS":
      case "TAN":
      case "ASIN":
      case "ACOS":
      case "ATAN":
      case "EXPT":
        return argT && argT.kind === Kind.F64 ? T_LREAL : scalar("REAL");
      case "TRUNC":
        return scalar("DINT");
      case "SHL":
      case "SHR":
        return argT;
    }
    const rt = (e as { resolvedType?: { typeKind: string; name?: string } })
      .resolvedType;
    return rt && rt.typeKind === "elementary" && rt.name
      ? scalar(rt.name)
      : undefined;
  }

  /** Generate a FUNCTION call (user, native or standard). */
  private genCall(
    e: FunctionCallExpression,
    want?: ScalarT,
  ): ScalarT | undefined {
    const name = e.functionName;
    const pou = this.pouByName.get(name);
    if (pou && pou.kind === PouKind.FUNCTION) {
      const args = this.orderArgs(e, pou.params);
      args.forEach((a, i) => {
        const pt = pou.params[i]!.type as ScalarT;
        if (a) this.genExpr(a, pt);
        else if (pou.params[i]!.init)
          this.pushConst(pt, this.constValue(pou.params[i]!.init, pt));
        else this.pushConst(pt, isFloat(pt) ? 0 : 0n);
      });
      if (pou.native) {
        this.code.op(Op.NATIVE);
        this.code.u16(this.nativeByName.get(name)!);
      } else {
        this.code.op(Op.CALL);
        this.code.u16(pou.index);
      }
      return pou.ret ? (pou.ret.type as ScalarT) : undefined;
    }
    return this.genStdCall(e, want);
  }

  private orderArgs(
    e: FunctionCallExpression,
    params: VarSlot[],
  ): Array<Expression | undefined> {
    const out: Array<Expression | undefined> = params.map(() => undefined);
    let pos = 0;
    for (const a of e.arguments) {
      if (a.isOutput)
        this.fail("Parametri di uscita nelle FUNCTION non supportati", a);
      if (a.name) {
        const i = params.findIndex((p) => p.name === a.name);
        if (i < 0)
          this.fail(`${e.functionName} non ha il parametro ${a.name}`, a);
        out[i] = a.value;
      } else {
        if (pos >= params.length)
          this.fail(`${e.functionName}: troppi argomenti`, a);
        out[pos++] = a.value;
      }
    }
    return out;
  }

  private genStdCall(
    e: FunctionCallExpression,
    want?: ScalarT,
  ): ScalarT | undefined {
    const name = e.functionName;
    const args = e.arguments.map((a) => a.value);
    const conv = /^([A-Z_]+)_TO_([A-Z_]+)$/.exec(name);
    if (conv && scalar(conv[2]!)) {
      const from = scalar(conv[1]!) ?? this.typeOf(args[0]!) ?? T_LINT;
      const to = scalar(conv[2]!)!;
      this.genExpr(args[0]!, from);
      this.convert(from, to);
      return to;
    }
    const math: Record<string, MathFn> = {
      SQRT: MathFn.SQRT,
      LN: MathFn.LN,
      LOG: MathFn.LOG,
      EXP: MathFn.EXP,
      SIN: MathFn.SIN,
      COS: MathFn.COS,
      TAN: MathFn.TAN,
      ASIN: MathFn.ASIN,
      ACOS: MathFn.ACOS,
      ATAN: MathFn.ATAN,
    };
    const rt = this.callType(e) ?? want ?? T_LINT;
    if (math[name] !== undefined) {
      this.genExpr(args[0]!, T_LREAL);
      this.code.op(Op.MATH);
      this.code.u8(math[name]);
      if (rt.kind === Kind.F32) this.code.op(Op.F32R);
      return rt;
    }
    switch (name) {
      case "EXPT":
        this.genExpr(args[0]!, T_LREAL);
        this.genExpr(args[1]!, T_LREAL);
        this.code.op(Op.MATH);
        this.code.u8(MathFn.POW);
        if (rt.kind === Kind.F32) this.code.op(Op.F32R);
        return rt;
      case "ABS":
        this.genExpr(args[0]!, rt);
        if (isFloat(rt)) {
          this.code.op(Op.MATH);
          this.code.u8(MathFn.ABS);
        } else this.code.op(Op.ABSI);
        this.wrap(rt);
        return rt;
      case "MOVE":
        return this.genExpr(args[0]!, rt);
      case "MIN":
      case "MAX": {
        this.genExpr(args[0]!, rt);
        for (let i = 1; i < args.length; i++) {
          this.genExpr(args[i]!, rt);
          const f = isFloat(rt);
          const u = rt.kind === Kind.U64;
          this.code.op(
            name === "MIN"
              ? f
                ? Op.MINF
                : u
                  ? Op.MINU
                  : Op.MINI
              : f
                ? Op.MAXF
                : u
                  ? Op.MAXU
                  : Op.MAXI,
          );
        }
        return rt;
      }
      case "LIMIT": {
        // LIMIT(MN, IN, MX) = MIN(MAX(IN, MN), MX)
        const f = isFloat(rt);
        const u = rt.kind === Kind.U64;
        this.genExpr(args[1]!, rt);
        this.genExpr(args[0]!, rt);
        this.code.op(f ? Op.MAXF : u ? Op.MAXU : Op.MAXI);
        this.genExpr(args[2]!, rt);
        this.code.op(f ? Op.MINF : u ? Op.MINU : Op.MINI);
        return rt;
      }
      case "SEL":
        this.genExpr(args[0]!, T_BOOL);
        this.genExpr(args[1]!, rt);
        this.genExpr(args[2]!, rt);
        this.code.op(Op.SEL);
        return rt;
      case "TRUNC":
        this.genExpr(args[0]!, T_LREAL);
        this.code.op(Op.F2I);
        this.code.op(Op.TRUNC);
        this.code.u8(Kind.I32);
        return scalar("DINT")!;
      case "SHL":
      case "SHR": {
        const t = this.typeOf(args[0]!) ?? rt;
        this.genExpr(args[0]!, t);
        this.genExpr(args[1]!, T_LINT);
        this.code.op(name === "SHL" ? Op.SHL : Op.SHR);
        if (kindSize(t.kind) < 8) {
          this.code.op(Op.TRUNC);
          this.code.u8(t.kind);
        }
        return t;
      }
    }
    this.fail(`Funzione ${name} non ancora supportata`, e);
  }

  /** FB call: inputs written into the instance, CALLFB, outputs read back. */
  private genFbCall(e: FunctionCallExpression) {
    const inst = this.resolveVar(e.functionName, e);
    const fbName = (inst.type as FbT).name;
    const layout = this.fbLayout(fbName);
    const pou = this.pouByName.get(fbName)!;
    const inputs = layout.order.filter((v) => v.section === "VAR_INPUT");
    let pos = 0;
    const outs: Array<{ field: VarSlot; target: Expression }> = [];
    for (const a of e.arguments) {
      let field: VarSlot | undefined;
      if (a.name) field = layout.vars.get(a.name);
      else field = inputs[pos++];
      if (!field)
        this.fail(`${fbName}: parametro ${a.name ?? pos} non trovato`, a);
      if (a.isOutput) {
        outs.push({ field: field, target: a.value });
        continue;
      }
      if (field.type.t !== "scalar")
        this.fail(`${fbName}.${field.name}: parametro non elementare`, a);
      const ft = field.type;
      this.genExpr(a.value, ft);
      this.store(ft, inst.base, inst.off + field.off);
    }
    this.code.op(Op.ADDR);
    this.code.u8(inst.base);
    this.code.u32(inst.off);
    this.code.op(Op.CALLFB);
    this.code.u16(pou.index);
    for (const o of outs) {
      if (o.target.kind !== "VariableExpression")
        this.fail("Uscita di FB verso un'espressione", o.target);
      const { place } = this.genPlace(o.target);
      const ft = o.field.type as ScalarT;
      // place may be indexed (address on stack): load the output after it.
      this.load(ft, inst.base, inst.off + o.field.off);
      this.store(place.type as ScalarT, place.base, place.off);
    }
  }

  private fail(message: string, node?: unknown): never {
    const span = (
      node as
        | { sourceSpan?: { startLine: number; startCol: number; file: string } }
        | undefined
    )?.sourceSpan;
    throw new StcError(
      message,
      span?.startLine ?? 0,
      span?.startCol ?? 0,
      span?.file ?? "",
    );
  }
}
