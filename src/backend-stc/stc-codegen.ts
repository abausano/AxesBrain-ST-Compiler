// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
//
// Additional permission under GNU GPL version 3 section 7:
// the output of this back-end (.stc files), including any part of this file
// copied into it, may be distributed under terms of your choice.
/**
 * AxesBrain .stc back-end (format 0.2).
 *
 * Reads the analyzed CompilationUnit produced by the STruC++ front-end and
 * emits bytecode for the AxesBrain virtual machine (docs/AXESBRAIN_STC.md).
 *
 * Memory model: every POU has a frame on the call stack (FUNCTION parameters
 * and locals, VAR_TEMP of FB and PROGRAM, hidden temporaries) initialised from
 * a per-POU image at each call; FB and PROGRAM instances live in the global
 * segment (or in a FUNCTION frame). Aggregates (STRING, STRUCT, ARRAY) are
 * passed by address; a STRING address points at its first character.
 */

import type {
  ArrayDefinition,
  CompilationUnit,
  EnumDefinition,
  Expression,
  FunctionBlockDeclaration,
  FunctionCallExpression,
  FunctionDeclaration,
  ProgramDeclaration,
  Statement,
  StructDefinition,
  TypeDeclaration,
  TypeReference,
  VarBlock,
  VarDeclaration,
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
  RET_ADDR,
  StrFn,
  STR_HEADER,
  SYM_STRING,
} from "./stc-format.js";
import { exactIntegerLiteralValue } from "../literal-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScalarT {
  t: "scalar";
  /** IEC name, enum name, or POINTER for pointers. */
  name: string;
  kind: Kind;
  /** Pointed-to type for POINTER TO / REF_TO / REFERENCE_TO. */
  to?: VT;
  /** REFERENCE_TO: dereferenced implicitly on access. */
  implicit?: boolean;
}
export interface StringT {
  t: "string";
  len: number;
}
export interface Dim {
  lo: number;
  hi: number;
}
export interface ArrayT {
  t: "array";
  elem: VT;
  dims: Dim[];
}
export interface StructT {
  t: "struct";
  name: string;
  layout: Layout;
}
export interface FbT {
  t: "fb";
  name: string;
}
export type VT = ScalarT | StringT | ArrayT | StructT | FbT;

const ELEMENTARY: Record<string, Kind> = {
  BOOL: Kind.U8,
  BYTE: Kind.U8,
  USINT: Kind.U8,
  CHAR: Kind.U8,
  SINT: Kind.I8,
  WORD: Kind.U16,
  UINT: Kind.U16,
  INT: Kind.I16,
  WCHAR: Kind.U16,
  DWORD: Kind.U32,
  UDINT: Kind.U32,
  DINT: Kind.I32,
  LINT: Kind.I64,
  TIME: Kind.I64,
  LTIME: Kind.I64,
  DATE: Kind.I64,
  LDATE: Kind.I64,
  TIME_OF_DAY: Kind.I64,
  TOD: Kind.I64,
  LTOD: Kind.I64,
  LTIME_OF_DAY: Kind.I64,
  DATE_AND_TIME: Kind.I64,
  DT: Kind.I64,
  LDT: Kind.I64,
  LDATE_AND_TIME: Kind.I64,
  LWORD: Kind.U64,
  ULINT: Kind.U64,
  REAL: Kind.F32,
  LREAL: Kind.F64,
};

/** Canonical names, so TOD and TIME_OF_DAY compare equal. */
const CANON: Record<string, string> = {
  TIME_OF_DAY: "TOD",
  DATE_AND_TIME: "DT",
  LTIME_OF_DAY: "LTOD",
  LDATE_AND_TIME: "LDT",
};

function scalar(name: string): ScalarT | undefined {
  const k = ELEMENTARY[name];
  return k === undefined
    ? undefined
    : { t: "scalar", name: CANON[name] ?? name, kind: k };
}
const T_BOOL = scalar("BOOL")!;
const T_DINT = scalar("DINT")!;
const T_LINT = scalar("LINT")!;
const T_UDINT = scalar("UDINT")!;
const T_ULINT = scalar("ULINT")!;
const T_REAL = scalar("REAL")!;
const T_LREAL = scalar("LREAL")!;
const T_TIME = scalar("TIME")!;
const T_INT = scalar("INT")!;
const T_STRING: StringT = { t: "string", len: 254 };
const ptrT = (to: VT, implicit = false): ScalarT => ({
  t: "scalar",
  name: "POINTER",
  kind: Kind.I64,
  to,
  ...(implicit ? { implicit } : {}),
});
const T_PTR = ptrT(scalar("BYTE")!);

const isFloat = (s: ScalarT) => s.kind === Kind.F32 || s.kind === Kind.F64;
const isUnsigned = (s: ScalarT) =>
  s.kind === Kind.U8 ||
  s.kind === Kind.U16 ||
  s.kind === Kind.U32 ||
  s.kind === Kind.U64;
const isBool = (s: ScalarT) => s.name === "BOOL";
const isScalar = (t: VT | undefined): t is ScalarT => t?.t === "scalar";
const TEMPORAL = new Set([
  "TIME",
  "LTIME",
  "DATE",
  "LDATE",
  "TOD",
  "LTOD",
  "DT",
  "LDT",
]);

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
  section: string; // VAR, VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR_TEMP, RETURN, HIDDEN
  init?: Expression;
  address?: string;
  /** The slot holds the address of the variable (VAR_IN_OUT, REFERENCE_TO). */
  indirect?: boolean;
  constant?: boolean;
}

interface Layout {
  size: number;
  align: number;
  vars: Map<string, VarSlot>;
  order: VarSlot[];
}
const newLayout = (): Layout => ({
  size: 0,
  align: 1,
  vars: new Map(),
  order: [],
});

/** How a FUNCTION parameter is passed. */
interface Param {
  name: string;
  section: "VAR_INPUT" | "VAR_IN_OUT" | "VAR_OUTPUT";
  /** The variable as seen by the body. */
  slot: VarSlot;
  /** Hidden pointer slot for aggregate inputs and outputs. */
  ptr?: VarSlot;
  /** What the caller pushes: a value of this kind, or an address (I64). */
  kind: Kind;
  byAddress: boolean;
}

interface PouInfo {
  index: number;
  kind: PouKind;
  name: string;
  decl: FunctionDeclaration | FunctionBlockDeclaration | ProgramDeclaration;
  inst: Layout; // FB / PROGRAM instance
  frame: Layout; // call frame
  params: Param[]; // FUNCTION parameters in declaration order
  ret?: VarSlot;
  retKind: number;
  code: number[];
  frameInit: number[];
  native?: string;
  hidden: number;
  laidOut: boolean;
}

/** A place in memory. Base P: its address is on the operand stack. */
interface Place {
  base: Base;
  off: number;
  type: VT;
}
interface BitPlace {
  bit: number;
  inner: Place;
}
const isBitPlace = (p: Place | BitPlace): p is BitPlace => "bit" in p;

const align = (n: number, a: number) => Math.ceil(n / a) * a;

type CV = bigint | number | Uint8Array;

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

const DAY_NS = 86400n * 1_000_000_000n;

function daysFromCivil(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** D#2020-01-02 -> days since 1970-01-01 (STruC++ stores DATE in days). */
export function parseDateLiteral(raw: string): bigint {
  const m = /(\d+)-(\d+)-(\d+)\s*$/.exec(raw.replace(/_/g, ""));
  if (!m) throw new StcError(`Letterale di data non valido: ${raw}`);
  return BigInt(daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3])));
}

/** TOD#12:30:15.5 -> ns since midnight. */
export function parseTodLiteral(raw: string): bigint {
  const m = /(\d+):(\d+)(?::(\d+(?:\.\d+)?))?\s*$/.exec(raw.replace(/_/g, ""));
  if (!m) throw new StcError(`Letterale di ora non valido: ${raw}`);
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  return BigInt(Math.round(s * 1e9));
}

/** DT#2020-01-02-03:04:05 -> ns since 1970-01-01. */
export function parseDtLiteral(raw: string): bigint {
  const m = /(\d+)-(\d+)-(\d+)-(\d+):(\d+)(?::(\d+(?:\.\d+)?))?\s*$/.exec(
    raw.replace(/_/g, ""),
  );
  if (!m) throw new StcError(`Letterale di data e ora non valido: ${raw}`);
  const days = BigInt(daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3])));
  const s = Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6] ?? 0);
  return days * DAY_NS + BigInt(Math.round(s * 1e9));
}

/** Decode the body of an IEC string literal ('...' with $ escapes) to bytes. */
export function decodeStringLiteral(raw: string): Uint8Array {
  let inner = raw;
  const q = inner.indexOf("'");
  if (q >= 0) inner = inner.slice(q + 1, inner.lastIndexOf("'"));
  const out: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "$" && i + 1 < inner.length) {
      const n = inner[i + 1]!.toUpperCase();
      const simple: Record<string, number> = {
        N: 10,
        L: 10,
        R: 13,
        T: 9,
        P: 12,
        $: 36,
        "'": 39,
      };
      if (simple[n] !== undefined) {
        out.push(simple[n]);
        i++;
        continue;
      }
      const hex = inner.substring(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      out.push(36);
      continue;
    }
    if (ch === "'" && inner[i + 1] === "'") {
      out.push(39);
      i++;
      continue;
    }
    out.push(...enc.encode(ch));
  }
  return Uint8Array.from(out);
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
  ret?: { kind: number; off: number };
  frameInit: number[];
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
  /** Value kind, or SYM_STRING. */
  kind: number;
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
  /** Named constants supplied outside the sources (-D, library constants). */
  globalConstants?: Record<string, number>;
  /** Compile only the POUs reachable from the programs (default true). */
  onlyReachable?: boolean;
}

interface EnumValue {
  type: ScalarT;
  value: bigint;
}

export class StcGenerator {
  private fbDecls = new Map<string, FunctionBlockDeclaration>();
  private fnDecls = new Map<string, FunctionDeclaration>();
  private typeDecls = new Map<string, TypeDeclaration>();
  private typeCache = new Map<string, VT>();
  private enumByMember = new Map<string, EnumValue>();
  private enumQualified = new Map<string, EnumValue>();
  private pous: PouInfo[] = [];
  private pouByName = new Map<string, PouInfo>();
  private natives: StcNative[] = [];
  private nativeByName = new Map<string, number>();
  private globals: Layout = newLayout();
  private constants = new Map<string, CV>();
  private gSize = 0;
  private data: number[] = [];
  private strConsts = new Map<string, number>();
  private lines: StcLine[] = [];
  private symbols: StcSymbol[] = [];
  private io: StcIo[] = [];
  private tasks: StcTask[] = [];
  /** Errors found while generating code (one per POU at most). */
  readonly errors: StcError[] = [];

  // per-POU state
  private cur!: PouInfo;
  private code!: Code;
  private loopExits: number[][] = [];
  private returnJumps: number[] = [];

  constructor(private options: StcOptions = {}) {}

