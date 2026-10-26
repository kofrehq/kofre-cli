import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { serviceToken } from "./config";
import { MAX_VALUE_BYTES, SECRET_NAME, readTomlProject } from "./envfile";
import { DETACH_FOR_TREE_KILL, killTree } from "./kill-tree";
import { loadProject, readSecrets, writeSecrets } from "./secrets";
import { readVaultKey } from "./vault-store";
import { needsCmdShell, quoteForCmd } from "./win-command";

/*
 * Servidor MCP por stdio (JSON-RPC 2.0, una línea por mensaje). Lo lanza el agente (Claude Code, Cursor…) con
 * `kofre mcp` desde la carpeta del proyecto. Ninguna herramienta devuelve valores de secretos: el agente ve nombres,
 * ejecuta comandos con las variables inyectadas y lee la salida con los valores tachados.
 */

const PROTOCOL = "2025-06-18";
const OUTPUT_CAP = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Valores más cortos que esto no se tachan: "true" o "3000" aparecen en cualquier salida sin ser el secreto. */
const MIN_REDACT = 6;

type Json = Record<string, unknown>;
type Request = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Json };

export const TOOLS = [
  {
    name: "kofre_status",
    description:
      "Proyecto Kofre vinculado a la carpeta actual, sus ambientes y si la bóveda está desbloqueada. Nunca devuelve valores de secretos.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kofre_list",
    description: "Nombres de las variables de un ambiente, sin valores. Sirve para saber qué existe antes de ejecutar algo.",
    inputSchema: {
      type: "object",
      properties: { env: { type: "string", description: "slug del ambiente; por defecto el defaultEnv de .kofre.toml" } },
    },
  },
  {
    name: "kofre_run",
    description:
      "Ejecuta un comando con las variables del ambiente inyectadas en su entorno y devuelve código de salida y salida (stdout+stderr) con los valores de los secretos tachados como [NOMBRE]. Es la forma de usar secretos sin verlos: no leas .env ni pidas valores.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "array", items: { type: "string" }, minItems: 1, description: "programa y argumentos, por ejemplo [\"pnpm\", \"test\"]" },
        env: { type: "string", description: "slug del ambiente" },
        timeout_ms: { type: "integer", description: `límite de tiempo; por defecto ${DEFAULT_TIMEOUT_MS}` },
      },
      required: ["command"],
    },
  },
  {
    name: "kofre_set",
    description:
      "Guarda o actualiza una variable cifrada en el ambiente. Úsalo cuando generes una credencial nueva en vez de escribirla en un archivo .env.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, value: { type: "string" }, env: { type: "string" } },
      required: ["name", "value"],
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];

const unlocked = () => Boolean(serviceToken() || readVaultKey());

function requireUnlocked() {
  if (!unlocked()) {
    throw new Error("La bóveda está bloqueada. Pide al usuario que ejecute `kofre unlock` en una terminal y vuelve a intentarlo.");
  }
}

/** Tacha cada valor presente en la salida. Los más largos primero, por si un valor contiene a otro. */
export function redact(text: string, values: Record<string, string>): string {
  const entries = Object.entries(values)
    .filter(([, value]) => value.length >= MIN_REDACT)
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of entries) out = out.replaceAll(value, `[${name}]`);
  return out;
}

function tail(text: string): string {
  return text.length > OUTPUT_CAP ? `…(${text.length - OUTPUT_CAP} caracteres omitidos)\n${text.slice(-OUTPUT_CAP)}` : text;
}

async function runWithSecrets(command: string[], slug: string | undefined, timeoutMs: number): Promise<string> {
  const { environment, values } = await readSecrets(slug);
  const env = { ...process.env, ...values };
  const output: string[] = [];
  const code = await new Promise<number | string>((resolve) => {
    const child = needsCmdShell(command[0])
      ? spawn(command.map(quoteForCmd).join(" "), { shell: true, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      : spawn(command[0], command.slice(1), { env, stdio: ["ignore", "pipe", "pipe"], detached: DETACH_FOR_TREE_KILL, windowsHide: true });
    const timer = setTimeout(() => {
      output.push(`\n[kofre] tiempo agotado tras ${timeoutMs} ms; proceso detenido.\n`);
      killTree(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      output.push(error.code === "ENOENT" ? `No se encontró el comando "${command[0]}".` : error.message);
      resolve(127);
    });
    child.on("exit", (exitCode, signal) => {
      clearTimeout(timer);
      resolve(exitCode ?? signal ?? 1);
    });
  });
  return `ambiente: ${environment.slug}\nsalida: ${code}\n\n${redact(tail(output.join("")), values)}`;
}

export async function callTool(name: ToolName | string, args: Json): Promise<string> {
  switch (name) {
    case "kofre_status": {
      const linked = readTomlProject();
      if (!linked) return "Esta carpeta no está vinculada a ningún proyecto. Pide al usuario que ejecute `kofre init --project <id>`.";
      const project = await loadProject();
      const envs = project.environments.map((env) => `  - ${env.slug}${env.slug === linked.defaultEnv ? " (por defecto)" : ""}`).join("\n");
      return `proyecto: ${project.name} (${project.id})\nbóveda: ${unlocked() ? "desbloqueada" : "bloqueada (kofre unlock)"}\nambientes:\n${envs}`;
    }
    case "kofre_list": {
      requireUnlocked();
      const { environment, values } = await readSecrets(typeof args.env === "string" ? args.env : undefined);
      const names = Object.keys(values).sort();
      return names.length ? `${environment.slug}: ${names.length} variables\n${names.join("\n")}` : `${environment.slug}: sin variables`;
    }
    case "kofre_run": {
      requireUnlocked();
      const command = Array.isArray(args.command) ? args.command.map(String) : [];
      if (command.length === 0) throw new Error("command debe ser un array con al menos el programa.");
      const timeout = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
      return runWithSecrets(command, typeof args.env === "string" ? args.env : undefined, timeout);
    }
    case "kofre_set": {
      requireUnlocked();
      const key = String(args.name ?? "");
      const value = String(args.value ?? "");
      if (!SECRET_NAME.test(key)) throw new Error(`Nombre no válido: ${key}. Usa letras, dígitos y guion bajo.`);
      if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new Error(`${key} supera el máximo de ${MAX_VALUE_BYTES / 1024} KiB.`);
      const { changed } = await writeSecrets({ [key]: value }, typeof args.env === "string" ? args.env : undefined);
      return changed ? `${key} guardada y cifrada.` : `${key} ya tenía ese valor.`;
    }
    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

/** Responde a un mensaje JSON-RPC; null para notificaciones (no llevan respuesta). */
export async function handle(message: Request, version: string): Promise<Json | null> {
  const { id, method, params = {} } = message;
  if (method.startsWith("notifications/")) return null;
  const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "kofre", version },
        instructions:
          "Kofre guarda los secretos del proyecto cifrados. Nunca pidas ni muestres valores: usa kofre_list para ver nombres y kofre_run para ejecutar comandos que los necesiten.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Json;
      try {
        return reply({ content: [{ type: "text", text: await callTool(name, args) }] });
      } catch (error) {
        return reply({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default:
      return fail(-32601, `Método no soportado: ${method}`);
  }
}

export function serveMcp(version: string): Promise<void> {
  // Cualquier console.log de los helpers rompería el canal: todo lo informativo va a stderr.
  console.log = (...args: unknown[]) => console.error(...args);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return new Promise((resolve) => {
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: Request;
      try {
        message = JSON.parse(line) as Request;
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON no válido" } })}\n`);
        return;
      }
      void handle(message, version).then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
    });
    lines.on("close", resolve);
  });
}
