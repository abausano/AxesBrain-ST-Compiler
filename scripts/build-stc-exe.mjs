#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
/**
 * Single executable of the AxesBrain .stc compiler (cli-stc), for machines without Node.js.
 *
 * 1. esbuild: dist/backend-stc/cli-stc.js and everything it imports in one CJS file (dist/stc/axesbrain-stc.cjs);
 * 2. Node.js Single Executable Application: blob from that file, copy of the node.exe that runs this script,
 *    blob injected with postject (no download: the base binary is the local Node.js).
 *
 * Output: dist/stc/axesbrain-stc.exe (same command line as `node cli-stc.js`), plus the libraries
 * libs/axesbrain/*.st copied next to it in dist/stc/libs.
 *
 *   npm run build:tsc-only && node scripts/build-stc-exe.mjs
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const out = join("dist", "stc");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "libs"), { recursive: true });

const bundle = join(out, "axesbrain-stc.cjs");
await build({
  entryPoints: ["dist/backend-stc/cli-stc.js"],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: bundle,
  format: "cjs",
  define: { STRUCPP_VERSION: JSON.stringify(pkg.version) },
  logLevel: "warning",
});

const blob = join(out, "sea-prep.blob");
const config = join(out, "sea-config.json");
writeFileSync(
  config,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }, null, 2),
);
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });

const exe = join(out, "axesbrain-stc.exe");
copyFileSync(process.execPath, exe);
// node.exe is signed: the signature becomes invalid after the injection (sign the result again if needed)
execFileSync(
  process.execPath,
  [
    join("node_modules", "postject", "dist", "cli.js"),
    exe,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--overwrite",
  ],
  { stdio: "inherit" },
);
rmSync(blob);
rmSync(config);

for (const f of readdirSync(join("libs", "axesbrain")))
  if (f.endsWith(".st")) copyFileSync(join("libs", "axesbrain", f), join(out, "libs", f));

// GPL: the licence goes with the executable, with where the sources are
for (const f of ["COPYING", "COPYING.RUNTIME", "LICENSE"]) copyFileSync(f, join(out, f));
writeFileSync(
  join(out, "LEGGIMI.txt"),
  [
    `Compilatore Structured Text (IEC 61131-3) per il PLC ST di AxesBrain, versione ${pkg.version}.`,
    "Fork di STruC++ (Autonomy) con il back-end .stc di AB&T: GPL-3.0 (COPYING, LICENSE). I file .stc prodotti",
    "si possono distribuire come si vuole: permesso aggiuntivo della sezione 7, nell'intestazione dei sorgenti di",
    "src/backend-stc. COPYING.RUNTIME è l'eccezione di STruC++ per la sua libreria di runtime C++.",
    "Sorgenti: https://github.com/abausano/AxesBrain-ST-Compiler, ramo axesbrain.",
    "",
    "Uso: axesbrain-stc.exe programma.st [librerie.st ...] [AxesBrainIO.st] -o programma.stc [--json esito.json]",
    "     [--lib archivio.stlib] [-D NOME=valore] [--tutto] [--tutti-io]",
    "Le librerie AxesBrain (blocchi standard, AB_RunPP, MC_*) sono nella cartella libs.",
    `Eseguibile Node.js ${process.version} (Single Executable Application) con il compilatore incluso.`,
    "",
  ].join(String.fromCharCode(13, 10)),
);

console.log(`Scritto ${exe} (compilatore .stc ${pkg.version}, Node.js ${process.version})`);
