#!/usr/bin/env node
// Empaqueta kofre-cli/dist/kofre.js como ejecutable único con Node SEA para el SO/arquitectura actual.
// Uso: node scripts/build-sea.mjs [salida]   (por defecto kofre-cli/dist/kofre-<os>-<arch>[.exe])
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "kofre-cli");
const bundle = join(cli, "dist", "kofre.js");
if (!existsSync(bundle)) {
  console.error("Falta kofre-cli/dist/kofre.js: ejecuta pnpm --filter @kofre/cli build");
  process.exit(1);
}

const os = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] ?? process.platform;
const arch = process.arch;
const ext = process.platform === "win32" ? ".exe" : "";
const out = resolve(process.argv[2] ?? join(cli, "dist", `kofre-${os}-${arch}${ext}`));
mkdirSync(dirname(out), { recursive: true });

const run = (cmd, args) => execFileSync(cmd, args, { cwd: cli, stdio: "inherit" });

run(process.execPath, ["--experimental-sea-config", "sea-config.json"]);
copyFileSync(process.execPath, out);
if (process.platform === "darwin") run("codesign", ["--remove-signature", out]);

const require = createRequire(join(cli, "package.json"));
const postject = join(dirname(require.resolve("postject/package.json")), "dist", "cli.js");
const args = [postject, out, "NODE_SEA_BLOB", join(cli, "dist", "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
run(process.execPath, args);

if (process.platform === "darwin") run("codesign", ["--sign", "-", out]);
console.log(out);
