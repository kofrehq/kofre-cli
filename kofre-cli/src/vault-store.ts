import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ponytail: llavero del SO vía herramientas nativas (DPAPI, security, secret-tool) para mantener la CLI en un solo
// archivo sin addons nativos. Si Node SEA llega a empaquetar addons, @napi-rs/keyring es el reemplazo directo.

/*
 * Dos entradas en el llavero, con caducidad:
 *  - "vault": la clave privada de la cuenta (kofre unlock). Abre cualquier ambiente de cualquier proyecto.
 *  - "envkeys": claves de ambientes concretos (kofre unlock --env dev). La clave privada no se guarda; un agente con
 *    esta entrada solo alcanza esos ambientes, nunca prod si no se desbloqueó.
 */

type Payload = { key?: string; keys?: Record<string, string>; exp: number };
type Account = "vault" | "envkeys";

const SERVICE = "kofre";

function home(): string {
  return process.env.KOFRE_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".kofre");
}

function ttlMs(): number {
  const minutes = Number(process.env.KOFRE_VAULT_TTL_MIN ?? 720);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 720) * 60_000;
}

function useFileBackend(): boolean {
  return process.env.KOFRE_VAULT_FILE === "1";
}

const filePath = (account: Account) => join(home(), account === "vault" ? "vault.key" : "envkeys.key");
const dpapiPath = (account: Account) => join(home(), account === "vault" ? "vault.dpapi" : "envkeys.dpapi");

function writeOwnerOnly(path: string, data: string) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(path, data, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignora modos POSIX; ahí el archivo solo se usa con KOFRE_VAULT_FILE=1.
  }
}

function powershell(script: string, input: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const PS_PROTECT =
  "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); " +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in),$null,'CurrentUser'))";
const PS_UNPROTECT =
  "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); " +
  "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in),$null,'CurrentUser'))";

type Backend = {
  read(account: Account): string | null;
  write(account: Account, data: string): void;
  clear(account: Account): void;
};

const fileBackend: Backend = {
  read: (account) => (existsSync(filePath(account)) ? readFileSync(filePath(account), "utf8") : null),
  write: (account, data) => writeOwnerOnly(filePath(account), data),
  clear: (account) => rmSync(filePath(account), { force: true }),
};

const dpapiBackend: Backend = {
  read: (account) => (existsSync(dpapiPath(account)) ? powershell(PS_UNPROTECT, readFileSync(dpapiPath(account), "utf8")) : null),
  write: (account, data) => writeOwnerOnly(dpapiPath(account), powershell(PS_PROTECT, data)),
  clear: (account) => rmSync(dpapiPath(account), { force: true }),
};

const keychainBackend: Backend = {
  read: (account) => {
    const result = spawnSync("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"], { encoding: "utf8" });
    // El payload va en base64: `security -i` tokeniza la línea y las comillas del JSON no sobrevivirían.
    return result.status === 0 ? Buffer.from(result.stdout.trim(), "base64").toString("utf8") : null;
  },
  // `security -i` lee comandos por stdin: el secreto no pasa por argv.
  write: (account, data) => {
    const result = spawnSync("security", ["-i"], {
      input: `add-generic-password -U -a ${account} -s ${SERVICE} -w ${Buffer.from(data, "utf8").toString("base64")}\n`,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "No se pudo guardar en el llavero");
  },
  clear: (account) => {
    spawnSync("security", ["delete-generic-password", "-a", account, "-s", SERVICE], { stdio: "ignore" });
  },
};

const secretToolBackend: Backend = {
  read: (account) => {
    const result = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], { encoding: "utf8" });
    return result.status === 0 && result.stdout ? result.stdout.trim() : null;
  },
  write: (account, data) => {
    const result = spawnSync("secret-tool", ["store", "--label=Kofre vault", "service", SERVICE, "account", account], {
      input: data,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "No se pudo guardar en el llavero");
  },
  clear: (account) => {
    spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account], { stdio: "ignore" });
  },
};

let warned = false;

function backend(): Backend {
  if (useFileBackend()) return fileBackend;
  if (process.platform === "win32") return dpapiBackend;
  if (process.platform === "darwin") return keychainBackend;
  if (spawnSync("secret-tool", ["--version"], { stdio: "ignore" }).status === 0) return secretToolBackend;
  if (!warned) {
    warned = true;
    console.error("Aviso: sin secret-tool (libsecret); la clave se guarda en un archivo 0600 en ~/.kofre.");
  }
  return fileBackend;
}

function readPayload(account: Account): Payload | null {
  let raw: string | null;
  try {
    raw = backend().read(account);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as Payload;
    if (payload.exp <= Date.now()) {
      clear(account);
      return null;
    }
    return payload;
  } catch {
    clear(account);
    return null;
  }
}

function clear(account: Account) {
  try {
    backend().clear(account);
  } catch {
    // Nada que limpiar.
  }
}

/** Clave privada de la cuenta en base64, si está desbloqueada y no ha caducado. */
export function readVaultKey(): string | null {
  return readPayload("vault")?.key ?? null;
}

export function writeVaultKey(keyB64: string) {
  backend().write("vault", JSON.stringify({ key: keyB64, exp: Date.now() + ttlMs() } satisfies Payload));
}

/** Claves de ambiente desbloqueadas a propósito: { "<projectId>:<slug>": envKey base64 }. */
export function readEnvKeys(): Record<string, string> {
  return readPayload("envkeys")?.keys ?? {};
}

export function writeEnvKeys(keys: Record<string, string>) {
  backend().write("envkeys", JSON.stringify({ keys, exp: Date.now() + ttlMs() } satisfies Payload));
}

/** `kofre lock` y `kofre logout`: olvida la clave privada y las claves de ambiente. */
export function clearVaultKey() {
  clear("vault");
  clear("envkeys");
}

/** Cuándo caduca lo que haya desbloqueado, para decírselo al usuario. */
export function vaultExpiry(): Date | null {
  const exp = readPayload("vault")?.exp ?? readPayload("envkeys")?.exp;
  return exp ? new Date(exp) : null;
}
