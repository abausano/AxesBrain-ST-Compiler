// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
//
// Additional permission under GNU GPL version 3 section 7:
// the output of this back-end (.stc files), including any part of this file
// copied into it, may be distributed under terms of your choice.
/**
 * Serializes an StcModule to the binary .stc container (docs/AXESBRAIN_STC.md §3).
 *
 * Section payloads (format 0.2, little-endian):
 *   DATA: u32 size, bytes
 *   POUS: u32 n; per POU: u8 kind, u32 codeOff, u32 codeLen, u32 frameSize,
 *         u32 instSize, u8 nParams, {u8 kind, u32 off}*, u8 retKind, u32 retOff,
 *         str name   (retKind 11 = the result is returned by address)
 *   CODE: bytes
 *   TASK: u32 n; per task: str name, i64 intervalNs, i32 priority, u16 n,
 *         {u16 pou, u32 instOff}*
 *   IOMP: u32 n; per entry: u8 area, u8 size, u16 byte, u8 bit, u8 kind, u32 gOff
 *   NATV: u32 n; per native: str name, u8 n, u8 kind*, u8 retKind
 *   FRMI: u32 n; per POU with a frame: u16 pou, u32 len, bytes (initial frame)
 *   DBUG: u32 nSym; {str name, u8 kind, u32 gOff, u32 count}*;   (kind 11 = STRING)
 *         u32 nLines; {u16 pou, u32 pc, u32 line, u16 col}*
 *   SRCS (optional): u32 n; {str path, u8[16] md5}*   additional source files
 *         (libraries, I/O file) with their MD5: SRV marks the .stc stale if one changed.
 * str = u16 length + UTF-8 bytes.
 */

import {
  STC_MAGIC,
  STC_VERSION_MAJOR,
  STC_VERSION_MINOR,
} from "./stc-format.js";
import type { StcModule } from "./stc-codegen.js";

class Buf {
  b: number[] = [];
  u8(v: number) {
    this.b.push(v & 0xff);
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
  str(s: string) {
    const e = new TextEncoder().encode(s);
    this.u16(e.length);
    for (const x of e) this.u8(x);
  }
  bytes(a: ArrayLike<number>) {
    for (let i = 0; i < a.length; i++) this.u8(a[i]!);
  }
  pad8() {
    while (this.b.length % 8) this.u8(0);
  }
}

export function writeStc(
  m: StcModule,
  md5: Uint8Array,
  compilerVersion = 1,
  sources: Array<{ path: string; md5: Uint8Array }> = [],
): Uint8Array {
  const sections: Array<[string, Buf]> = [];

  const data = new Buf();
  data.u32(m.data.length);
  data.bytes(m.data);
  sections.push(["DATA", data]);

  const code = new Buf();
  const pous = new Buf();
  pous.u32(m.pous.length);
  for (const p of m.pous) {
    const off = code.b.length;
    code.bytes(p.code);
    pous.u8(p.kind);
    pous.u32(off);
    pous.u32(p.code.length);
    pous.u32(p.frameSize);
    pous.u32(p.instSize);
    pous.u8(p.params.length);
    for (const a of p.params) {
      pous.u8(a.kind);
      pous.u32(a.off);
    }
    pous.u8(p.ret ? p.ret.kind : 0);
    pous.u32(p.ret ? p.ret.off : 0);
    pous.str(p.name);
  }
  sections.push(["POUS", pous]);
  sections.push(["CODE", code]);

  const frmi = new Buf();
  const withFrame = m.pous
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p.frameSize > 0);
  frmi.u32(withFrame.length);
  for (const { p, i } of withFrame) {
    frmi.u16(i);
    frmi.u32(p.frameInit.length);
    frmi.bytes(p.frameInit);
  }
  sections.push(["FRMI", frmi]);

  const task = new Buf();
  task.u32(m.tasks.length);
  for (const t of m.tasks) {
    task.str(t.name);
    task.i64(t.intervalNs);
    task.i32(t.priority);
    task.u16(t.programs.length);
    for (const p of t.programs) {
      task.u16(p.pou);
      task.u32(p.instOff);
    }
  }
  sections.push(["TASK", task]);

  const io = new Buf();
  io.u32(m.io.length);
  for (const e of m.io) {
    io.u8(e.area);
    io.u8(e.size);
    io.u16(e.byte);
    io.u8(e.bit);
    io.u8(e.kind);
    io.u32(e.gOff);
  }
  sections.push(["IOMP", io]);

  const nat = new Buf();
  nat.u32(m.natives.length);
  for (const n of m.natives) {
    nat.str(n.name);
    nat.u8(n.params.length);
    for (const k of n.params) nat.u8(k);
    nat.u8(n.ret);
  }
  sections.push(["NATV", nat]);

  const dbg = new Buf();
  dbg.u32(m.symbols.length);
  for (const s of m.symbols) {
    dbg.str(s.name);
    dbg.u8(s.kind);
    dbg.u32(s.gOff);
    dbg.u32(s.count);
  }
  dbg.u32(m.lines.length);
  for (const l of m.lines) {
    dbg.u16(l.pou);
    dbg.u32(l.pc);
    dbg.u32(l.line);
    dbg.u16(l.col);
  }
  sections.push(["DBUG", dbg]);

  // SYMT (10/11/2026): indices of the DBUG symbols that are BOOL (the VM keeps them U8; the debug shows TRUE/FALSE)
  const symt = new Buf();
  const bools = m.symbols
    .map((s, i) => (s.bool ? i : -1))
    .filter((i) => i >= 0);
  symt.u32(bools.length);
  for (const i of bools) symt.u32(i);
  sections.push(["SYMT", symt]);

  // LOCS (10/11/2026): variables in the frame of each POU (METHOD, FUNCTION), offsets in the frame; u8 flags bit 0 = BOOL
  if (m.locals.length) {
    const locs = new Buf();
    locs.u32(m.locals.length);
    for (const l of m.locals) {
      locs.u16(l.pou);
      locs.u32(l.vars.length);
      for (const v of l.vars) {
        locs.str(v.name);
        locs.u8(v.kind);
        locs.u32(v.gOff);
        locs.u32(v.count);
        locs.u8(v.bool ? 1 : 0);
      }
    }
    sections.push(["LOCS", locs]);
  }

  if (sources.length) {
    const srcs = new Buf();
    srcs.u32(sources.length);
    for (const f of sources) {
      srcs.str(f.path);
      srcs.bytes(f.md5);
    }
    sections.push(["SRCS", srcs]);
  }

  // Header (64 bytes) + section table (12 bytes per section) + sections.
  const out = new Buf();
  for (const ch of STC_MAGIC) out.u8(ch.charCodeAt(0));
  out.u16(STC_VERSION_MAJOR);
  out.u16(STC_VERSION_MINOR);
  out.u32(1); // flags: bit 0 = debug present
  out.bytes(md5);
  out.u32(compilerVersion);
  out.u32(sections.length);
  while (out.b.length < 64) out.u8(0);
  let off = 64 + 12 * sections.length;
  off = Math.ceil(off / 8) * 8;
  const offsets: number[] = [];
  for (const [, s] of sections) {
    offsets.push(off);
    off = Math.ceil((off + s.b.length) / 8) * 8;
  }
  sections.forEach(([id, s], i) => {
    for (const ch of id) out.u8(ch.charCodeAt(0));
    out.u32(offsets[i]!);
    out.u32(s.b.length);
  });
  out.pad8();
  for (const [, s] of sections) {
    out.bytes(s.b);
    out.pad8();
  }
  return Uint8Array.from(out.b);
}
