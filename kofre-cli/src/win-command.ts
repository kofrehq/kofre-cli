import { existsSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * En Windows, los .cmd/.bat (npm, pnpm, npx) solo arrancan a través de cmd.exe; el resto va sin shell, para no
 * reinterpretar | & >. Busca como Windows: en cada carpeta del PATH, solo con las extensiones de PATHEXT y en su orden.
 * Un archivo sin extensión (el script `pnpm` que npm deja para Git Bash junto a pnpm.cmd) no es ejecutable aquí.
 */
export function needsCmdShell(command: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (platform !== "win32") return false;
  if (/\.(cmd|bat)$/i.test(command)) return true;
  if (/[\\/]/.test(command) || extname(command)) return false;
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => /^\.(com|exe|bat|cmd)$/i.test(ext));
  for (const dir of (env.PATH ?? env.Path ?? "").split(";")) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, command + ext))) return /^\.(bat|cmd)$/i.test(ext);
    }
  }
  return false;
}

export function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
