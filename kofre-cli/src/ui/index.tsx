import { render } from "ink";
import { App } from "./app";
import type { UiClient } from "./types";

type RefreshableStdout = NodeJS.WriteStream & { _refreshSize?: () => void };

/** Pantalla completa (búfer alternativo, como vim o htop): al salir, la terminal queda como estaba. */
export async function runUi(client: UiClient): Promise<void> {
  // En Windows con ConPTY (la terminal de VS Code, Windows Terminal) Node no siempre emite 'resize' al cambiar el
  // tamaño. _refreshSize lee el tamaño real y emite 'resize' si cambió, que es lo que Ink escucha para redibujar.
  // ponytail: sondeo cada 300 ms; quitarlo si Node llega a emitir 'resize' de forma fiable en ConPTY.
  const stdout = process.stdout as RefreshableStdout;
  const watcher = setInterval(() => stdout._refreshSize?.(), 300);
  watcher.unref();
  try {
    const instance = render(<App client={client} />, { alternateScreen: true, exitOnCtrlC: false });
    await instance.waitUntilExit();
  } finally {
    clearInterval(watcher);
  }
}
