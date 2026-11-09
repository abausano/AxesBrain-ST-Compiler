// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
//
// Regression tests for the .stc back-end: compiles each case, runs it on an
// AxesBrain VM test harness (path in the STVM environment variable) and
// compares the output with atteso/<nome>.txt.
//
//   STVM=C:\percorso\stvm-test.exe node tests-stc/esegui.mjs [--aggiorna]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const stvm = process.env.STVM;
if (!stvm || !existsSync(stvm)) {
  console.error("Imposta STVM con il percorso di stvm-test.exe");
  process.exit(2);
}
const aggiorna = process.argv.includes("--aggiorna");
const casi = JSON.parse(readFileSync(join(dir, "casi.json"), "utf8"));
const cli = join(dir, "..", "dist", "backend-stc", "cli-stc.js");
mkdirSync(join(dir, "out"), { recursive: true });
mkdirSync(join(dir, "atteso"), { recursive: true });
let falliti = 0;
for (const c of casi) {
  const stc = join(dir, "out", `${c.nome}.stc`);
  const opz = (c.compilatore ?? []).map((a) => (/\.(stlib|st)$/.test(a) ? join(dir, a) : a));
  execFileSync(process.execPath, [cli, ...c.sorgenti.map((s) => join(dir, s)), ...opz, "-o", stc], { stdio: "pipe" });
  const r = spawnSync(stvm, [stc, ...c.argomenti], { encoding: "utf8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const file = join(dir, "atteso", `${c.nome}.txt`);
  if (aggiorna || !existsSync(file)) {
    writeFileSync(file, out);
    console.log(`${c.nome}: atteso scritto`);
    continue;
  }
  const atteso = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (atteso === out.replace(/\r\n/g, "\n")) console.log(`${c.nome}: ok`);
  else {
    falliti++;
    console.log(`${c.nome}: DIVERSO\n--- atteso\n${atteso}\n--- ottenuto\n${out}`);
  }
}
process.exit(falliti ? 1 : 0);
