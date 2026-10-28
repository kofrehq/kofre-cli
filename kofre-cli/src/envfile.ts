import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "dotenv";

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Nombres que cambian cómo arranca un proceso: inyectados en `kofre run` ejecutarían código de quien los escribió en la
 * máquina de cualquier miembro. Se rechazan al guardar y se descartan al inyectar. La API aplica la misma lista.
 */
export const RESERVED_NAMES = new Set([
  "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "PYTHONPATH", "PYTHONSTARTUP", "PERL5OPT", "PERL5LIB",
  "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_CONFIG_GLOBAL", "NPM_CONFIG_SCRIPT_SHELL", "SHELL",
  "KOFRE_PASSWORD", "KOFRE_TOKEN", "KOFRE_HOME", "KOFRE_API_URL", "KOFRE_VAULT_FILE",
]);
export const isReservedName = (name: string) => RESERVED_NAMES.has(name.toUpperCase());
export const MAX_VALUE_BYTES = 48 * 1024;

export function parseEnvFile(text: string): Record<string, string> {
  const values = parse(text);
  const invalid = Object.keys(values).filter((key) => !SECRET_NAME.test(key));
  const reserved = Object.keys(values).filter(isReservedName);
  if (reserved.length) throw new Error(`${reserved.join(", ")}: no puede guardarse, cambia cómo arranca un proceso y ejecutaría código ajeno en cada máquina.`);
  if (invalid.length > 0) {
    throw new Error(`Nombres de variable no válidos: ${invalid.join(", ")}. Usa letras, dígitos y guion bajo.`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
      throw new Error(`${key} supera el máximo de ${MAX_VALUE_BYTES / 1024} KiB por valor.`);
    }
  }
  return values;
}

const SAFE_VALUE = /^[A-Za-z0-9_./:@+=,-]*$/;

/**
 * Produce un .env que dotenv vuelve a leer idéntico. dotenv solo expande \n y \r dentro de comillas dobles
 * y no des-escapa nada más, así que el tipo de comilla se elige según lo que contiene el valor.
 */
export function serializeEnv(values: Record<string, string>): string {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${quoteEnvValue(key, value)}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function quoteEnvValue(key: string, value: string): string {
  if (SAFE_VALUE.test(value)) return value;
  const hasNewline = /[\n\r]/.test(value);
  if (!value.includes('"') && !/\\[nr]/.test(value)) {
    return `"${value.replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`;
  }
  if (!hasNewline && !value.includes("'")) return `'${value}'`;
  if (!hasNewline && !value.includes("`")) return `\`${value}\``;
  throw new Error(`${key}: el valor mezcla comillas y saltos de línea y no puede escribirse en un .env.`);
}

export function gitignoreWarns(file = ".env", cwd = process.cwd()): string | null {
  const name = basename(file);
  const path = join(cwd, ".gitignore");
  if (!existsSync(path)) return `.gitignore no existe. Añade \`${name}\` antes de dejar secretos en disco.`;
  const lines = readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.trim());
  const patterns = [name, `/${name}`, ".env*"];
  if (name.startsWith(".env.")) patterns.push(".env.*");
  if (name.endsWith(".env")) patterns.push("*.env");
  return lines.some((line) => patterns.includes(line)) ? null : `${name} no está en .gitignore.`;
}

// Primera línea de los .env que escribe `kofre pull`: dotenv y los frameworks ignoran los comentarios, y la CLI
// la usa para saber si un archivo es suyo (y de qué proyecto y ambiente) antes de reemplazarlo.
const HEADER = /^# kofre: .*\/([a-z0-9][a-z0-9-]*) \(([^)\s]+)\)/;
const HEADER_HASH = /· huella ([0-9a-f]{12})\b/;

/** Huella del contenido que escribió `kofre pull`: si el archivo cambia, es que alguien lo editó a mano. */
export const bodyFingerprint = (body: string) => createHash("sha256").update(body.replace(/\r\n/g, "\n")).digest("hex").slice(0, 12);

export function kofreHeader(projectName: string, projectId: string, slug: string, body: string, now = new Date()): string {
  const when = now.toLocaleString("es", { dateStyle: "short", timeStyle: "short" });
  const name = projectName.replace(/[\r\n]/g, " ");
  return `# kofre: ${name}/${slug} (${projectId}) · generado el ${when} · huella ${bodyFingerprint(body)}. Cambia los valores en Kofre o con kofre push.\n`;
}

/** hash es null en archivos escritos antes de 0.4.0, que no la llevaban. */
export function readKofreHeader(text: string): { projectId: string; slug: string; hash: string | null } | null {
  const first = text.split(/\r?\n/, 1)[0];
  const match = first.match(HEADER);
  return match ? { slug: match[1], projectId: match[2], hash: first.match(HEADER_HASH)?.[1] ?? null } : null;
}

/** El contenido sin la línea de cabecera, tal como se calculó la huella. */
export const bodyOf = (text: string) => text.replace(/^[^\n]*\n/, "");

export function readTomlProject(cwd = process.cwd()): { projectId: string; defaultEnv: string } | null {
  const path = join(cwd, ".kofre.toml");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const projectId = text.match(/projectId\s*=\s*"([^"]+)"/)?.[1];
  const defaultEnv = text.match(/defaultEnv\s*=\s*"([^"]+)"/)?.[1] ?? "dev";
  if (!projectId) return null;
  return { projectId, defaultEnv };
}

export function tomlFor(projectId: string, defaultEnv: string): string {
  return `projectId = "${projectId}"\ndefaultEnv = "${defaultEnv}"\n`;
}
