import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * `kofre guard`: deja el proyecto listo para trabajar con agentes de IA sin que vean secretos.
 * Todo es idempotente y conserva lo que ya hubiera en cada archivo.
 */

const GITIGNORE_LINES = [".env", ".env.*", "!.env.example"];
/** Reglas de permisos de Claude Code: ni Read ni los comandos de shell más comunes pueden abrir un .env. */
const CLAUDE_DENY = ["Read(./.env)", "Read(./.env.*)", "Read(./**/.env)", "Read(./**/.env.*)", "Bash(cat .env*)", "Bash(cat ./.env*)"];
const MCP_SERVER = { command: "kofre", args: ["mcp"] };

type Change = { file: string; action: "creado" | "actualizado" | "sin cambios" };

function mergeLines(path: string, wanted: string[]): Change {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const have = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = wanted.filter((line) => !have.has(line));
  if (missing.length === 0) return { file: path, action: "sin cambios" };
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${sep}${missing.join("\n")}\n`);
  return { file: path, action: existing ? "actualizado" : "creado" };
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} no es JSON válido; corrígelo o bórralo y vuelve a ejecutar kofre guard.`);
  }
}

function writeJson(path: string, data: unknown, existed: boolean): Change {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return { file: path, action: existed ? "actualizado" : "creado" };
}

function addMcpServer(path: string): Change {
  const existed = existsSync(path);
  const config = readJson(path);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (servers.kofre) return { file: path, action: "sin cambios" };
  return writeJson(path, { ...config, mcpServers: { ...servers, kofre: MCP_SERVER } }, existed);
}

function addClaudeDeny(path: string): Change {
  const existed = existsSync(path);
  const config = readJson(path);
  const permissions = (config.permissions ?? {}) as Record<string, unknown>;
  const deny = Array.isArray(permissions.deny) ? (permissions.deny as string[]) : [];
  const missing = CLAUDE_DENY.filter((rule) => !deny.includes(rule));
  if (missing.length === 0) return { file: path, action: "sin cambios" };
  return writeJson(path, { ...config, permissions: { ...permissions, deny: [...deny, ...missing] } }, existed);
}

export function guard(cwd = process.cwd()): Change[] {
  return [
    mergeLines(join(cwd, ".gitignore"), GITIGNORE_LINES),
    addClaudeDeny(join(cwd, ".claude", "settings.json")),
    addMcpServer(join(cwd, ".mcp.json")),
    mergeLines(join(cwd, ".cursorignore"), [".env", ".env.*"]),
    addMcpServer(join(cwd, ".cursor", "mcp.json")),
  ].map((change) => ({ ...change, file: change.file.slice(cwd.length + 1).replaceAll("\\", "/") }));
}
