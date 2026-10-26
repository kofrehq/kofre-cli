import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { needsCmdShell } from "../src/win-command";

// Una carpeta como la de pnpm/npm global en Windows: script sin extensión para Git Bash junto al .cmd.
const npmDir = mkdtempSync(join(tmpdir(), "kofre-npm-"));
for (const file of ["pnpm", "pnpm.cmd", "pnpm.ps1"]) writeFileSync(join(npmDir, file), "");
const exeDir = mkdtempSync(join(tmpdir(), "kofre-exe-"));
for (const file of ["node.exe", "node"]) writeFileSync(join(exeDir, file), "");
// PATHEXT en minúsculas: el CI corre en Linux, que distingue mayúsculas en los nombres de archivo; Windows no.
const env = { PATH: `${npmDir};${exeDir}`, PATHEXT: ".com;.exe;.bat;.cmd;.vbs;.js" };

describe("kofre run en Windows", () => {
  it("lanza pnpm.cmd con cmd.exe aunque haya un pnpm sin extensión al lado", () => {
    expect(needsCmdShell("pnpm", env, "win32")).toBe(true);
  });

  it("lanza los .exe sin shell", () => {
    expect(needsCmdShell("node", env, "win32")).toBe(false);
  });

  it("respeta rutas y extensiones explícitas, y fuera de Windows nunca usa shell", () => {
    expect(needsCmdShell("build.cmd", env, "win32")).toBe(true);
    expect(needsCmdShell("C:\\tools\\app", env, "win32")).toBe(false);
    expect(needsCmdShell("no-existe", env, "win32")).toBe(false);
    expect(needsCmdShell("pnpm", env, "linux")).toBe(false);
  });
});
