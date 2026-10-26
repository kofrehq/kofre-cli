import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bytesToB64, sealedBox } from "@kofre/crypto";

/*
 * `kofre sync <servicio>`: descifra el ambiente en esta máquina y lo sube con la API del servicio. El servidor de
 * Kofre no participa (cero conocimiento). Los tokens salen de la opción --token, de la variable de entorno habitual
 * o de la sesión de la CLI oficial de cada servicio.
 */

export type Values = Record<string, string>;

/** Ambiente de Kofre → target de Vercel; cualquier otro slug va a preview. */
export const vercelTarget = (slug: string) => ({ dev: "development", staging: "preview", prod: "production" })[slug] ?? "preview";

export function flyAppFromToml(text: string): string | null {
  return text.match(/^\s*app\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
}

/** owner/repo a partir de la URL del remoto (ssh o https, con o sin .git). */
export function repoFromRemote(url: string): string | null {
  return url.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

function tool(command: string, args: string[]): string | null {
  for (const name of process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command]) {
    try {
      return execFileSync(name, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() || null;
    } catch {
      // Sin la herramienta o sin sesión: se prueba el siguiente nombre.
    }
  }
  return null;
}

function vercelAuthFile(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "com.vercel.cli", "Data", "auth.json");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "com.vercel.cli", "auth.json");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "com.vercel.cli", "auth.json");
}

export function vercelToken(flag?: string): string {
  const fromCli = () => {
    const file = vercelAuthFile();
    if (!existsSync(file)) return null;
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { token?: string }).token ?? null;
    } catch {
      return null;
    }
  };
  const token = flag ?? process.env.VERCEL_TOKEN ?? fromCli();
  if (!token) throw new Error("Falta el token de Vercel: --token, VERCEL_TOKEN o `vercel login`.");
  return token;
}

export function flyToken(flag?: string): string {
  const token = flag ?? process.env.FLY_API_TOKEN ?? tool("flyctl", ["auth", "token"]) ?? tool("fly", ["auth", "token"]);
  if (!token) throw new Error("Falta el token de Fly: --token, FLY_API_TOKEN o `fly auth login`.");
  return token;
}

export function githubToken(flag?: string): string {
  const token = flag ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? tool("gh", ["auth", "token"]);
  if (!token) throw new Error("Falta el token de GitHub: --token, GITHUB_TOKEN o `gh auth login`.");
  return token;
}

/** Proyecto y equipo de Vercel: el .vercel/project.json que deja `vercel link`. */
export function vercelProject(cwd = process.cwd()): { projectId: string; orgId: string } | null {
  const file = join(cwd, ".vercel", "project.json");
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { projectId?: string; orgId?: string };
  return parsed.projectId && parsed.orgId ? { projectId: parsed.projectId, orgId: parsed.orgId } : null;
}

async function call<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = json.error?.message ?? json.message ?? text;
    } catch {
      // texto plano
    }
    throw new Error(`${label} respondió ${response.status}: ${detail.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function pushVercel(opts: { project: string; team?: string; target: string; token: string; values: Values }): Promise<number> {
  const entries = Object.entries(opts.values);
  if (entries.length === 0) return 0;
  const query = `upsert=true${opts.team ? `&teamId=${encodeURIComponent(opts.team)}` : ""}`;
  const result = await call<{ failed?: { error?: { key?: string; message?: string } }[] }>(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(opts.project)}/env?${query}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify(entries.map(([key, value]) => ({ key, value, type: "encrypted", target: [opts.target] }))),
    },
    "Vercel",
  );
  const failed = result.failed ?? [];
  if (failed.length > 0) {
    throw new Error(`Vercel rechazó ${failed.length} variables: ${failed.map((f) => `${f.error?.key ?? "?"} (${f.error?.message ?? "sin detalle"})`).join(", ")}`);
  }
  return entries.length;
}

/** Fly aplica los secretos en un despliegue nuevo: la app se reinicia con los valores. */
export async function pushFly(opts: { app: string; token: string; values: Values }): Promise<number> {
  const secrets = Object.entries(opts.values).map(([key, value]) => ({ key, value }));
  if (secrets.length === 0) return 0;
  const result = await call<{ errors?: { message: string }[] }>(
    "https://api.fly.io/graphql",
    {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: "mutation($input: SetSecretsInput!) { setSecrets(input: $input) { release { version } } }",
        variables: { input: { appId: opts.app, secrets } },
      }),
    },
    "Fly",
  );
  if (result.errors?.length) throw new Error(`Fly: ${result.errors.map((e) => e.message).join("; ")}`);
  return secrets.length;
}

export async function pushGithub(opts: { repo: string; environment?: string; token: string; values: Values }): Promise<number> {
  const entries = Object.entries(opts.values);
  if (entries.length === 0) return 0;
  const base = `https://api.github.com/repos/${opts.repo}${opts.environment ? `/environments/${encodeURIComponent(opts.environment)}` : ""}/actions/secrets`;
  const headers = { authorization: `Bearer ${opts.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  const { key, key_id: keyId } = await call<{ key: string; key_id: string }>(`${base}/public-key`, { headers }, "GitHub");
  const publicKey = Buffer.from(key, "base64");
  for (const [name, value] of entries) {
    const sealed = sealedBox(new TextEncoder().encode(value), publicKey);
    await call(
      `${base}/${name}`,
      { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ encrypted_value: Buffer.from(sealed).toString("base64"), key_id: keyId }) },
      `GitHub (${name})`,
    );
  }
  return entries.length;
}

// bytesToB64 es base64url; GitHub quiere base64 estándar, de ahí Buffer arriba. Se reexporta para la CLI.
export { bytesToB64 };
