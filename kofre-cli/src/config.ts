import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_KDF, b64ToBytes, bytesToB64, isServiceToken, parseServiceToken, serviceTokenKeys, unlockAccount, type KdfParams } from "@kofre/crypto";
import { promptHidden } from "./prompt";
import { clearVaultKey, readVaultKey, writeVaultKey } from "./vault-store";

export type SessionFile = {
  apiUrl: string;
  token: string;
  email: string;
  salt: string;
  kdfParams: KdfParams;
  wrappedPrivateKey: string;
  publicKey: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

function home(): string {
  return process.env.KOFRE_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".kofre");
}

const sessionPath = () => join(home(), "session.json");

/** La sesión se emitió para una API concreta: el token nunca viaja a otro host aunque KOFRE_API_URL diga lo contrario (p. ej. un .mcp.json ajeno). */
export function apiUrl(): string {
  const session = readSession()?.apiUrl;
  const fromEnv = process.env.KOFRE_API_URL;
  if (session && fromEnv && fromEnv !== session) console.error(`[kofre] KOFRE_API_URL (${fromEnv}) no coincide con la sesión (${session}); se usa la sesión. Haz kofre logout y login para cambiar de API.`);
  return session ?? fromEnv ?? "https://kofre-api.fly.dev";
}

export function readSession(): SessionFile | null {
  if (!existsSync(sessionPath())) return null;
  return JSON.parse(readFileSync(sessionPath(), "utf8")) as SessionFile;
}

export function writeSession(session: SessionFile) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(sessionPath(), JSON.stringify(session, null, 2), { mode: 0o600 });
}

/** Revoca la sesión en el servidor. true si quedó revocada (o ya lo estaba); false si no hubo conexión. */
export async function revokeSession(token: string): Promise<boolean> {
  try {
    await api("/auth/logout", { method: "POST", body: "{}" }, token);
    return true;
  } catch (error) {
    return error instanceof ApiError && error.status === 401;
  }
}

export function clearSession() {
  rmSync(sessionPath(), { force: true });
  clearVaultKey();
}

/** KOFRE_TOKEN (kofre_st_…) sustituye al login: acceso de solo lectura para CI, sin llavero ni contraseña. */
export function serviceToken(): string | null {
  const token = process.env.KOFRE_TOKEN?.trim();
  if (!token) return null;
  if (!isServiceToken(token)) throw new Error("KOFRE_TOKEN no tiene el formato kofre_st_<id>.<secreto>.");
  return token;
}

export function requireSession(): SessionFile {
  const token = serviceToken();
  if (token) {
    return { apiUrl: apiUrl(), token, email: "token de servicio", salt: "", kdfParams: DEFAULT_KDF, wrappedPrivateKey: "", publicKey: "" };
  }
  const session = readSession();
  if (!session) throw new Error("No hay sesión. Ejecuta `kofre login` o define KOFRE_TOKEN.");
  return session;
}

/** Clave privada: del token de servicio, del llavero del SO si sigue vigente, o pidiendo la contraseña maestra. */
/**
 * Clave privada de la cuenta. Solo `kofre unlock` la deja en el llavero (persist); un `kofre pull` que pide contraseña la
 * usa y la olvida, para que no quede 12 horas al alcance de cualquier proceso sin que el usuario lo haya pedido.
 */
export async function vaultKey(opts: { persist?: boolean } = {}): Promise<Uint8Array> {
  const token = serviceToken();
  if (token) return serviceTokenKeys(parseServiceToken(token).secret).privateKey;
  const cached = readVaultKey();
  if (cached) return b64ToBytes(cached);
  const session = requireSession();
  const password = await promptHidden("Contraseña maestra");
  let unlocked;
  try {
    unlocked = await unlockAccount(password, session.salt, session.wrappedPrivateKey, session.kdfParams);
  } catch {
    throw new Error("Contraseña maestra incorrecta.");
  }
  if (opts.persist) writeVaultKey(bytesToB64(unlocked.privateKey));
  return unlocked.privateKey;
}

export async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${apiUrl()}${path}`, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // texto plano
    }
    const message =
      body && typeof body === "object" && "message" in body
        ? String(Array.isArray((body as { message: unknown }).message) ? (body as { message: string[] }).message.join("; ") : (body as { message: unknown }).message)
        : text || `HTTP ${response.status}`;
    if (response.status === 401) throw new ApiError(401, body, "Sesión no válida. Ejecuta `kofre login`.");
    throw new ApiError(response.status, body, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
