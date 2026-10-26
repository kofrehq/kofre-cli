import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// La release de GitHub la publica el workflow en cada tag y cubre npm, Homebrew, Scoop e install.sh.
const LATEST_URL = "https://api.github.com/repos/kofrehq/kofre-releases/releases/latest";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type UpdateState = { checkedAt: number; latest: string };

function statePath(): string {
  const home = process.env.KOFRE_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".kofre");
  return join(home, "update-check.json");
}

export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** Avisa por stderr si hay versión nueva. Consulta como mucho cada 6 horas y nunca hace fallar el comando. */
export async function notifyUpdate(current: string): Promise<void> {
  if (current === "dev" || process.env.CI || process.env.KOFRE_NO_UPDATE_CHECK || !process.stderr.isTTY) return;
  try {
    const path = statePath();
    let state: UpdateState | null = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as UpdateState) : null;
    // Lo guardado es más viejo que la versión instalada: se consultó antes de actualizar y ya no dice nada útil.
    if (!state || Date.now() - state.checkedAt > CHECK_EVERY_MS || isNewer(current, state.latest)) {
      const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(1500), headers: { accept: "application/vnd.github+json" } });
      if (!response.ok) return;
      const { tag_name } = (await response.json()) as { tag_name: string };
      state = { checkedAt: Date.now(), latest: tag_name.replace(/^v/, "") };
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(state));
    }
    if (isNewer(state.latest, current)) {
      console.error(
        `\nHay una versión nueva de kofre: ${state.latest} (tienes ${current}).\n` +
          "Actualiza con: npm i -g @kofre/cli  |  brew upgrade kofre  |  scoop update kofre",
      );
    }
  } catch {
    // Sin red o respuesta rara: no es motivo para molestar.
  }
}
