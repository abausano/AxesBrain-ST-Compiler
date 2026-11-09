// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
//
// Cycle-by-cycle comparison between the original STruC++ C++ back-end and the
// .stc back-end: the same ST sources are compiled both ways, run for N scans
// and every variable is printed after each scan; the two outputs must match.
//
//   STVM=C:\percorso\stvm-test.exe node tests-stc/confronto.mjs [nome...]
//
// The C++ side is built with g++ from WSL (`wsl g++`). Native functions are
// replaced by C++ stubs: {external native AB_TIME} returns the scan time.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(dir, "..");
const stvm = process.env.STVM;
if (!stvm || !existsSync(stvm)) {
  console.error("Imposta STVM con il percorso di stvm-test.exe");
  process.exit(2);
}
const filtro = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const casi = JSON.parse(readFileSync(join(dir, "confronto", "casi.json"), "utf8"));
const cliStc = join(root, "dist", "backend-stc", "cli-stc.js");
const cliCpp = join(root, "dist", "node", "cli.js");
const toWsl = (p) =>
  resolve(p)
    .replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`)
    .replace(/\\/g, "/");

/** C++ stubs for the natives used by the tests. */
const STUB = {
  AB_TIME: "AB_TIME_result = static_cast<TIME_t>(__CURRENT_TIME_NS);",
};

function cppPath(sym, programs) {
  const parts = sym.match(/[^.[\]]+(\[[^\]]*\])?/g);
  let out = "";
  parts.forEach((p, i) => {
    const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(p);
    let name = m[1];
    if (i === 0) name = programs.includes(name) ? `prog_${name}` : `strucpp::${name}`;
    out += (i ? "." : "") + name;
    if (m[2] !== undefined) out += `.at(${m[2]})`;
  });
  return out;
}

/**
 * Two printed values that differ only by a few ulp in their reals: they come
 * from the math libraries (glibc for C++, MSVC CRT for the VM), not from the
 * semantics, and are counted apart.
 */
function vicini(x, y) {
  const fx = x.slice(x.indexOf("=") + 1);
  const fy = y.slice(y.indexOf("=") + 1);
  const re = /-?\d+(?:\.\d+)?(?:e[-+]\d+)?/g;
  const nx = fx.match(re);
  const ny = fy.match(re);
  if (!nx || !ny || nx.length !== ny.length) return false;
  if (fx.replace(re, "#") !== fy.replace(re, "#")) return false;
  return nx.every((v, k) => {
    const p = Number(v);
    const q = Number(ny[k]);
    if (p === q) return true;
    if (Number.isInteger(p) && Number.isInteger(q) && !/[.e]/.test(v + ny[k])) return false;
    return Math.abs(p - q) <= 1e-14 * Math.max(Math.abs(p), Math.abs(q));
  });
}

let falliti = 0;
for (const c of casi) {
  if (filtro.length && !filtro.includes(c.nome)) continue;
  const work = join(dir, "out", "confronto", c.nome);
  mkdirSync(work, { recursive: true });
  const sorgenti = c.sorgenti.map((s) => join(dir, s));
  // .stlib libraries: their ST sources are extracted into one file and
  // compiled identically on both sides, with the library constants (-D).
  const defs = [];
  for (const l of c.librerie ?? []) {
    const arch = JSON.parse(readFileSync(join(dir, l), "utf8"));
    const f = join(work, basename(l).replace(/\.stlib$/, "") + ".st");
    writeFileSync(f, arch.sources.map((s) => s.source).join("\n\n"));
    sorgenti.push(f);
    for (const [k, v] of Object.entries(arch.globalConstants ?? {})) defs.push("-D", `${k}=${v}`);
  }

  // .stc side
  const stc = join(work, `${c.nome}.stc`);
  const comp = spawnSync(process.execPath, [cliStc, ...sorgenti, ...defs, "-o", stc], { encoding: "utf8" });
  if (comp.status !== 0) {
    falliti++;
    const err = comp.stderr.split(/\r?\n/).filter((l) => l && !/warning/.test(l));
    console.log(`${c.nome}: errore del compilatore .stc\n  ${err.join("\n  ")}`);
    continue;
  }
  const list = spawnSync(stvm, [stc, "--list"], { encoding: "utf8" }).stdout;
  const programs = [...list.matchAll(/^ {2}\d+ (\S+) kind=3/gm)].map((m) => m[1]);
  const interval = Number(/interval=(\d+)ns/.exec(list)[1]);
  const simboli = list
    .split("SIMBOLI:")[1]
    .split(/\r?\n/)
    .map((l) => /^ {2}(\S+) = /.exec(l)?.[1])
    .filter(Boolean)
    .filter((s) => !(c.escludi ?? []).some((e) => s.startsWith(e)));
  const ms = (c.cicli * interval) / 1e6;
  const rv = spawnSync(stvm, [stc, "--ms", String(ms), "--esatto", "--print", simboli.join(",")], {
    encoding: "utf8",
  });
  const outVm = (rv.stdout + rv.stderr).replace(/\r\n/g, "\n");

  // C++ side
  const cppSrc = sorgenti.map((s) => {
    let txt = readFileSync(s, "utf8");
    txt = txt.replace(/\{external\s+native\s+([A-Za-z_]\w*)\s*\}/g, (all, n) => {
      const stub = STUB[n.toUpperCase()];
      if (!stub) throw new Error(`manca lo stub C++ per la nativa ${n}`);
      return `{external ${stub}}`;
    });
    const f = join(work, "cpp_" + basename(s));
    writeFileSync(f, txt);
    return f;
  });
  const cpp = join(work, "prog.cpp");
  const cc = spawnSync(
    process.execPath,
    [cliCpp, ...cppSrc, "-o", cpp, "--no-default-libs", ...defs],
    { encoding: "utf8" },
  );
  if (cc.status !== 0) {
    falliti++;
    console.log(`${c.nome}: errore del compilatore C++ di STruC++
