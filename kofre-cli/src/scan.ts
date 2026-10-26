import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

/*
 * `kofre scan`: lo que un agente de IA o un commit descuidado puede filtrar. Busca archivos .env fuera de .gitignore
 * (o ya rastreados por git) y credenciales en claro en las configuraciones de agentes (MCP, Claude, Cursor).
 * ponytail: no busca secretos dentro del código fuente; para eso está gitleaks.
 */

export type Finding = { kind: "env-tracked" | "env-unignored" | "env-no-gitignore" | "agent-config"; file: string; detail: string };

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "target", ".venv", "venv", "__pycache__"]);
const EXAMPLE = /\.(example|sample|template|dist)$/i;
const MAX_DEPTH = 6;

/** Configuraciones de agentes relativas a la carpeta del proyecto y a la del usuario. */
export const AGENT_CONFIGS = [".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".codex/config.json"];
const HOME_CONFIGS = [
  ".claude.json",
  ".cursor/mcp.json",
  ".codex/config.json",
  join("AppData", "Roaming", "Claude", "claude_desktop_config.json"),
  join("Library", "Application Support", "Claude", "claude_desktop_config.json"),
  join(".config", "Claude", "claude_desktop_config.json"),
];

/** Prefijos de credenciales conocidas; lo demás se decide por longitud y entropía. */
const KNOWN_PREFIX = /^(sk-[A-Za-z0-9_-]{8,}|sk_(live|test)_|rk_(live|test)_|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[abpr]-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|kofre_st_|npm_|pypi-|dop_v1_|st\.[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}\.|-----BEGIN )/;
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|auth)/i;

export function looksLikeSecret(key: string, value: string): boolean {
  if (KNOWN_PREFIX.test(value)) return true;
  if (!SECRET_KEY.test(key)) return false;
  // Fechas ISO y números: "FirstTokenDate" lleva "token" en la clave pero el valor no es una credencial.
  if (value.length < 16 || /\s/.test(value) || value.startsWith("$") || /^[\d\-:.TZ+]+$/.test(value)) return false;
  return entropy(value) >= 3.2;
}

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let sum = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    sum -= p * Math.log2(p);
  }
  return sum;
}

/** Recorre un JSON y devuelve las rutas (a.b[0].c) cuyo valor parece una credencial. */
export function secretPaths(value: unknown, path = ""): string[] {
  if (typeof value === "string") {
    const key = path.split(/[.[]/).pop()?.replace("]", "") ?? "";
    return looksLikeSecret(key, value) ? [path] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => secretPaths(item, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => secretPaths(item, path ? `${path}.${key}` : key));
  }
  return [];
}

function* envFiles(dir: string, depth = 0): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) yield* envFiles(path, depth + 1);
    } else if (/^\.env(\..+)?$/.test(entry.name) && !EXAMPLE.test(entry.name)) {
      yield path;
    }
  }
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

export function scan(cwd = process.cwd(), home = homedir()): Finding[] {
  const findings: Finding[] = [];
  const inRepo = git(cwd, ["rev-parse", "--is-inside-work-tree"]).ok;
  const hasGitignore = existsSync(join(cwd, ".gitignore"));

  for (const file of envFiles(cwd)) {
    const rel = relative(cwd, file).replaceAll("\\", "/");
    if (inRepo && git(cwd, ["ls-files", "--error-unmatch", "--", rel]).ok) {
      findings.push({ kind: "env-tracked", file: rel, detail: "está en el historial de git: rota sus valores y quítalo con git rm --cached" });
    } else if (inRepo ? !git(cwd, ["check-ignore", "-q", "--", rel]).ok : true) {
      findings.push({
        kind: hasGitignore ? "env-unignored" : "env-no-gitignore",
        file: rel,
        detail: hasGitignore ? "no está en .gitignore" : "no hay .gitignore en el proyecto",
      });
    }
  }

  const candidates = [...AGENT_CONFIGS.map((p) => join(cwd, p)), ...HOME_CONFIGS.map((p) => join(home, p))];
  for (const file of candidates) {
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue; // No es JSON válido: nada que inspeccionar.
    }
    for (const path of secretPaths(parsed)) {
      const shown = (file.startsWith(cwd) ? relative(cwd, file) : file.replace(home, "~")).replaceAll("\\", "/");
      findings.push({ kind: "agent-config", file: shown, detail: `credencial en claro en ${path}` });
    }
  }
  return findings;
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "Sin hallazgos: ningún .env expuesto ni credenciales en configuraciones de agentes.";
  const lines = findings.map((f) => `  ${f.kind === "env-tracked" ? "✖" : "!"} ${basename(f.file) === f.file ? f.file : f.file}: ${f.detail}`);
  const hint = findings.some((f) => f.kind !== "agent-config")
    ? "\nEjecuta `kofre guard` para ignorar los .env y bloquear su lectura a los agentes, y `kofre push` para guardarlos cifrados."
    : "\nMueve esas credenciales a Kofre (`kofre set`) y deja la configuración sin valores.";
  return `${findings.length} ${findings.length === 1 ? "hallazgo" : "hallazgos"}:\n${lines.join("\n")}${hint}`;
}
