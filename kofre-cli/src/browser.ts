import { execFile } from "node:child_process";

/** KOFRE_NO_BROWSER=1: por SSH o en máquinas sin navegador, el enlace se abre en otro equipo. */
export function openInBrowser(url: string): void {
  if (process.env.KOFRE_NO_BROWSER) return;
  const platform = process.platform;
  if (platform === "win32") {
    execFile("cmd", ["/c", "start", "", url], { shell: false });
    return;
  }
  if (platform === "darwin") {
    execFile("open", [url]);
    return;
  }
  execFile("xdg-open", [url]);
}
