// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
//
// Additional permission under GNU GPL version 3 section 7:
// the output of this back-end (.stc files), including any part of this file
// copied into it, may be distributed under terms of your choice.
/**
 * AxesBrain .stc format: shared constants (see docs/AXESBRAIN_STC.md).
 * Format version 0.2.
 */

export const STC_MAGIC = "ABST";
export const STC_VERSION_MAJOR = 0;
export const STC_VERSION_MINOR = 2;

/** Value kinds: memory representation of an elementary value. */
export enum Kind {
  U8 = 1, // BOOL, BYTE, USINT, CHAR
  I8 = 2, // SINT
  U16 = 3, // WORD, UINT
  I16 = 4, // INT
  U32 = 5, // DWORD, UDINT
  I32 = 6, // DINT
  I64 = 7, // LINT, TIME, LTIME, DATE, TOD, DT, pointers
  U64 = 8, // LWORD, ULINT
  F32 = 9, // REAL
  F64 = 10, // LREAL
}

/** Symbol kind for STRING variables (DBUG section). */
export const SYM_STRING = 11;
/** Return kind of a FUNCTION whose result is a STRING, STRUCT or ARRAY. */
export const RET_ADDR = 11;
/** Bytes of the STRING header placed before the characters (u16 cap, u16 0). */
export const STR_HEADER = 4;

export function kindSize(k: Kind): number {
  switch (k) {
    case Kind.U8:
    case Kind.I8:
      return 1;
    case Kind.U16:
    case Kind.I16:
      return 2;
    case Kind.U32:
    case Kind.I32:
    case Kind.F32:
      return 4;
    default:
      return 8;
  }
}

/** Address bases for direct loads and stores. */
export enum Base {
  G = 0, // global segment, absolute offset
  F = 1, // current frame
  I = 2, // current instance (PROGRAM / FUNCTION_BLOCK)
  P = 3, // address popped from the operand stack
}

/** Opcodes. Operands are little-endian immediates. */
export enum Op {
  NOP = 0x00,
  PUSHI = 0x01, // i64
  PUSHF = 0x02, // f64
  POP = 0x03,
  DUP = 0x04,
  LD = 0x05, // u8 kind, u8 base, u32 off
  ST = 0x06, // u8 kind, u8 base, u32 off   (P: address below value)
  ADDR = 0x07, // u8 base, u32 off -> absolute address
  IDX = 0x08, // i32 lo, i32 hi, u32 elemSize: addr, index -> addr (bounds trap)
  COPY = 0x09, // u32 size: dst, src -> (memmove)
  SWAP = 0x0a,
  ADDI = 0x10,
  SUBI = 0x11,
  MULI = 0x12,
  DIVI = 0x13,
  DIVU = 0x14,
  MODI = 0x15,
  MODU = 0x16,
  NEGI = 0x17,
  ABSI = 0x18,
  ADDF = 0x19,
  SUBF = 0x1a,
  MULF = 0x1b,
  DIVF = 0x1c,
  NEGF = 0x1d,
  F32R = 0x1e, // round double to float precision
  TRUNC = 0x1f, // u8 kind: wrap integer to the kind's width
  EQI = 0x20,
  NEI = 0x21,
  LTI = 0x22,
  LEI = 0x23,
  GTI = 0x24,
  GEI = 0x25,
  LTU = 0x26,
  LEU = 0x27,
  GTU = 0x28,
  GEU = 0x29,
  EQF = 0x2a,
  NEF = 0x2b,
  LTF = 0x2c,
  LEF = 0x2d,
  GTF = 0x2e,
  GEF = 0x2f,
  AND = 0x30,
  OR = 0x31,
  XOR = 0x32,
  NOTB = 0x33,
  NOTI = 0x34,
  SHL = 0x35,
  SHR = 0x36,
  MINI = 0x37,
  MAXI = 0x38,
  MINU = 0x39,
  MAXU = 0x3a,
  MINF = 0x3b,
  MAXF = 0x3c,
  SEL = 0x3d, // g, in0, in1 -> g ? in1 : in0
  ROL = 0x3e, // u8 bits: value, n -> rotated (value zero-extended)
  ROR = 0x3f, // u8 bits
  I2F = 0x40,
  U2F = 0x41,
  F2I = 0x42, // truncate toward zero
  F2IR = 0x43, // round half away from zero
  MATH = 0x44, // u8 function (see MathFn)
  STR = 0x45, // u8 function (see StrFn), operands are string addresses
  SAR = 0x46, // arithmetic shift right (SHR of signed values)
  JMP = 0x50, // i32 relative to next instruction
  JZ = 0x51,
  JNZ = 0x52,
  CALL = 0x60, // u16 pou
  CALLFB = 0x61, // u16 pou, instance address popped
  RET = 0x62,
  NATIVE = 0x63, // u16 native index
  BRK = 0x70,
  TRAP = 0x71, // u8 code
}

export enum MathFn {
  SQRT = 1,
  LN = 2,
  LOG = 3,
  EXP = 4,
  SIN = 5,
  COS = 6,
  TAN = 7,
  ASIN = 8,
  ACOS = 9,
  ATAN = 10,
  POW = 11,
  ABS = 12,
  FLOOR = 13,
  ATAN2 = 14,
}

/**
 * String functions executed by the VM (STR opcode). A string operand is the
 * address of its first character; the u16 capacity is 4 bytes before it and
 * the text ends at the first NUL (CODESYS layout).
 */
export enum StrFn {
  ASSIGN = 1, // dst, src
  CONCAT = 2, // dst, a, b
  LEN = 3, // a -> n
  LEFT = 4, // dst, a, n
  RIGHT = 5, // dst, a, n
  MID = 6, // dst, a, l, p
  INSERT = 7, // dst, a, b, p
  DELETE = 8, // dst, a, l, p
  REPLACE = 9, // dst, a, b, l, p
  FIND = 10, // a, b -> position (1-based, 0 if absent)
  CMP = 11, // a, b -> -1, 0, 1
  FROM_INT = 12, // dst, i64
  FROM_UINT = 13, // dst, u64
  FROM_REAL = 14, // dst, f64 (REAL formatting)
  FROM_LREAL = 15, // dst, f64 (LREAL formatting)
  TO_INT = 16, // a -> i64
  TO_REAL = 17, // a -> f64
  FROM_BOOL = 18, // dst, b
  FROM_TIME = 19, // dst, ns
  CHR = 20, // dst, code -> one-character string
  CODE = 21, // a, position -> character code (0 if out of range)
}

export enum PouKind {
  FUNCTION = 1,
  FUNCTION_BLOCK = 2,
  PROGRAM = 3,
}

/** Located-variable areas and sizes (IOMP section). */
export enum IoArea {
  I = 0,
  Q = 1,
  M = 2,
}
export enum IoSize {
  X = 0,
  B = 1,
  W = 2,
  D = 3,
  L = 4,
}
