#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
/**
 * strucpp-ab: compile ST sources to an AxesBrain .stc file (prototype).
 *
 *   node dist/backend-stc/cli-stc.js a.st [b.st ...] -o out.stc [--json diag.json]
 *        [--lib libreria.stlib]... [-D NOME=valore]... [--tutto]
 *
 * --lib adds the ST sources and constants of a .stlib archive (e.g. OSCAT);
 * --tutto generates code for every POU, not only the ones the programs use.
 *
 * Exit code 0 on success, 1 on compile errors. Errors are printed as
 * file:line:col: error: message (and written to --json when given).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { analyze } from "../index.js";
import { StcError, StcGenerator } from "./stc-codegen.js";
import { writeStc } from "./stc-writer.js";

interface Diag {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
}

function main(argv: string[]): number {
  const inputs: string[] = [];
  const libs: string[] = [];
  const constants: Record<string, number> = {};
  let out = "";
  let json = "";
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-o") out = argv[++i] ?? "";
    else if (a === "--json") json = argv[++i] ?? "";
    else if (a === "--lib") libs.push(argv[++i] ?? "");
    else if (a === "--tutto") all = true;
    else if (a === "-D") {
      const [k, v] = (argv[++i] ?? "").split("=");
      if (k) constants[k.toUpperCase()] = Number(v ?? 1);
    } else inputs.push(a);
  }
  if (inputs.length === 0 || !out) {
    console.error(
      "uso: cli-stc file.st [altri.st] -o programma.stc [--json diagnostica.json]",
    );
    return 2;
  }
  const sources = inputs.map((f) => ({
    fileName: basename(f),
    source: readFileSync(f, "utf8"),
  }));
  for (const lib of libs) {
    const arch = JSON.parse(readFileSync(lib, "utf8")) as {
      sources?: Array<{ fileName: string; source: string }>;
      globalConstants?: Record<string, number>;
    };
    for (const s of arch.sources ?? [])
      sources.push({ fileName: s.fileName, source: s.source });
    for (const [k, v] of Object.entries(arch.globalConstants ?? {}))
      if (!(k.toUpperCase() in constants)) constants[k.toUpperCase()] = v;
  }
  // MD5 of the main source file only, byte for byte as on disk (CRLF and BOM
  // included): SRV compares it with the .st it launches to detect a stale .stc.
  const md5 = createHash("md5");
  md5.update(readFileSync(inputs[0]!));

  const diags: Diag[] = [];
  const r = analyze(sources[0]!.source, {
    fileName: sources[0]!.fileName,
    additionalSources: sources.slice(1),
    globalConstants: constants,
  });
  for (const e of r.errors) {
    diags.push({
      file: e.file ?? sources[0]!.fileName,
      line: e.line,
      column: e.column,
      severity: "error",
      message: e.message,
    });
  }
  for (const w of r.warnings) {
    // The C++ back-end ignores AT on top-level VAR_GLOBAL; the .stc back-end binds it.
    if (
      /declared in a top-level VAR_GLOBAL, where the compiler cannot bind it/.test(
        w.message,
      )
    )
      continue;
    diags.push({
      file: w.file ?? sources[0]!.fileName,
      line: w.line,
      column: w.column,
      severity: "warning",
      message: w.message,
    });
  }
  let ok = r.errors.length === 0 && !!r.ast;
  if (ok) {
    try {
      const gen = new StcGenerator({
        globalConstants: constants,
        onlyReachable: !all,
      });
      const mod = gen.generate(r.ast!);
      for (const e of gen.errors)
        diags.push({
          file: e.file || sources[0]!.fileName,
          line: e.line,
          column: e.column,
          severity: "error",
          message: e.message,
        });
      if (gen.errors.length) ok = false;
      else writeFileSync(out, writeStc(mod, new Uint8Array(md5.digest())));
    } catch (e) {
      ok = false;
      if (e instanceof StcError) {
        diags.push({
          file: e.file || sources[0]!.fileName,
          line: e.line,
          column: e.column,
          severity: "error",
          message: e.message,
        });
      } else throw e;
    }
  }
  for (const d of diags)
    console.error(
      `${d.file}:${d.line}:${d.column}: ${d.severity}: ${d.message}`,
    );
  if (json)
    writeFileSync(json, JSON.stringify({ ok, diagnostics: diags }, null, 2));
  return ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
