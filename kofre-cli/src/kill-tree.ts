import { spawnSync, type ChildProcess } from "node:child_process";

/** En POSIX el hijo debe lanzarse con `detached: true`: así es líder de su grupo y se puede matar el grupo entero. */
export const DETACH_FOR_TREE_KILL = process.platform !== "win32";

/**
 * Detiene un proceso y todo lo que lanzó. `child.kill()` solo mata al hijo directo: `kofre run -- pnpm dev` deja vivos
 * cmd, pnpm y el servidor, que siguen ocupando el puerto. En Windows lo hace taskkill /T; en POSIX, la señal al grupo.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM"); // sin grupo propio (no se lanzó con detached)
  }
}