  generate(ast: CompilationUnit): StcModule {
    for (const [k, v] of Object.entries(this.options.globalConstants ?? {}))
      this.constants.set(k.toUpperCase(), BigInt(Math.trunc(v)));
    for (const t of ast.types) this.typeDecls.set(t.name, t);
    for (const t of ast.types)
      if (t.definition.kind === "EnumDefinition") this.resolveNamed(t.name, t);
    for (const f of ast.functionBlocks) this.fbDecls.set(f.name, f);
    for (const f of ast.functions) this.fnDecls.set(f.name, f);

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
          const slot = this.addVar(this.globals, n, type, "VAR_GLOBAL", d);
          if (b.isConstant) {
            slot.constant = true;
            if (d.initialValue) {
              const v = this.tryConst(d.initialValue);
              if (v !== undefined) this.constants.set(n, v);
            }
          }
        }
      }
    }
    this.gSize = this.globals.size;

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
      this.layoutPou(pou);
      const off = align(this.gSize, 8);
      this.gSize = off + pou.inst.size;
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
    this.ensureData(this.gSize);
    for (const g of this.globals.order) {
      this.writeInit(this.data, g.off, g.type, g.init);
      this.symbolsFor(g.name, g.type, g.off);
      if (g.address) this.addIo(g.address, g.type, g.off);
    }
    for (const i of instOffsets) {
      this.writeInstInit(this.data, i.pou.inst, i.off);
      for (const v of i.pou.inst.order) {
        if (v.indirect) continue;
        const abs = i.off + v.off;
        this.symbolsFor(`${i.name}.${v.name}`, v.type, abs);
        if (v.address) this.addIo(v.address, v.type, abs);
      }
    }

    // Code: only POUs reachable from the program instances.
    const reachable = this.reachablePous(
      instOffsets.map((i) => i.pou),
      this.options.onlyReachable !== false,
    );
    // Errors are collected POU by POU so that one compile reports them all.
    for (const p of this.pous) {
      if (!reachable.has(p)) continue;
      const nLines = this.lines.length;
      try {
        this.layoutPou(p);
        if (!p.native) this.genPou(p);
      } catch (e) {
        if (!(e instanceof StcError)) throw e;
        this.lines.length = nLines;
        p.code = [];
        if (!e.line) {
          e.line = p.decl.sourceSpan?.startLine ?? 0;
          e.column = p.decl.sourceSpan?.startCol ?? 0;
          e.file = p.decl.sourceSpan?.file ?? "";
        }
        e.message = `${p.name}: ${e.message}`;
        this.errors.push(e);
      }
    }

    return {
      data: Uint8Array.from(this.data),
      pous: this.pous.map((p) => ({
        kind: p.kind,
        name: p.name,
        code: p.code,
        frameSize: p.laidOut ? align(p.frame.size, 8) : 0,
        instSize: p.laidOut && p.kind !== PouKind.FUNCTION ? p.inst.size : 0,
        params: p.params.map((s) => ({
          kind: s.kind,
          off: s.byAddress ? (s.ptr?.off ?? s.slot.off) : s.slot.off,
        })),
        ...(p.ret && p.retKind
          ? { ret: { kind: p.retKind, off: p.ret.off } }
          : {}),
        frameInit: p.frameInit,
      })),
      tasks: this.tasks,
      io: this.io,
      natives: this.natives,
      symbols: this.symbols,
      lines: this.lines,
    };
  }

  /** POUs referenced (by type or call) from the given roots. */
  private reachablePous(roots: PouInfo[], filter: boolean): Set<PouInfo> {
    if (!filter) return new Set(this.pous);
    const seen = new Set<PouInfo>();
    const visit = (p: PouInfo | undefined) => {
      if (!p || seen.has(p)) return;
      seen.add(p);
      const walk = (n: unknown) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) {
          for (const x of n) walk(x);
          return;
        }
        const o = n as Record<string, unknown>;
        if (o.kind === "FunctionCallExpression")
          visit(this.pouByName.get(String(o.functionName)));
        if (o.kind === "TypeReference") {
          visit(this.pouByName.get(String(o.name)));
          if (o.elementTypeName)
            visit(this.pouByName.get(String(o.elementTypeName)));
          this.visitTypeDecl(String(o.name), visit, new Set());
          if (o.elementTypeName)
            this.visitTypeDecl(String(o.elementTypeName), visit, new Set());
        }
        for (const [k, v] of Object.entries(o)) {
          if (k === "parent" || k === "sourceSpan" || k === "resolvedType")
            continue;
          if (v && typeof v === "object") walk(v);
        }
      };
      walk(p.decl.varBlocks);
      walk(p.decl.body);
    };
    for (const r of roots) visit(r);
    // FB instances inside global variables
    for (const g of this.globals.order) this.visitType(g.type, visit);
    return seen;
  }

  private visitTypeDecl(
    name: string,
    visit: (p: PouInfo | undefined) => void,
    guard: Set<string>,
  ) {
    const td = this.typeDecls.get(name);
    if (!td || guard.has(name)) return;
    guard.add(name);
    const refs: TypeReference[] = [];
    const def = td.definition;
    if (def.kind === "StructDefinition")
      for (const f of def.fields) refs.push(f.type);
    else if (def.kind === "ArrayDefinition") refs.push(def.elementType);
    else if (def.kind === "TypeReference") refs.push(def);
    for (const r of refs) {
      visit(this.pouByName.get(r.name));
      if (r.elementTypeName) visit(this.pouByName.get(r.elementTypeName));
      this.visitTypeDecl(r.name, visit, guard);
    }
  }

  private visitType(t: VT, visit: (p: PouInfo | undefined) => void) {
    if (t.t === "fb") visit(this.pouByName.get(t.name));
    else if (t.t === "array") this.visitType(t.elem, visit);
    else if (t.t === "struct")
      for (const f of t.layout.order) this.visitType(f.type, visit);
  }

  // -------------------------------------------------------------------------
  // Types
  // -------------------------------------------------------------------------

  private resolveType(tr: TypeReference): VT {
    const chain: string[] =
      tr.referenceChain ??
      (tr.referenceKind && tr.referenceKind !== "none"
        ? [tr.referenceKind]
        : []);
    let base: VT;
    if (tr.arrayDimensions && tr.elementTypeName) {
      let elem = this.resolveNamed(tr.elementTypeName, tr);
      const ec = tr.elementReferenceChain ?? [];
      for (let i = ec.length - 1; i >= 0; i--)
        elem = ptrT(elem, ec[i] === "reference_to");
      base = {
        t: "array",
        elem,
        dims: tr.arrayDimensions.map((d) => ({ lo: d.start, hi: d.end })),
      };
    } else if (tr.name.startsWith("__VLA_")) {
      this.fail("ARRAY[*] non ancora supportato", tr);
    } else if (tr.name === "STRING") {
      base = { t: "string", len: this.stringLen(tr) };
    } else {
      base = this.resolveNamed(tr.name, tr);
    }
    for (let i = chain.length - 1; i >= 0; i--)
      base = ptrT(base, chain[i] === "reference_to");
    return base;
  }

  private stringLen(tr: TypeReference): number {
    if (tr.maxLength === undefined) return 254;
    if (typeof tr.maxLength === "number") return tr.maxLength;
    const v = this.constants.get(tr.maxLength.toUpperCase());
    if (typeof v === "bigint") return Number(v);
    this.fail(`Lunghezza di STRING non costante: ${tr.maxLength}`, tr);
  }

  private resolveNamed(name: string, node?: unknown): VT {
    const s = scalar(name);
    if (s) return s;
    if (name === "STRING") return T_STRING;
    if (name === "WSTRING") this.fail("WSTRING non ancora supportato", node);
    const cached = this.typeCache.get(name);
    if (cached) return cached;
    if (this.fbDecls.has(name)) return { t: "fb", name };
    const td = this.typeDecls.get(name);
    if (!td) this.fail(`Tipo ${name} non trovato`, node);
    const def = td.definition;
    switch (def.kind) {
      case "StructDefinition": {
        const st: StructT = { t: "struct", name, layout: newLayout() };
        this.typeCache.set(name, st);
        this.fillStruct(st, def);
        if (td.defaultValue)
          this.fail("Valore predefinito di STRUCT non supportato", td);
        return st;
      }
      case "EnumDefinition":
        return this.resolveEnum(name, def);
      case "ArrayDefinition": {
        const t = this.resolveArrayDef(def);
        this.typeCache.set(name, t);
        return t;
      }
      case "SubrangeDefinition": {
        const t = this.resolveType(def.baseType);
        this.typeCache.set(name, t);
        return t;
      }
      case "TypeReference": {
        const t = this.resolveType(def);
        this.typeCache.set(name, t);
        return t;
      }
    }
    this.fail(`Tipo ${name} non supportato`, node);
  }

  private resolveEnum(name: string, def: EnumDefinition): ScalarT {
    const baseT = def.baseType ? this.resolveType(def.baseType) : T_INT;
    if (!isScalar(baseT))
      this.fail(`Enumerazione ${name}: tipo base non valido`, def);
    const t: ScalarT = { t: "scalar", name, kind: baseT.kind };
    this.typeCache.set(name, t);
    let next = 0n;
    for (const m of def.members) {
      if (m.value) {
        const v = this.tryConst(m.value);
        if (typeof v !== "bigint")
          this.fail(`Valore di ${name}.${m.name} non costante`, m);
        next = v;
      }
      const ev = { type: t, value: next };
      if (!this.enumByMember.has(m.name)) this.enumByMember.set(m.name, ev);
      this.enumQualified.set(`${name}#${m.name}`, ev);
      next += 1n;
    }
    return t;
  }

  private enumDefault(t: ScalarT): bigint | undefined {
    const td = this.typeDecls.get(t.name);
    if (!td || td.definition.kind !== "EnumDefinition") return undefined;
    const def = td.definition;
    const first = def.defaultValue ?? def.members[0]?.name;
    return first
      ? this.enumQualified.get(`${t.name}#${first}`)?.value
      : undefined;
  }

  private resolveArrayDef(def: ArrayDefinition): ArrayT {
    const dims: Dim[] = def.dimensions.map((d) => {
      if (d.isVariableLength || !d.start || !d.end)
        this.fail("ARRAY[*] non ancora supportato", d);
      const lo = this.tryConst(d.start);
      const hi = this.tryConst(d.end);
      if (typeof lo !== "bigint" || typeof hi !== "bigint")
        this.fail("Limiti di array non costanti", d);
      return { lo: Number(lo), hi: Number(hi) };
    });
    return { t: "array", elem: this.resolveType(def.elementType), dims };
  }

  private fillStruct(st: StructT, def: StructDefinition) {
    for (const f of def.fields)
      for (const n of f.names)
        this.addVar(st.layout, n, this.resolveType(f.type), "FIELD", f);
    st.layout.size = align(st.layout.size, st.layout.align);
  }

  private count(t: ArrayT): number {
    return t.dims.reduce((a, d) => a * (d.hi - d.lo + 1), 1);
  }

  private sizeOf(t: VT): number {
    switch (t.t) {
      case "scalar":
        return kindSize(t.kind);
      case "string":
        return align(STR_HEADER + t.len + 1, 2);
      case "array":
        return this.sizeOf(t.elem) * this.count(t);
      case "struct":
        return t.layout.size;
      case "fb": {
        const p = this.pouByName.get(t.name)!;
        this.layoutPou(p);
        return p.inst.size;
      }
    }
  }
  private alignOf(t: VT): number {
    switch (t.t) {
      case "scalar":
        return kindSize(t.kind);
      case "string":
        return 2;
      case "array":
        return this.alignOf(t.elem);
      case "struct":
        return t.layout.align;
      case "fb":
        return 8;
    }
  }
  /** Bytes before the variable's address (STRING header). */
  private leadOf(t: VT): number {
    if (t.t === "string") return STR_HEADER;
    if (t.t === "array") return this.leadOf(t.elem);
    return 0;
  }

  private addVar(
    layout: Layout,
    name: string,
    type: VT,
    section: string,
    d?: VarDeclaration,
    indirect = false,
  ): VarSlot {
    const a = indirect ? 8 : this.alignOf(type);
    const start = align(layout.size, a);
    const lead = indirect ? 0 : this.leadOf(type);
    const slot: VarSlot = {
      name,
      type,
      off: start + lead,
      section,
      ...(d?.initialValue ? { init: d.initialValue } : {}),
      ...(d?.address ? { address: d.address } : {}),
      ...(indirect ? { indirect } : {}),
    };
    layout.size = start + (indirect ? 8 : this.sizeOf(type));
    layout.align = Math.max(layout.align, a);
    if (layout.vars.has(name))
      this.fail(`Variabile ${name} dichiarata due volte`, d);
    layout.vars.set(name, slot);
    layout.order.push(slot);
    return slot;
  }

  // -------------------------------------------------------------------------
  // POU declarations and layout
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
      inst: newLayout(),
      frame: newLayout(),
      params: [],
      retKind: 0,
      code: [],
      frameInit: [],
      hidden: 0,
      laidOut: false,
    };
    if (kind === PouKind.FUNCTION) {
      const fn = decl as FunctionDeclaration;
      const nativePragma = fn.body.find((s) => s.kind === "ExternalCodePragma");
      if (nativePragma && nativePragma.kind === "ExternalCodePragma") {
        const m = /^\s*native\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(
          nativePragma.code,
        );
        if (m) info.native = m[1]!.toUpperCase();
      }
    }
    this.pous.push(info);
    this.pouByName.set(decl.name, info);
  }

  private layouting = new Set<PouInfo>();

  private layoutPou(info: PouInfo) {
    if (info.laidOut) return;
    if (this.layouting.has(info))
      this.fail(`${info.name}: istanza ricorsiva di se stesso`, info.decl);
    this.layouting.add(info);
    const decl = info.decl;
    if (info.kind === PouKind.FUNCTION) {
      const fn = decl as FunctionDeclaration;
      const f = info.frame;
      if (fn.returnType && fn.returnType.name !== "VOID") {
        const rt = this.resolveType(fn.returnType);
        if (isScalar(rt)) {
          const ret: VarSlot = {
            name: fn.name,
            type: rt,
            off: 0,
            section: "RETURN",
          };
          f.size = 8;
          f.align = 8;
          f.vars.set(fn.name, ret);
          f.order.push(ret);
          info.ret = ret;
          info.retKind = rt.kind;
        } else {
          info.ret = this.addVar(f, fn.name, rt, "RETURN");
          info.retKind = RET_ADDR;
        }
      }
      for (const b of fn.varBlocks) {
        for (const d of b.declarations) {
          for (const n of d.names) {
            const t = this.resolveType(d.type);
            switch (b.blockType) {
              case "VAR_INPUT": {
                if (isScalar(t)) {
                  const slot = this.addVar(f, n, t, b.blockType, d);
                  info.params.push({
                    name: n,
                    section: "VAR_INPUT",
                    slot,
                    kind: t.kind,
                    byAddress: false,
                  });
                } else {
                  const slot = this.addVar(f, n, t, b.blockType, d);
                  const ptr = this.addVar(f, `__P_${n}`, ptrT(t), "HIDDEN");
                  info.params.push({
                    name: n,
                    section: "VAR_INPUT",
                    slot,
                    ptr,
                    kind: Kind.I64,
                    byAddress: true,
                  });
                }
                break;
              }
              case "VAR_IN_OUT": {
                const slot = this.addVar(f, n, t, b.blockType, d, true);
                info.params.push({
                  name: n,
                  section: "VAR_IN_OUT",
                  slot,
                  kind: Kind.I64,
                  byAddress: true,
                });
                break;
              }
              case "VAR_OUTPUT": {
                const slot = this.addVar(f, n, t, b.blockType, d);
                const ptr = this.addVar(f, `__O_${n}`, ptrT(t), "HIDDEN");
                info.params.push({
                  name: n,
                  section: "VAR_OUTPUT",
                  slot,
                  ptr,
                  kind: Kind.I64,
                  byAddress: true,
                });
                break;
              }
              case "VAR":
              case "VAR_TEMP":
                this.addVar(f, n, t, b.blockType, d);
                break;
              case "VAR_EXTERNAL":
                break;
              default:
                this.fail(`${b.blockType} non supportato in una FUNCTION`, b);
            }
            if (b.isConstant && d.initialValue) {
              const v = this.tryConst(d.initialValue);
              if (v !== undefined) f.vars.get(n)!.constant = true;
            }
          }
        }
      }
    } else {
      const fb = decl as FunctionBlockDeclaration;
      if (
        info.kind === PouKind.FUNCTION_BLOCK &&
        (fb.extends || fb.methods?.length)
      ) {
        this.fail(
          `FUNCTION_BLOCK ${info.name}: EXTENDS e metodi non ancora supportati`,
          decl,
        );
      }
      for (const b of decl.varBlocks) {
        for (const d of b.declarations) {
          for (const n of d.names) {
            const t = this.resolveType(d.type);
            switch (b.blockType) {
              case "VAR_TEMP":
                this.addVar(info.frame, n, t, b.blockType, d);
                break;
              case "VAR_IN_OUT":
                this.addVar(info.inst, n, t, b.blockType, d, true);
                break;
              case "VAR_EXTERNAL":
                break;
              case "VAR_INST":
                this.fail("VAR_INST non supportato", b);
                break;
              default:
                this.addVar(info.inst, n, t, b.blockType, d);
            }
          }
        }
      }
      info.inst.size = align(info.inst.size, 8);
    }
    if (info.native) {
      const idx = this.natives.length;
      this.natives.push({
        name: info.native,
        params: info.params.map((p) => p.kind),
        ret:
          info.retKind && info.retKind !== RET_ADDR
            ? (info.retKind as Kind)
            : 0,
      });
      this.nativeByName.set(decl.name, idx);
    }
    info.laidOut = true;
    this.layouting.delete(info);
  }

  // -------------------------------------------------------------------------
  // Constants and initial values
  // -------------------------------------------------------------------------

  /** Evaluate a constant expression; undefined when it is not constant. */
  private tryConst(e: Expression, want?: VT): CV | undefined {
    switch (e.kind) {
      case "ParenthesizedExpression":
        return this.tryConst(e.expression, want);
      case "LiteralExpression":
        return this.literalValue(e, want);
      case "UnaryExpression": {
        const v = this.tryConst(e.operand, want);
        if (v === undefined || v instanceof Uint8Array) return undefined;
        if (e.operator === "-") return typeof v === "bigint" ? -v : -v;
        if (e.operator === "+") return v;
        if (e.operator === "NOT" && typeof v === "bigint") {
          if (isScalar(want) && isBool(want)) return v ? 0n : 1n;
          return ~v;
        }
        return undefined;
      }
      case "BinaryExpression": {
        const a = this.tryConst(e.left, want);
        const b = this.tryConst(e.right, want);
        if (a === undefined || b === undefined) return undefined;
        if (a instanceof Uint8Array || b instanceof Uint8Array)
          return undefined;
        if (typeof a === "bigint" && typeof b === "bigint") {
          switch (e.operator) {
            case "+":
              return a + b;
            case "-":
              return a - b;
            case "*":
              return a * b;
            case "/":
              return b === 0n ? undefined : a / b;
            case "MOD":
              return b === 0n ? undefined : a % b;
            case "AND":
              return a & b;
            case "OR":
              return a | b;
            case "XOR":
              return a ^ b;
          }
          return undefined;
        }
        const x = Number(a);
        const y = Number(b);
        switch (e.operator) {
          case "+":
            return x + y;
          case "-":
            return x - y;
          case "*":
            return x * y;
          case "/":
            return x / y;
          case "**":
            return Math.pow(x, y);
        }
        return undefined;
      }
      case "VariableExpression": {
        if (e.typedLiteral && e.fieldAccess.length === 1)
          return this.enumQualified.get(`${e.name}#${e.fieldAccess[0]}`)?.value;
        if (e.fieldAccess.length || e.subscripts.length || e.isDereference)
          return undefined;
        const c = this.constants.get(e.name);
        if (c !== undefined) return c;
        return this.enumByMember.get(e.name)?.value;
      }
      case "FunctionCallExpression": {
        const conv = /^(?:([A-Z_]+)_)?TO_([A-Z_]+)$/.exec(e.functionName);
        if (conv && e.arguments.length === 1) {
          const v = this.tryConst(e.arguments[0]!.value);
          const to = scalar(conv[2]!);
          if (v === undefined || !to || v instanceof Uint8Array)
            return undefined;
          if (TEMPORAL.has(to.name) || (conv[1] && TEMPORAL.has(conv[1])))
            return undefined;
          return isFloat(to)
            ? Number(v)
            : typeof v === "bigint"
              ? v
              : BigInt(Math.trunc(v));
        }
        return undefined;
      }
    }
    return undefined;
  }

  private literalValue(
    e: Extract<Expression, { kind: "LiteralExpression" }>,
    want?: VT,
  ): CV {
    switch (e.literalType) {
      case "BOOL":
        return e.value === true || String(e.value).toUpperCase() === "TRUE"
          ? 1n
          : 0n;
      case "TIME":
        return parseTimeLiteral(String(e.rawValue));
      case "DATE":
        return parseDateLiteral(String(e.rawValue));
      case "TIME_OF_DAY":
        return parseTodLiteral(String(e.rawValue));
      case "DATE_AND_TIME":
        return parseDtLiteral(String(e.rawValue));
      case "NULL":
        return 0n;
      case "STRING":
        return decodeStringLiteral(String(e.rawValue));
      case "WSTRING":
        this.fail("WSTRING non ancora supportato", e);
        break;
      case "REAL": {
        const v = Number(e.value);
        return isScalar(want) && !isFloat(want) ? BigInt(Math.trunc(v)) : v;
      }
      case "INT": {
        const raw = String(e.rawValue).replace(
          /^[A-Z_]+#(?=[0-9+-]|16#|8#|2#)/i,
          "",
        );
        const v =
          exactIntegerLiteralValue(raw) ?? BigInt(Math.trunc(Number(e.value)));
        const p = e.typePrefix ? scalar(e.typePrefix.toUpperCase()) : undefined;
        if (p && isFloat(p)) return Number(v);
        return isScalar(want) && isFloat(want) ? Number(v) : v;
      }
    }
    this.fail(`Letterale ${e.literalType} non supportato`, e);
  }

  private ensureData(n: number) {
    while (this.data.length < n) this.data.push(0);
  }

  private writeScalar(buf: number[], off: number, t: ScalarT, v: CV) {
    if (v instanceof Uint8Array)
      this.fail("Stringa assegnata a un valore elementare");
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
      if (isBool(t)) x = x ? 1n : 0n;
      bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        bytes[i] = Number(x & 0xffn);
        x >>= 8n;
      }
    }
    while (buf.length < off + size) buf.push(0);
    for (let i = 0; i < size; i++) buf[off + i] = bytes[i]!;
  }

  private writeString(
    buf: number[],
    off: number,
    cap: number,
    text?: Uint8Array,
  ) {
    while (buf.length < off + cap + 1) buf.push(0);
    buf[off - 4] = cap & 0xff;
    buf[off - 3] = cap >> 8;
    buf[off - 2] = 0;
    buf[off - 1] = 0;
    if (text) {
      const n = Math.min(text.length, cap);
      for (let i = 0; i < n; i++) buf[off + i] = text[i]!;
      buf[off + n] = 0;
    }
  }

  /** Write the initial value of a variable of type t at buf[off]. */
  private writeInit(buf: number[], off: number, t: VT, init?: Expression) {
    switch (t.t) {
      case "scalar": {
        if (!init) {
          const ed = this.enumDefault(t);
          if (ed) this.writeScalar(buf, off, t, ed);
          return;
        }
        const v = this.tryConst(init, t);
        if (v === undefined) this.fail("Valore iniziale non costante", init);
        this.writeScalar(buf, off, t, v);
        return;
      }
      case "string": {
        let text: Uint8Array | undefined;
        if (init) {
          const v = this.tryConst(init, t);
          if (!(v instanceof Uint8Array))
            this.fail("Valore iniziale di STRING non valido", init);
          text = v;
        }
        this.writeString(buf, off, t.len, text);
        return;
      }
      case "array": {
        const stride = this.sizeOf(t.elem);
        const n = this.count(t);
        let items: Expression[] = [];
        if (init) {
          if (init.kind !== "ArrayLiteralExpression")
            this.fail("Inizializzatore di array non supportato", init);
          items = init.elements;
        }
        for (let k = 0; k < n; k++)
          this.writeInit(buf, off + k * stride, t.elem, items[k]);
        return;
      }
      case "struct": {
        const over = new Map<string, Expression>();
        if (init) {
          if (init.kind !== "StructInitializerExpression")
            this.fail("Inizializzatore di STRUCT non supportato", init);
          for (const el of init.elements)
            over.set(el.name.toUpperCase(), el.value);
        }
        for (const f of t.layout.order)
          this.writeInit(buf, off + f.off, f.type, over.get(f.name) ?? f.init);
        return;
      }
      case "fb": {
        const p = this.pouByName.get(t.name)!;
        this.layoutPou(p);
        const over = new Map<string, Expression>();
        if (init) {
          if (init.kind !== "StructInitializerExpression")
            this.fail("Inizializzatore di FB non supportato", init);
          for (const el of init.elements)
            over.set(el.name.toUpperCase(), el.value);
        }
        this.writeInstInit(buf, p.inst, off, over);
        return;
      }
    }
  }

  private writeInstInit(
    buf: number[],
    l: Layout,
    base: number,
    over?: Map<string, Expression>,
  ) {
    while (buf.length < base + l.size) buf.push(0);
    for (const v of l.order) {
      if (v.indirect) continue;
      this.writeInit(buf, base + v.off, v.type, over?.get(v.name) ?? v.init);
    }
  }

  /** Address in the global segment of a constant string literal. */
  private stringConst(bytes: Uint8Array): number {
    const key = Array.from(bytes).join(",");
    const have = this.strConsts.get(key);
    if (have !== undefined) return have;
    const t: StringT = { t: "string", len: bytes.length };
    const start = align(this.gSize, 2);
    const off = start + STR_HEADER;
    this.gSize = start + this.sizeOf(t);
    this.ensureData(this.gSize);
    this.writeString(this.data, off, t.len, bytes);
    this.strConsts.set(key, off);
    return off;
  }

  // -------------------------------------------------------------------------
  // Symbols and located variables
  // -------------------------------------------------------------------------

  private symbolsFor(name: string, t: VT, abs: number) {
    switch (t.t) {
      case "scalar":
        this.symbols.push({ name, kind: t.kind, gOff: abs, count: 1 });
        return;
      case "string":
        this.symbols.push({ name, kind: SYM_STRING, gOff: abs, count: 1 });
        return;
      case "array": {
        const n = this.count(t);
        if (t.elem.t === "scalar") {
          this.symbols.push({ name, kind: t.elem.kind, gOff: abs, count: n });
          return;
        }
        if (t.elem.t === "string") {
          this.symbols.push({ name, kind: SYM_STRING, gOff: abs, count: n });
          return;
        }
        const stride = this.sizeOf(t.elem);
        for (let k = 0; k < n; k++) {
          // row-major index tuple
          const idx: number[] = [];
          let r = k;
          for (let d = t.dims.length - 1; d >= 0; d--) {
            const len = t.dims[d]!.hi - t.dims[d]!.lo + 1;
            idx.unshift(t.dims[d]!.lo + (r % len));
            r = Math.floor(r / len);
          }
          this.symbolsFor(
            `${name}[${idx.join(",")}]`,
            t.elem,
            abs + k * stride,
          );
        }
        return;
      }
      case "struct":
        for (const f of t.layout.order)
          this.symbolsFor(`${name}.${f.name}`, f.type, abs + f.off);
        return;
      case "fb": {
        const p = this.pouByName.get(t.name)!;
        for (const v of p.inst.order)
          if (!v.indirect)
            this.symbolsFor(`${name}.${v.name}`, v.type, abs + v.off);
        return;
      }
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

  // -------------------------------------------------------------------------
  // POU code
  // -------------------------------------------------------------------------

  private genPou(p: PouInfo) {
    this.cur = p;
    this.code = new Code();
    this.loopExits = [];
    this.returnJumps = [];
    // FUNCTION prologue: copy aggregate inputs passed by address.
    for (const prm of p.params) {
      if (prm.section !== "VAR_INPUT" || !prm.ptr) continue;
      this.load(T_LINT, Base.F, prm.ptr.off);
      const skip = this.code.jump(Op.JZ);
      this.addr(Base.F, prm.slot.off);
      this.load(T_LINT, Base.F, prm.ptr.off);
      this.copyOp(prm.slot.type);
      this.code.patch(skip, this.code.pc);
    }
    this.genStatements(p.decl.body);
    const end = this.code.pc;
    for (const j of this.returnJumps) this.code.patch(j, end);
    // FUNCTION epilogue: copy VAR_OUTPUT to the caller's variables.
    for (const prm of p.params) {
      if (prm.section !== "VAR_OUTPUT" || !prm.ptr) continue;
      this.load(T_LINT, Base.F, prm.ptr.off);
      const skip = this.code.jump(Op.JZ);
      this.load(T_LINT, Base.F, prm.ptr.off);
      if (isScalar(prm.slot.type)) {
        this.load(prm.slot.type, Base.F, prm.slot.off);
        this.store(prm.slot.type, Base.P, 0);
      } else {
        this.addr(Base.F, prm.slot.off);
        this.copyOp(prm.slot.type);
      }
      this.code.patch(skip, this.code.pc);
    }
    this.code.op(Op.RET);
    p.code = this.code.bytes;
    // Frame image: initial values of locals, temporaries and string capacities.
    const img: number[] = new Array<number>(align(p.frame.size, 8)).fill(0);
    for (const v of p.frame.order) {
      if (v.indirect || (v.section === "RETURN" && isScalar(v.type))) continue;
      if (v.section === "HIDDEN") continue;
      this.writeInit(img, v.off, v.type, v.init);
    }
    p.frameInit = img;
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
      case "RefAssignStatement": {
        const p = this.genPlaceExpr(s.target);
        if (isBitPlace(p) || !isScalar(p.type) || !p.type.to)
          this.fail("REF= richiede un riferimento", s);
        this.genAddressOf(s.source);
        this.store(p.type, p.base, p.off);
        return;
      }
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
          this.genCond(c.cond);
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
        if (selT && (!isScalar(selT) || isFloat(selT)))
          this.fail("CASE: selettore intero richiesto", s);
        const tmp = this.tempSlot(T_LINT);
        this.genExpr(s.selector, T_LINT);
        this.store(T_LINT, Base.F, tmp.off);
        const ends: number[] = [];
        for (const el of s.cases) {
          const bodyJumps: number[] = [];
          for (const lab of el.labels) {
            this.load(T_LINT, Base.F, tmp.off);
            if (lab.end) {
              this.genExpr(lab.start, T_LINT);
              this.code.op(Op.GEI);
              const jz = this.code.jump(Op.JZ);
              this.load(T_LINT, Base.F, tmp.off);
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
        const ctl = this.directPlace(s.controlVariable, s);
        if (!isScalar(ctl.type) || isFloat(ctl.type))
          this.fail("FOR: variabile intera richiesta", s);
        const ct = ctl.type;
        this.genExpr(s.start, ct);
        this.store(ct, ctl.base, ctl.off);
        let descending = false;
        if (s.step) {
          const sv = this.tryConst(s.step);
          descending = typeof sv === "bigint" && sv < 0n;
        }
        const top = this.code.pc;
        const cmpT = this.common(ct, this.typeOf(s.end)) ?? ct;
        this.loadConv(ctl, cmpT);
        this.genExpr(s.end, cmpT);
        this.code.op(
          isUnsigned(cmpT) && cmpT.kind === Kind.U64
            ? descending
              ? Op.GEU
              : Op.LEU
            : descending
              ? Op.GEI
              : Op.LEI,
        );
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
        this.genCond(s.condition);
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
        this.genCond(s.condition);
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
        if (this.isFbCall(call)) {
          this.genFbCall(call);
        } else {
          const t = this.genCallAny(call);
          if (t === "value") this.code.op(Op.POP);
        }
        return;
      }
      case "ExternalCodePragma":
        if (this.cur.native) return;
        this.fail(
          "Pragma {external} con codice C++ non eseguibile nella VM",
          s,
        );
        break;
      default:
        this.fail(`Istruzione ${s.kind} non ancora supportata`, s);
    }
  }

  /** Generate a condition: BOOL value (non-zero = true) on the stack. */
  private genCond(e: Expression) {
    this.genExpr(e, T_BOOL);
  }

  // -------------------------------------------------------------------------
  // Variables and places
  // -------------------------------------------------------------------------

  private tempSlot(t: VT): VarSlot {
    const name = `__T${this.cur.hidden++}`;
    return this.addVar(this.cur.frame, name, t, "VAR_TEMP");
  }

  private findVar(name: string): { slot: VarSlot; base: Base } | undefined {
    const f = this.cur.frame.vars.get(name);
    if (f) return { slot: f, base: Base.F };
    const i = this.cur.inst.vars.get(name);
    if (i) return { slot: i, base: Base.I };
    const g = this.globals.vars.get(name);
    if (g) return { slot: g, base: Base.G };
    return undefined;
  }

  /** A variable that must not need a computed address (FOR control variable). */
  private directPlace(name: string, node: unknown): Place {
    const v = this.findVar(name);
    if (!v || v.slot.indirect) this.fail(`Variabile ${name} non trovata`, node);
    return { base: v.base, off: v.slot.off, type: v.slot.type };
  }

  private accessChain(e: VariableExpression) {
    return (
      e.accessChain ?? [
        ...e.fieldAccess.map((f) => ({ kind: "field" as const, name: f })),
        ...(e.subscripts.length
          ? [{ kind: "subscript" as const, indices: e.subscripts }]
          : []),
        ...(e.isDereference ? [{ kind: "dereference" as const }] : []),
      ]
    );
  }

  /** Push the absolute address of a place. */
  private pushAddr(p: Place) {
    if (p.base === Base.P) {
      if (p.off) {
        this.code.op(Op.PUSHI);
        this.code.i64(BigInt(p.off));
        this.code.op(Op.ADDI);
      }
    } else this.addr(p.base, p.off);
  }

  private deref(p: Place): Place {
    const t = p.type as ScalarT;
    this.load(T_LINT, p.base, p.off);
    return { base: Base.P, off: 0, type: t.to! };
  }

  /** Resolve an lvalue expression to a place, emitting address code if needed. */
  private genPlaceExpr(e: Expression): Place | BitPlace {
    if (e.kind === "VariableExpression") return this.genPlace(e);
    if (e.kind === "ParenthesizedExpression")
      return this.genPlaceExpr(e.expression);
    if (e.kind === "DrefExpression") {
      const t = this.typeOf(e.operand);
      if (!isScalar(t) || !t.to)
        this.fail("DREF di un valore che non è un riferimento", e);
      this.genExpr(e.operand);
      return { base: Base.P, off: 0, type: t.to };
    }
    this.fail("Espressione non assegnabile", e);
  }

  private genPlace(e: VariableExpression): Place | BitPlace {
    const v = this.findVar(e.name);
    if (!v) this.fail(`Variabile ${e.name} non trovata`, e);
    let p: Place = { base: v.base, off: v.slot.off, type: v.slot.type };
    if (v.slot.indirect) p = this.derefSlot(p);
    for (const step of this.accessChain(e)) {
      if (isScalar(p.type) && p.type.implicit && step.kind !== "dereference")
        p = this.deref(p);
      if (step.kind === "field") {
        const t = p.type;
        if (t.t === "struct" || t.t === "fb") {
          const l = t.t === "struct" ? t.layout : this.fbInst(t.name);
          const f = l.vars.get(step.name);
          if (!f) this.fail(`${t.name} non ha il campo ${step.name}`, e);
          p = { base: p.base, off: p.off + f.off, type: f.type };
          if (f.indirect) p = this.derefSlot(p);
        } else if (t.t === "scalar" && /^\d+$/.test(step.name) && !isFloat(t)) {
          return { bit: Number(step.name), inner: p };
        } else
          this.fail(`${e.name}: accesso al campo ${step.name} non valido`, e);
      } else if (step.kind === "subscript") {
        this.pushAddr(p);
        let t = p.type;
        let d = 0;
        for (const ix of step.indices) {
          if (t.t !== "array")
            this.fail(`${e.name}: indice su un valore che non è un array`, e);
          const dim = t.dims[d]!;
          let stride = this.sizeOf(t.elem);
          for (let k = d + 1; k < t.dims.length; k++)
            stride *= t.dims[k]!.hi - t.dims[k]!.lo + 1;
          this.genExpr(ix, T_LINT);
          this.code.op(Op.IDX);
          this.code.i32(dim.lo);
          this.code.i32(dim.hi);
          this.code.u32(stride);
          d++;
          if (d === t.dims.length) {
            t = t.elem;
            d = 0;
          }
        }
        if (d !== 0) this.fail(`${e.name}: numero di indici errato`, e);
        p = { base: Base.P, off: 0, type: t };
      } else {
        if (!isScalar(p.type) || !p.type.to)
          this.fail(`${e.name}: ^ su un valore che non è un puntatore`, e);
        p = this.deref(p);
      }
    }
    if (isScalar(p.type) && p.type.implicit) p = this.deref(p);
    return p;
  }

  private derefSlot(p: Place): Place {
    this.load(T_LINT, p.base, p.off);
    return { base: Base.P, off: 0, type: p.type };
  }

  private fbInst(name: string): Layout {
    const p = this.pouByName.get(name)!;
    this.layoutPou(p);
    return p.inst;
  }

  /** Static type of a variable expression, without emitting code. */
  private varType(e: VariableExpression): VT | undefined {
    const v = this.findVar(e.name);
    if (!v) {
      if (e.typedLiteral && e.fieldAccess.length === 1)
        return this.enumQualified.get(`${e.name}#${e.fieldAccess[0]}`)?.type;
      return (
        this.enumByMember.get(e.name)?.type ??
        (this.constants.has(e.name) ? undefined : undefined)
      );
    }
    let t: VT = v.slot.type;
    for (const step of this.accessChain(e)) {
      if (isScalar(t) && t.implicit && step.kind !== "dereference") t = t.to!;
      if (step.kind === "field") {
        if (t.t === "struct" || t.t === "fb") {
          const l = t.t === "struct" ? t.layout : this.fbInst(t.name);
          const f = l.vars.get(step.name);
          if (!f) return undefined;
          t = f.type;
        } else if (t.t === "scalar" && /^\d+$/.test(step.name)) return T_BOOL;
        else return undefined;
      } else if (step.kind === "subscript") {
        let d = 0;
        for (let i = 0; i < step.indices.length; i++) {
          if (t.t !== "array") return undefined;
          d++;
          if (d === t.dims.length) {
            t = t.elem;
            d = 0;
          }
        }
      } else {
        if (!isScalar(t) || !t.to) return undefined;
        t = t.to;
      }
    }
    if (isScalar(t) && t.implicit) t = t.to!;
    return t;
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
  private addr(base: Base, off: number) {
    this.code.op(Op.ADDR);
    this.code.u8(base);
    this.code.u32(off);
  }
  /** Copy an aggregate: stack has dst, src. */
  private copyOp(t: VT) {
    if (t.t === "string") {
      this.code.op(Op.STR);
      this.code.u8(StrFn.ASSIGN);
    } else {
      this.code.op(Op.COPY);
      this.code.u32(this.sizeOf(t));
    }
  }
  private loadConv(p: Place, want: ScalarT) {
    const t = p.type as ScalarT;
    this.load(t, p.base, p.off);
    if (t.kind !== want.kind) this.convert(t, want);
  }

  private genAssign(target: Expression, value: Expression) {
    const place = this.genPlaceExpr(target);
    if (isBitPlace(place)) return this.genBitWrite(place, value);
    const t = place.type;
    if (t.t === "scalar") {
      this.genExpr(value, t);
      this.store(t, place.base, place.off);
      return;
    }
    if (t.t === "fb")
      this.fail("Assegnamento di istanze di FB non supportato", target);
    this.pushAddr(place);
    if (t.t === "string") this.genStrInto(value, t);
    else {
      const vt = this.typeOf(value);
      if (vt && (vt.t !== t.t || this.sizeOf(vt) !== this.sizeOf(t)))
        this.fail("Assegnamento tra tipi diversi", target);
      this.genAggSrc(value, t);
      this.copyOp(t);
    }
  }

  private genBitWrite(p: BitPlace, value: Expression) {
    const t = p.inner.type as ScalarT;
    if (p.inner.base === Base.P) this.code.op(Op.DUP);
    this.load(t, p.inner.base, p.inner.off);
    this.code.op(Op.PUSHI);
    this.code.i64(~(1n << BigInt(p.bit)));
    this.code.op(Op.AND);
    this.genExpr(value, T_BOOL);
    this.code.op(Op.PUSHI);
    this.code.i64(BigInt(p.bit));
    this.code.op(Op.SHL);
    this.code.op(Op.OR);
    this.store(t, p.inner.base, p.inner.off);
  }

  /** Push the address of an lvalue (ADR, REF, VAR_IN_OUT arguments). */
  private genAddressOf(e: Expression): VT {
    const p = this.genPlaceExpr(e);
    if (isBitPlace(p)) this.fail("Indirizzo di un bit non disponibile", e);
    this.pushAddr(p);
    return p.type;
  }

  private isLvalue(e: Expression): boolean {
    if (e.kind === "ParenthesizedExpression")
      return this.isLvalue(e.expression);
    if (e.kind === "DrefExpression") return true;
    return e.kind === "VariableExpression" && !!this.findVar(e.name);
  }

  // -------------------------------------------------------------------------
  // Strings and aggregates
  // -------------------------------------------------------------------------

  /** Push the address of a STRING value (a temporary for computed values). */
  private genStrSrc(e: Expression): StringT {
    if (e.kind === "ParenthesizedExpression")
      return this.genStrSrc(e.expression);
    if (e.kind === "LiteralExpression" && e.literalType === "STRING") {
      const b = decodeStringLiteral(String(e.rawValue));
      this.addr(Base.G, this.stringConst(b));
      return { t: "string", len: b.length };
    }
    if (this.isLvalue(e)) {
      const t = this.genAddressOf(e);
      if (t.t !== "string") this.fail("STRING richiesta", e);
      return t;
    }
    const t = this.typeOf(e);
    const st: StringT = t && t.t === "string" ? t : T_STRING;
    const tmp = this.tempSlot({ t: "string", len: Math.max(st.len, 254) });
    this.addr(Base.F, tmp.off);
    this.genStrInto(e, tmp.type as StringT);
    this.addr(Base.F, tmp.off);
    return tmp.type as StringT;
  }

  /** Fill a STRING whose address is on the stack with the value of e. */
  private genStrInto(e: Expression, dst: StringT): void {
    if (e.kind === "ParenthesizedExpression")
      return this.genStrInto(e.expression, dst);
    if (e.kind === "FunctionCallExpression") {
      if (this.genStrCall(e)) return;
      const pou = this.pouByName.get(e.functionName);
      if (pou && pou.kind === PouKind.FUNCTION) {
        this.layoutPou(pou);
        if (!pou.ret || pou.ret.type.t !== "string")
          this.fail(`${e.functionName} non restituisce una STRING`, e);
        this.genUserCall(e, pou);
        this.str(StrFn.ASSIGN);
        return;
      }
    }
    if (
      isScalar(this.typeOf(e)) &&
      !(e.kind === "LiteralExpression" && e.literalType === "STRING")
    )
      this.fail(
        `Valore elementare assegnato a una STRING (usa ${this.typeOf(e) ? (this.typeOf(e) as ScalarT).name : "?"}_TO_STRING)`,
        e,
      );
    this.genStrSrc(e);
    this.str(StrFn.ASSIGN);
    void dst;
  }

  private str(fn: StrFn) {
    this.code.op(Op.STR);
    this.code.u8(fn);
  }

  /** Push the address of a STRUCT/ARRAY value. */
  private genAggSrc(e: Expression, want: VT) {
    if (this.isLvalue(e)) {
      this.genAddressOf(e);
      return;
    }
    if (e.kind === "FunctionCallExpression") {
      const pou = this.pouByName.get(e.functionName);
      if (pou && pou.kind === PouKind.FUNCTION) {
        this.layoutPou(pou);
        const tmp = this.tempSlot(pou.ret!.type);
        this.addr(Base.F, tmp.off);
        this.genUserCall(e, pou);
        this.copyOp(pou.ret!.type);
        this.addr(Base.F, tmp.off);
        return;
      }
    }
    void want;
    this.fail("Valore di STRUCT/ARRAY non supportato in questa posizione", e);
  }

  /**
   * Standard string functions. The destination address is already on the
   * stack. Returns false when e is not a string function.
   */
  private genStrCall(e: FunctionCallExpression): boolean {
    const name = e.functionName;
    // a FUNCTION declared in the sources wins over a standard one (OSCAT CHR_TO_STRING)
    if (this.pouByName.get(name)?.kind === PouKind.FUNCTION) return false;
    const a = e.arguments.map((x) => x.value);
    const named = (n: string, i: number) =>
      e.arguments.find((x) => x.name === n)?.value ??
      (e.arguments[i] && !e.arguments[i].name ? a[i] : undefined);
    const need = (n: string, i: number) => {
      const v = named(n, i);
      if (!v) this.fail(`${name}: manca il parametro ${n}`, e);
      return v;
    };
    switch (name) {
      case "CONCAT": {
        if (a.length < 2) this.fail("CONCAT richiede almeno due argomenti", e);
        // dst := a0 & a1, then dst := dst & ai
        this.code.op(Op.DUP);
        this.genStrSrc(a[0]!);
        this.genStrSrc(a[1]!);
        this.str(StrFn.CONCAT);
        for (let i = 2; i < a.length; i++) {
          this.code.op(Op.DUP);
          this.code.op(Op.DUP);
          this.genStrSrc(a[i]!);
          this.str(StrFn.CONCAT);
        }
        this.code.op(Op.POP);
        return true;
      }
      case "LEFT":
      case "RIGHT":
        this.genStrSrc(need("IN", 0));
        this.genExpr(need("L", 1), T_LINT);
        this.str(name === "LEFT" ? StrFn.LEFT : StrFn.RIGHT);
        return true;
      case "MID":
        this.genStrSrc(need("IN", 0));
        this.genExpr(need("L", 1), T_LINT);
        this.genExpr(need("P", 2), T_LINT);
        this.str(StrFn.MID);
        return true;
      case "INSERT":
        this.genStrSrc(need("IN1", 0));
        this.genStrSrc(need("IN2", 1));
        this.genExpr(need("P", 2), T_LINT);
        this.str(StrFn.INSERT);
        return true;
      case "DELETE":
        this.genStrSrc(need("IN", 0));
        this.genExpr(need("L", 1), T_LINT);
        this.genExpr(need("P", 2), T_LINT);
        this.str(StrFn.DELETE);
        return true;
      case "REPLACE":
        this.genStrSrc(need("IN1", 0));
        this.genStrSrc(need("IN2", 1));
        this.genExpr(need("L", 2), T_LINT);
        this.genExpr(need("P", 3), T_LINT);
        this.str(StrFn.REPLACE);
        return true;
      case "CHR":
      case "BYTE_TO_CHAR":
        this.genExpr(a[0]!, T_LINT);
        this.str(StrFn.CHR);
        return true;
    }
    const conv = /^(?:([A-Z_]+)_)?TO_STRING$/.exec(name);
    if (conv) {
      const from = this.typeOf(a[0]!);
      if (from && from.t === "string") {
        this.genStrSrc(a[0]!);
        this.str(StrFn.ASSIGN);
        return true;
      }
      const ft =
        (conv[1] ? scalar(conv[1]) : undefined) ??
        (isScalar(from) ? from : T_LINT);
      this.genExpr(a[0]!, ft);
      if (isBool(ft)) this.str(StrFn.FROM_BOOL);
      else if (ft.name === "TIME" || ft.name === "LTIME")
        this.str(StrFn.FROM_TIME);
      else if (TEMPORAL.has(ft.name))
        this.fail(`${name} non ancora supportato`, e);
      else if (ft.kind === Kind.F32) this.str(StrFn.FROM_REAL);
      else if (ft.kind === Kind.F64) this.str(StrFn.FROM_LREAL);
      else if (ft.kind === Kind.U64) this.str(StrFn.FROM_UINT);
      else this.str(StrFn.FROM_INT);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  /** Operators written as functions (NOT(x), ADD(a, b, c), GT(a, b)) as expressions. */
  private desugar(e: FunctionCallExpression): Expression | undefined {
    const ops: Record<string, string> = {
      ADD: "+",
      SUB: "-",
      MUL: "*",
      DIV: "/",
      MOD: "MOD",
      AND: "AND",
      OR: "OR",
      XOR: "XOR",
      GT: ">",
      GE: ">=",
      EQ: "=",
      LE: "<=",
      LT: "<",
      NE: "<>",
    };
    if (this.pouByName.has(e.functionName)) return undefined;
    const a = e.arguments
      .filter((x) => x.name !== "EN" && x.name !== "ENO")
      .map((x) => x.value);
    if (e.functionName === "NOT" && a.length === 1)
      return {
        kind: "UnaryExpression",
        operator: "NOT",
        operand: a[0]!,
        sourceSpan: e.sourceSpan,
      };
    const op = ops[e.functionName];
    if (!op || a.length < 2) return undefined;
    let r: Expression = a[0]!;
    for (let i = 1; i < a.length; i++)
      r = {
        kind: "BinaryExpression",
        operator: op as "+",
        left: r,
        right: a[i]!,
        sourceSpan: e.sourceSpan,
      };
    return r;
  }

  /** Static type of an expression; undefined for untyped integer literals. */
  private typeOf(e: Expression): VT | undefined {
    if (e.kind === "FunctionCallExpression") {
      const d = this.desugar(e);
      if (d) return this.typeOf(d);
    }
    switch (e.kind) {
      case "LiteralExpression":
        switch (e.literalType) {
          case "BOOL":
            return T_BOOL;
          case "TIME":
            return T_TIME;
          case "DATE":
            return scalar("DATE");
          case "TIME_OF_DAY":
            return scalar("TOD");
          case "DATE_AND_TIME":
            return scalar("DT");
          case "STRING":
            return {
              t: "string",
              len: decodeStringLiteral(String(e.rawValue)).length,
            };
          case "NULL":
            return T_PTR;
        }
        if (e.typePrefix) return scalar(e.typePrefix.toUpperCase());
        if (e.literalType === "REAL") return T_LREAL;
        return undefined;
      case "ParenthesizedExpression":
        return this.typeOf(e.expression);
      case "VariableExpression":
        return this.varType(e);
      case "UnaryExpression":
        return e.operator === "NOT"
          ? (this.typeOf(e.operand) ?? T_BOOL)
          : this.typeOf(e.operand);
      case "BinaryExpression": {
        if (["=", "<>", "<", ">", "<=", ">="].includes(e.operator))
          return T_BOOL;
        const a = this.typeOf(e.left);
        const b = this.typeOf(e.right);
        if (e.operator === "**") return T_LREAL;
        if (!isScalar(a) && a) return undefined;
        if (!isScalar(b) && b) return undefined;
        return this.arithType(e.operator, a, b);
      }
      case "FunctionCallExpression":
        return this.callType(e);
      case "RefExpression": {
        const t = this.typeOf(e.operand);
        return t ? ptrT(t) : T_PTR;
      }
      case "DrefExpression": {
        const t = this.typeOf(e.operand);
        return isScalar(t) && t.to ? t.to : undefined;
      }
      default:
        return undefined;
    }
  }

  /** Result type of + - * / MOD AND OR XOR on scalars (C++ promotion). */
  private arithType(op: string, a?: ScalarT, b?: ScalarT): ScalarT | undefined {
    // TIME arithmetic keeps the temporal type (DT - DT -> TIME).
    if (
      a &&
      b &&
      TEMPORAL.has(a.name) &&
      TEMPORAL.has(b.name) &&
      op === "-" &&
      a.name !== "TIME"
    )
      return a.name === "DATE" ? T_TIME : T_TIME;
    if (a && TEMPORAL.has(a.name)) return a;
    if (b && TEMPORAL.has(b.name) && op !== "*" && op !== "/") return b;
    return this.common(a, b);
  }

  private common(a?: VT, b?: VT): ScalarT | undefined {
    const x = isScalar(a) ? a : undefined;
    const y = isScalar(b) ? b : undefined;
    if (!x) return y;
    if (!y) return x;
    if (x.to) return x;
    if (y.to) return y;
    if (isFloat(x) || isFloat(y)) {
      return x.kind === Kind.F64 || y.kind === Kind.F64
        ? T_LREAL
        : isFloat(x)
          ? x
          : y;
    }
    if (isBool(x) && !isBool(y)) return y;
    if (isBool(y) && !isBool(x)) return x;
    const sx = kindSize(x.kind);
    const sy = kindSize(y.kind);
    // C++: operands narrower than int are promoted to int
    if (sx < 4 && sy < 4 && x.kind !== y.kind) return T_DINT;
    if (sx !== sy) return sx > sy ? x : y;
    if (isUnsigned(x) !== isUnsigned(y)) return isUnsigned(x) ? x : y;
    return x;
  }

  private pushConst(t: ScalarT, v: CV) {
    if (v instanceof Uint8Array) this.fail("Stringa usata come numero");
    if (isFloat(t)) {
      this.code.op(Op.PUSHF);
      this.code.f64(t.kind === Kind.F32 ? Math.fround(Number(v)) : Number(v));
    } else {
      this.code.op(Op.PUSHI);
      let x = typeof v === "bigint" ? v : BigInt(Math.trunc(v));
      if (isBool(t)) x = x ? 1n : 0n;
      this.code.i64(x);
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
    if (isFloat(from)) this.code.op(Op.F2I);
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
    if (want && isBool(want) && !isBool(t)) {
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
          this.fail("STRING usata come valore numerico", e);
        let t = this.typeOf(e) as ScalarT | undefined;
        if (!t) t = want && !want.to ? want : this.defaultIntType(e);
        if (e.literalType === "REAL" && !e.typePrefix) t = T_LREAL;
        this.pushConst(t, this.tryConst(e, t)!);
        return t;
      }
      case "VariableExpression": {
        const v = this.findVar(e.name);
        if (!v) {
          const c = this.tryConst(e);
          if (c === undefined || c instanceof Uint8Array)
            this.fail(`Variabile ${e.name} non trovata`, e);
          const t = (this.varType(e) as ScalarT | undefined) ?? want ?? T_DINT;
          this.pushConst(t, c);
          return t;
        }
        const p = this.genPlace(e);
        if (isBitPlace(p)) {
          this.load(p.inner.type as ScalarT, p.inner.base, p.inner.off);
          this.code.op(Op.PUSHI);
          this.code.i64(BigInt(p.bit));
          this.code.op(Op.SHR);
          this.code.op(Op.PUSHI);
          this.code.i64(1n);
          this.code.op(Op.AND);
          return T_BOOL;
        }
        if (!isScalar(p.type))
          this.fail(`${e.name}: valore non elementare in un'espressione`, e);
        this.load(p.type, p.base, p.off);
        return p.type;
      }
      case "UnaryExpression": {
        if (e.operator === "NOT") {
          const t = this.genExpr(
            e.operand,
            (this.typeOf(e.operand) as ScalarT | undefined) ?? want ?? T_BOOL,
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
        const ot = this.typeOf(e.operand);
        const t = this.genExpr(
          e.operand,
          (isScalar(ot) ? ot : undefined) ?? want,
        );
        if (e.operator === "-") {
          this.code.op(isFloat(t) ? Op.NEGF : Op.NEGI);
          this.wrap(t);
        }
        return t;
      }
      case "BinaryExpression":
        return this.genBinary(e.operator, e.left, e.right, want);
      case "FunctionCallExpression": {
        const d = this.desugar(e);
        if (d) return this.genExprRaw(d, want);
        if (this.isFbCall(e))
          this.fail("Chiamata di FB dentro un'espressione", e);
        const r = this.genCallAny(e, want);
        if (r === "none")
          this.fail(`${e.functionName} non restituisce un valore`, e);
        return r === "value" ? (this.callType(e) as ScalarT) : r;
      }
      case "RefExpression":
        this.genAddressOf(e.operand);
        return T_PTR;
      case "DrefExpression": {
        const p = this.genPlaceExpr(e);
        if (isBitPlace(p) || !isScalar(p.type))
          this.fail("DREF non elementare", e);
        this.load(p.type, p.base, p.off);
        return p.type;
      }
      default:
        this.fail(`Espressione ${e.kind} non ancora supportata`, e);
    }
  }

  private defaultIntType(e: Expression): ScalarT {
    const v = this.tryConst(e);
    if (typeof v === "bigint" && (v > 2147483647n || v < -2147483648n))
      return v > 9223372036854775807n ? T_ULINT : T_LINT;
    return T_DINT;
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

  private isStringish(e: Expression): boolean {
    const t = this.typeOf(e);
    return !!t && t.t === "string";
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
      if (this.isStringish(l) || this.isStringish(r)) {
        this.genStrSrc(l);
        this.genStrSrc(r);
        this.str(StrFn.CMP);
        this.code.op(Op.PUSHI);
        this.code.i64(0n);
        this.code.op(cmp[op][0]);
        return T_BOOL;
      }
      const t = this.common(this.typeOf(l), this.typeOf(r)) ?? T_DINT;
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
      this.genExpr(l, T_LREAL);
      this.genExpr(r, T_LREAL);
      this.code.op(Op.MATH);
      this.code.u8(MathFn.POW);
      return T_LREAL;
    }
    const lt = this.typeOf(l);
    const rt = this.typeOf(r);
    // untyped integer literals are C++ int (or long when they do not fit)
    let t =
      this.arithType(
        op,
        lt as ScalarT | undefined,
        rt as ScalarT | undefined,
      ) ?? this.common(this.defaultIntType(l), this.defaultIntType(r))!;
    if (isBool(t)) t = T_DINT;
    // operands of a temporal operation are computed as 64-bit integers
    const opT = TEMPORAL.has(t.name) ? T_LINT : t;
    this.genExpr(l, isScalar(lt) && TEMPORAL.has(lt.name) ? lt : opT);
    this.genExpr(r, isScalar(rt) && TEMPORAL.has(rt.name) ? rt : opT);
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

  private isFbCall(e: FunctionCallExpression): boolean {
    if (e.instance) {
      const t = this.typeOf(e.instance);
      return !!t && t.t === "fb";
    }
    const v = this.findVar(e.functionName);
    return !!v && v.slot.type.t === "fb";
  }

  private callType(e: FunctionCallExpression): VT | undefined {
    const name = e.functionName;
    const user = this.pouByName.get(name);
    if (user && user.kind === PouKind.FUNCTION) {
      this.layoutPou(user);
      return user.ret?.type;
    }
    const conv = /^(?:([A-Z_]+)_)?TO_([A-Z_]+)$/.exec(name);
    if (conv) {
      if (conv[2] === "STRING") return T_STRING;
      const to = scalar(conv[2]!);
      if (to) return to;
    }
    const argT = (i: number) =>
      e.arguments[i] ? this.typeOf(e.arguments[i].value) : undefined;
    switch (name) {
      case "ABS":
      case "MOVE":
        return argT(0);
      case "MIN":
      case "MAX": {
        let t: ScalarT | undefined;
        for (let i = 0; i < e.arguments.length; i++)
          t = this.common(t, argT(i));
        return t;
      }
      case "LIMIT":
        return this.common(this.common(argT(0), argT(1)), argT(2));
      case "SEL":
        return this.common(argT(1), argT(2));
      case "MUX": {
        let t: ScalarT | undefined;
        for (let i = 1; i < e.arguments.length; i++)
          t = this.common(t, argT(i));
        const s = e.arguments[1] ? argT(1) : undefined;
        return t ?? (s && s.t === "string" ? s : undefined);
      }
      case "SQRT":
      case "LN":
      case "LOG":
      case "EXP":
      case "SIN":
      case "COS":
      case "TAN":
      case "ASIN":
      case "ACOS":
      case "ATAN": {
        const a = argT(0);
        return isScalar(a) && a.kind === Kind.F32 ? T_REAL : T_LREAL;
      }
      case "EXPT":
        return T_LREAL;
      case "TRUNC":
        return T_DINT;
      case "SHL":
      case "SHR":
      case "ROL":
      case "ROR":
        return argT(0) ?? T_DINT;
      case "LEN":
      case "FIND":
        return T_INT;
      case "LEFT":
      case "RIGHT":
      case "MID":
      case "INSERT":
      case "DELETE":
      case "REPLACE":
      case "CONCAT":
      case "CHR":
        return T_STRING;
      case "ADR":
      case "REF_LINK": {
        const t = argT(0);
        return t ? ptrT(t) : T_PTR;
      }
      case "SIZEOF":
        return T_UDINT;
      case "LOWER_BOUND":
      case "UPPER_BOUND":
        return T_DINT;
      case "ODD":
        return T_BOOL;
      case "TIME":
        return e.arguments.length ? undefined : T_TIME;
    }
    return undefined;
  }

  /**
   * Generate any FUNCTION call. Returns "value" when one scalar is left on the
   * stack (its type is callType), "none" for no result, or the scalar type.
   */
  private genCallAny(
    e: FunctionCallExpression,
    want?: ScalarT,
  ): "value" | "none" | ScalarT {
    const pou = this.pouByName.get(e.functionName);
    if (pou && pou.kind === PouKind.FUNCTION) {
      this.layoutPou(pou);
      if (pou.ret && !isScalar(pou.ret.type)) {
        // aggregate result used as a statement: evaluate into a temporary
        const tmp = this.tempSlot(pou.ret.type);
        this.addr(Base.F, tmp.off);
        this.genUserCall(e, pou);
        this.copyOp(pou.ret.type);
        return "none";
      }
      this.genUserCall(e, pou);
      return pou.ret ? "value" : "none";
    }
    const strFn = this.callType(e);
    if (strFn && strFn.t === "string") {
      // string function used as a statement: discard the result
      const tmp = this.tempSlot(T_STRING);
      this.addr(Base.F, tmp.off);
      if (!this.genStrCall(e))
        this.fail(`Funzione ${e.functionName} non supportata`, e);
      return "none";
    }
    return this.genStdCall(e, want);
  }

  private orderArgs(e: FunctionCallExpression, params: Param[]) {
    const out: Array<Expression | undefined> = params.map(() => undefined);
    let pos = 0;
    for (const a of e.arguments) {
      if (a.name === "EN" || a.name === "ENO") continue;
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

  /** Push the arguments of a user FUNCTION and call it. */
  private genUserCall(e: FunctionCallExpression, pou: PouInfo) {
    const args = this.orderArgs(e, pou.params);
    pou.params.forEach((prm, i) => {
      const a = args[i];
      const t = prm.slot.type;
      if (prm.section === "VAR_INPUT") {
        if (!prm.byAddress) {
          const pt = t as ScalarT;
          if (a) this.genExpr(a, pt);
          else if (prm.slot.init)
            this.pushConst(pt, this.tryConst(prm.slot.init, pt) ?? 0n);
          else this.pushConst(pt, isFloat(pt) ? 0 : 0n);
        } else if (!a) {
          this.pushConst(T_LINT, 0n);
        } else if (t.t === "string") {
          this.genStrSrc(a);
        } else {
          this.genAggSrc(a, t);
        }
      } else if (prm.section === "VAR_IN_OUT") {
        if (!a)
          this.fail(`${e.functionName}: manca il VAR_IN_OUT ${prm.name}`, e);
        if (this.isLvalue(a)) this.genAddressOf(a);
        else if (t.t === "string") this.genStrSrc(a);
        else this.fail(`${e.functionName}.${prm.name}: serve una variabile`, a);
      } else {
        if (!a) this.pushConst(T_LINT, 0n);
        else {
          const at = this.genAddressOf(a);
          if (isScalar(t) && isScalar(at) && at.kind !== t.kind)
            this.fail(
              `${e.functionName}.${prm.name}: tipo dell'uscita diverso`,
              a,
            );
        }
      }
    });
    if (pou.native) {
      this.code.op(Op.NATIVE);
      this.code.u16(this.nativeByName.get(pou.name)!);
    } else {
      this.code.op(Op.CALL);
      this.code.u16(pou.index);
    }
  }

  private arg(e: FunctionCallExpression, i: number, name?: string): Expression {
    const byName = name ? e.arguments.find((a) => a.name === name) : undefined;
    const a = byName ?? e.arguments.filter((x) => !x.name)[i] ?? e.arguments[i];
    if (!a) this.fail(`${e.functionName}: manca l'argomento ${i + 1}`, e);
    return a.value;
  }

  private genStdCall(e: FunctionCallExpression, want?: ScalarT): ScalarT {
    const name = e.functionName;
    const args = e.arguments
      .filter((a) => a.name !== "EN" && a.name !== "ENO")
      .map((a) => a.value);
    const conv = /^(?:([A-Z_]+)_)?TO_([A-Z_]+)$/.exec(name);
    if (conv && scalar(conv[2]!)) {
      const src = args[0]!;
      const to = scalar(conv[2]!)!;
      if (this.isStringish(src)) {
        this.genStrSrc(src);
        if (isFloat(to)) {
          this.str(StrFn.TO_REAL);
          if (to.kind === Kind.F32) this.code.op(Op.F32R);
        } else {
          this.str(StrFn.TO_INT);
          this.convert(T_LINT, to);
        }
        return to;
      }
      const st = this.typeOf(src);
      const from =
        (conv[1] ? scalar(conv[1]) : undefined) ??
        (isScalar(st) ? st : undefined) ??
        T_DINT;
      this.genExpr(src, from);
      this.temporalConvert(from, to, e);
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
    const rt0 = this.callType(e);
    const rt =
      (isScalar(rt0) ? rt0 : undefined) ??
      (want && !want.to ? want : undefined) ??
      T_DINT;
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
        return T_LREAL;
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
        const f = isFloat(rt);
        const u = rt.kind === Kind.U64;
        this.genExpr(args[0]!, rt);
        for (let i = 1; i < args.length; i++) {
          this.genExpr(args[i]!, rt);
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
        this.genExpr(this.arg(e, 1, "IN"), rt);
        this.genExpr(this.arg(e, 0, "MN"), rt);
        this.code.op(f ? Op.MAXF : u ? Op.MAXU : Op.MAXI);
        this.genExpr(this.arg(e, 2, "MX"), rt);
        this.code.op(f ? Op.MINF : u ? Op.MINU : Op.MINI);
        return rt;
      }
      case "SEL":
        this.genExpr(this.arg(e, 0, "G"), T_BOOL);
        this.genExpr(this.arg(e, 1, "IN0"), rt);
        this.genExpr(this.arg(e, 2, "IN1"), rt);
        this.code.op(Op.SEL);
        return rt;
      case "MUX": {
        // K selects among IN0..INn: evaluated as a chain of SEL
        const k = this.tempSlot(T_LINT);
        this.genExpr(args[0]!, T_LINT);
        this.store(T_LINT, Base.F, k.off);
        const n = args.length - 1;
        this.genExpr(args[n]!, rt);
        for (let i = n - 1; i >= 1; i--) {
          // value = (K = i-1) ? INi : value
          this.load(T_LINT, Base.F, k.off);
          this.pushConst(T_LINT, BigInt(i - 1));
          this.code.op(Op.EQI);
          this.code.op(Op.SWAP);
          this.genExpr(args[i]!, rt);
          // stack: g, in0(value), in1(INi)
          this.code.op(Op.SEL);
        }
        return rt;
      }
      case "TRUNC":
        this.genExpr(args[0]!, T_LREAL);
        this.code.op(Op.F2I);
        this.code.op(Op.TRUNC);
        this.code.u8(Kind.I32);
        return T_DINT;
      case "SHL":
      case "SHR":
      case "ROL":
      case "ROR": {
        const t0 = this.typeOf(args[0]!);
        const t = isScalar(t0) ? t0 : rt;
        this.genExpr(args[0]!, t);
        this.genExpr(args[1]!, T_LINT);
        if (name === "SHL") this.code.op(Op.SHL);
        else if (name === "SHR") this.code.op(isUnsigned(t) ? Op.SHR : Op.SAR);
        else {
          this.code.op(name === "ROL" ? Op.ROL : Op.ROR);
          this.code.u8(kindSize(t.kind) * 8);
        }
        if (kindSize(t.kind) < 8) {
          this.code.op(Op.TRUNC);
          this.code.u8(t.kind);
        }
        return t;
      }
      case "ADR":
      case "REF_LINK":
        this.genAddressOf(args[0]!);
        return T_PTR;
      case "SIZEOF": {
        const t = this.typeOf(args[0]!);
        if (!t) this.fail("SIZEOF: tipo sconosciuto", e);
        // STRING(n): n+1 as in CODESYS; a pointer counts 4 bytes like CODESYS
        // 32-bit, which OSCAT assumes ((size - SIZEOF(pt)) / SIZEOF(pt)).
        const n =
          t.t === "string"
            ? t.len + 1
            : isScalar(t) && t.to
              ? 4
              : this.sizeOf(t);
        this.pushConst(T_UDINT, BigInt(n));
        return T_UDINT;
      }
      case "LOWER_BOUND":
      case "UPPER_BOUND": {
        const t = this.typeOf(args[0]!);
        const d = args[1] ? this.tryConst(args[1]) : 1n;
        if (!t || t.t !== "array" || typeof d !== "bigint")
          this.fail(`${name}: array richiesto`, e);
        const dim = t.dims[Number(d) - 1];
        if (!dim) this.fail(`${name}: dimensione inesistente`, e);
        this.pushConst(
          T_DINT,
          BigInt(name === "LOWER_BOUND" ? dim.lo : dim.hi),
        );
        return T_DINT;
      }
      case "LEN":
        this.genStrSrc(args[0]!);
        this.str(StrFn.LEN);
        return T_INT;
      case "FIND":
        this.genStrSrc(this.arg(e, 0, "IN1"));
        this.genStrSrc(this.arg(e, 1, "IN2"));
        this.str(StrFn.FIND);
        return T_INT;
      case "TIME":
        if (args.length) break;
        // CODESYS TIME(): PLC time, here the scan time from the host
        this.code.op(Op.NATIVE);
        this.code.u16(this.ensureNative("AB_TIME", [], Kind.I64));
        return T_TIME;
      case "ODD":
        this.genExpr(args[0]!, T_LINT);
        this.pushConst(T_LINT, 1n);
        this.code.op(Op.AND);
        return T_BOOL;
    }
    this.fail(`Funzione ${name} non ancora supportata`, e);
  }

  /** Index of a host native, added to the NATV table on first use. */
  private ensureNative(name: string, params: Kind[], ret: Kind | 0): number {
    const have = this.natives.findIndex((n) => n.name === name);
    if (have >= 0) return have;
    this.natives.push({ name, params, ret });
    return this.natives.length - 1;
  }

  /**
   * Conversion between elementary types, with the STruC++/CODESYS units for
   * temporal values: TIME and TOD exchange milliseconds with numbers, DT and
   * DATE seconds (DATE is stored in days).
   */
  private temporalConvert(from: ScalarT, to: ScalarT, node: unknown) {
    const ft = TEMPORAL.has(from.name);
    const tt = TEMPORAL.has(to.name);
    const div = (n: bigint) => {
      this.pushConst(T_LINT, n);
      this.code.op(Op.DIVI);
    };
    const mul = (n: bigint) => {
      this.pushConst(T_LINT, n);
      this.code.op(Op.MULI);
    };
    if (ft && !tt) {
      switch (from.name) {
        case "TIME":
        case "TOD":
          div(1_000_000n);
          break;
        case "DT":
          div(1_000_000_000n);
          break;
        case "DATE":
          mul(86400n);
          break;
        case "LDATE":
          mul(DAY_NS);
          break;
      }
      this.convert(T_LINT, to);
      return;
    }
    if (tt && !ft) {
      if (isFloat(from)) this.code.op(Op.F2I);
      else if (isBool(from)) void 0;
      switch (to.name) {
        case "TIME":
        case "TOD":
          mul(1_000_000n);
          break;
        case "DT":
          mul(1_000_000_000n);
          break;
        case "DATE":
          div(86400n);
          break;
        case "LDATE":
          div(DAY_NS);
          break;
      }
      return;
    }
    if (ft && tt) {
      // DT -> DATE / TOD, DATE -> DT
      if (from.name === "DT" && to.name === "DATE") return div(DAY_NS);
      if (from.name === "DT" && to.name === "TOD") {
        this.pushConst(T_LINT, DAY_NS);
        this.code.op(Op.MODI);
        return;
      }
      if (from.name === "DATE" && to.name === "DT") return mul(DAY_NS);
      if (
        from.name !== to.name &&
        !(from.name === "TIME" && to.name === "LTIME") &&
        !(from.name === "LTIME" && to.name === "TIME")
      )
        this.fail(
          `Conversione ${from.name}_TO_${to.name} non supportata`,
          node,
        );
      return;
    }
    if (from.kind !== to.kind || (isBool(to) && !isBool(from))) {
      if (isFloat(from) && !isFloat(to)) {
        // REAL_TO_INT rounds (std::round in the C++ runtime)
        this.code.op(Op.F2IR);
        this.convert(T_LINT, to);
        return;
      }
      this.convert(from, to);
    }
  }

  /** FB call: inputs written into the instance, CALLFB, outputs read back. */
  private genFbCall(e: FunctionCallExpression) {
    let inst: Place;
    if (e.instance) {
      const p = this.genPlaceExpr(e.instance);
      if (isBitPlace(p)) this.fail("Istanza non valida", e);
      inst = p;
    } else {
      const v = this.findVar(e.functionName)!;
      inst = { base: v.base, off: v.slot.off, type: v.slot.type };
      if (v.slot.indirect) inst = this.derefSlot(inst);
    }
    if (inst.base === Base.P) {
      // computed instance address: keep it in a temporary
      const tmp = this.tempSlot(T_LINT);
      this.pushAddr(inst);
      this.store(T_LINT, Base.F, tmp.off);
      inst = { base: Base.F, off: tmp.off, type: inst.type };
      return this.genFbCallAt(e, inst, true);
    }
    return this.genFbCallAt(e, inst, false);
  }

  private genFbCallAt(
    e: FunctionCallExpression,
    inst: Place,
    viaTemp: boolean,
  ) {
    const fbName = (inst.type as FbT).name;
    const pou = this.pouByName.get(fbName)!;
    this.layoutPou(pou);
    const layout = pou.inst;
    const inputs = layout.order.filter((v) => v.section === "VAR_INPUT");
    // field place: direct, or through the address in the temporary
    const field = (f: VarSlot): Place => {
      if (!viaTemp)
        return { base: inst.base, off: inst.off + f.off, type: f.type };
      this.load(T_LINT, Base.F, inst.off);
      return { base: Base.P, off: f.off, type: f.type };
    };
    let pos = 0;
    const outs: Array<{ field: VarSlot; target: Expression }> = [];
    for (const a of e.arguments) {
      if (a.name === "EN" || a.name === "ENO") continue;
      const f = a.name ? layout.vars.get(a.name) : inputs[pos++];
      if (!f) this.fail(`${fbName}: parametro ${a.name ?? pos} non trovato`, a);
      if (a.isOutput) {
        outs.push({ field: f, target: a.value });
        continue;
      }
      if (f.indirect) {
        const p = field(f);
        if (this.isLvalue(a.value)) this.genAddressOf(a.value);
        else if (f.type.t === "string") this.genStrSrc(a.value);
        else this.fail(`${fbName}.${f.name}: serve una variabile`, a);
        this.store(T_LINT, p.base, p.off);
        continue;
      }
      const p = field(f);
      if (isScalar(f.type)) {
        this.genExpr(a.value, f.type);
        this.store(f.type, p.base, p.off);
      } else {
        this.pushAddr(p);
        if (f.type.t === "string") this.genStrInto(a.value, f.type);
        else {
          this.genAggSrc(a.value, f.type);
          this.copyOp(f.type);
        }
      }
    }
    if (viaTemp) this.load(T_LINT, Base.F, inst.off);
    else this.addr(inst.base, inst.off);
    this.code.op(Op.CALLFB);
    this.code.u16(pou.index);
    for (const o of outs) {
      const tp = this.genPlaceExpr(o.target);
      if (isBitPlace(tp)) {
        // read the output into the bit
        const fp = field(o.field);
        void fp;
        this.fail("Uscita di FB verso un bit non supportata", o.target);
      }
      if (isScalar(o.field.type)) {
        const fp = field(o.field);
        this.load(o.field.type, fp.base, fp.off);
        if (!isScalar(tp.type))
          this.fail("Uscita di FB di tipo diverso", o.target);
        if (tp.type.kind !== o.field.type.kind)
          this.convert(o.field.type, tp.type);
        this.store(tp.type, tp.base, tp.off);
      } else {
        this.pushAddr(tp);
        const fp = field(o.field);
        this.pushAddr(fp);
        this.copyOp(o.field.type);
      }
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