${(cc.stdout + cc.stderr).slice(0, 3000)}`);
    continue;
  }
  const main = [
    '#include "prog.hpp"',
    '#include "stampa.hpp"',
    "using namespace strucpp;",
    ...programs.map((p) => `static Program_${p} prog_${p};`),
    "int main() {",
    `  for (long long k = 0; k < ${c.cicli}; k++) {`,
    `    __CURRENT_TIME_NS = k * ${interval}LL;`,
    ...programs.map((p) => `    prog_${p}.run();`),
    `    std::string o = "t=" + std::to_string(k * ${interval / 1e6}) + "ms";`,
    ...simboli.map((s) => `    confronto::campo(o, "${s}", ${cppPath(s, programs)});`),
    "    puts(o.c_str());",
    "  }",
    "}",
    "",
  ].join("\n");
  writeFileSync(join(work, "main.cpp"), main);
  const inc = toWsl(join(root, "src", "runtime", "include"));
  const gpp = spawnSync(
    "wsl",
    ["g++", "-std=c++17", "-O1", "-w", `-I${inc}`, `-I${toWsl(join(dir, "confronto"))}`, "-o", `${toWsl(work)}/prog`,
      `${toWsl(work)}/main.cpp`, `${toWsl(work)}/prog.cpp`],
    { encoding: "utf8" },
  );
  if (gpp.status !== 0) {
    falliti++;
    console.log(`${c.nome}: errore g++\n${(gpp.stderr || "").slice(0, 3000)}`);
    continue;
  }
  const rc = spawnSync("wsl", ["timeout", "60", `${toWsl(work)}/prog`], { encoding: "utf8" });
  if (rc.status === 124) {
    falliti++;
    console.log(`${c.nome}: il programma C++ non termina (60 s)`);
    continue;
  }
  const outCpp = (rc.stdout + rc.stderr).replace(/\r\n/g, "\n");
  writeFileSync(join(work, "vm.txt"), outVm);
  writeFileSync(join(work, "cpp.txt"), outCpp);

  const a = outVm.trimEnd().split("\n");
  const b = outCpp.trimEnd().split("\n");
  const diff = [];
  let libm = 0;
  const attese = new Map();
  for (const ad of c.attesoDiverso ?? []) for (const v of ad.variabili) attese.set(v, ad.motivo);
  const motivi = new Set();
  let nAttese = 0;
  for (let i = 0; i < Math.max(a.length, b.length) && diff.length < 10; i++) {
    if (a[i] === b[i]) continue;
    const va = (a[i] ?? "").split(" ");
    const vb = (b[i] ?? "").split(" ");
    const d = [];
    va.forEach((x, k) => {
      if (x === vb[k]) return;
      if (attese.has(x.split("=")[0])) {
        nAttese++;
        motivi.add(attese.get(x.split("=")[0]));
      }
      else if (vb[k] && vicini(x, vb[k])) libm++;
      else d.push(`${x} (C++: ${vb[k] ?? "-"})`);
    });
    if (d.length) diff.push(`ciclo ${i}: ${d.slice(0, 6).join("; ")}`);
  }
  if (diff.length === 0)
    console.log(
      `${c.nome}: ok (${a.length} cicli, ${simboli.length} variabili` +
        (libm ? `, ${libm} reali diversi solo nelle ultime cifre (libm)` : "") +
        (nAttese ? `, ${nAttese} differenze attese: ${[...motivi].join("; ")}` : "") +
        ")",
    );
  else {
    falliti++;
    console.log(`${c.nome}: DIVERSO\n  ${diff.join("\n  ")}`);
  }
}
process.exit(falliti ? 1 : 0);
