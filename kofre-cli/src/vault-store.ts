import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ponytail: llavero del SO vía herramientas nativas (DPAPI, security, secret-tool) para mantener la CLI en un solo
// archivo sin addons nativos. Si Node SEA llega a empaquetar addons, @napi-rs/keyring es el reemplazo directo.

type Payload = { key: string; exp: number };

const SERVICE = "kofre";
const ACCOUNT = "vault";

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

const filePath = () => join(home(), "vault.key");
const dpapiPath = () => join(home(), "vault.dpapi");

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
  read(): string | null;
  write(data: string): void;
  clear(): void;
};

const fileBackend: Backend = {
  read: () => (existsSync(filePath()) ? readFileSync(filePath(), "utf8") : null),
  write: (data) => writeOwnerOnly(filePath(), data),
  clear: () => rmSync(filePath(), { force: true }),
};

const dpapiBackend: Backend = {
  read: () => (existsSync(dpapiPath()) ? powershell(PS_UNPROTECT, readFileSync(dpapiPath(), "utf8")) : null),
  write: (data) => writeOwnerOnly(dpapiPath(), powershell(PS_PROTECT, data)),
  clear: () => rmSync(dpapiPath(), { force: true }),
};

const keychainBackend: Backend = {
  read: () => {
    const result = spawnSync("security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  },
  // `security -i` lee comandos por stdin: el secreto no pasa por argv.
  write: (data) => {
    const result = spawnSync("security", ["-i"], {
      input: `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -w ${data}\n`,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "No se pudo guardar en el llavero");
  },
  clear: () => {
    spawnSync("security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE], { stdio: "ignore" });
  },
};

const secretToolBackend: Backend = {
  read: () => {
    const result = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], { encoding: "utf8" });
    return result.status === 0 && result.stdout ? result.stdout.trim() : null;
  },
  write: (data) => {
    const result = spawnSync("secret-tool", ["store", "--label=Kofre vault", "service", SERVICE, "account", ACCOUNT], {
      input: data,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "No se pudo guardar en el llavero");
  },
  clear: () => {
    spawnSync("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT], { stdio: "ignore" });
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

export function readVaultKey(): string | null {
  let raw: string | null;
  try {
    raw = backend().read();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as Payload;
    if (!payload.key || payload.exp <= Date.now()) {
      clearVaultKey();
      return null;
    }
    return payload.key;
  } catch {
    clearVaultKey();
    return null;
  }
}

export function writeVaultKey(keyB64: string) {
  const payload: Payload = { key: keyB64, exp: Date.now() + ttlMs() };
  backend().write(JSON.stringify(payload));
}

export function clearVaultKey() {
  try {
    backend().clear();
  } catch {
    // Nada que limpiar.
  }
}
