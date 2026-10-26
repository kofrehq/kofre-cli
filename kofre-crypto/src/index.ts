import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa";
import { u32, u8 } from "@noble/ciphers/utils";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { x25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { argon2id } from "hash-wasm";

export const FORMAT_VERSION = 1;

export type KdfParams = {
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
};

// ponytail: 19 MiB y 2 iteraciones es el mínimo que recomienda OWASP para argon2id; calibrar en hardware real antes de subir más.
// Los valores viajan por usuario, así que cambiarlos no rompe cuentas: las antiguas siguen con los suyos hasta cambiar contraseña.
export const DEFAULT_KDF: KdfParams = {
  memorySize: 19456,
  iterations: 2,
  parallelism: 1,
  hashLength: 32,
};

export const KDF_LIMITS = {
  memorySize: { min: 8192, max: 1024 * 1024 },
  iterations: { min: 1, max: 16 },
  parallelism: { min: 1, max: 8 },
} as const;

export function isValidKdfParams(value: unknown): value is KdfParams {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  const inRange = (n: unknown, { min, max }: { min: number; max: number }) =>
    typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
  return (
    inRange(p.memorySize, KDF_LIMITS.memorySize) &&
    inRange(p.iterations, KDF_LIMITS.iterations) &&
    inRange(p.parallelism, KDF_LIMITS.parallelism) &&
    p.hashLength === 32
  );
}

const TYPE_WRAPPED_PRIV = 1;
const TYPE_ENV_KEY = 2;
const TYPE_SECRET = 3;
const TYPE_RECOVERY = 4;

const AAD_WRAP = utf8("kofre|wrap-priv|v1");
const AAD_RECOVERY = utf8("kofre|recovery|v1");
const AAD_SEAL = utf8("kofre|env-seal|v1");

export type PasswordMaterial = {
  salt: string;
  kdfParams: KdfParams;
  authVerifier: string;
  wrappedPrivateKey: string;
};

export type AccountMaterial = PasswordMaterial & {
  publicKey: string;
  recoveryKey: string;
  recoveryVerifier: string;
  recoveryWrap: string;
};

export type UnlockedAccount = {
  authVerifier: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64ToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function b32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function b32Decode(text: string): Uint8Array {
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error("Clave de recuperación con caracteres no válidos");
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 32 bytes → 13 grupos de 4 letras/dígitos (sin 0/1/8/9) separados por guiones. */
export function formatRecoveryKey(bytes: Uint8Array): string {
  return b32Encode(bytes).match(/.{1,4}/g)!.join("-");
}

export function parseRecoveryKey(text: string): Uint8Array {
  const normalized = text.toUpperCase().replace(/[^A-Z2-7]/g, "").replaceAll("0", "O").replaceAll("1", "I").replaceAll("8", "B");
  const bytes = b32Decode(normalized);
  if (bytes.length < 32) throw new Error("Clave de recuperación incompleta");
  return bytes.slice(0, 32);
}

export function recoveryVerifier(recoveryKey: Uint8Array): string {
  const authKey = hkdf(sha256, recoveryKey, undefined, utf8("kofre-recovery-auth-v1"), 32);
  return bytesToHex(sha256(authKey));
}

async function argonMaster(password: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  const hash = await argon2id({
    password,
    salt,
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memorySize,
    hashLength: kdf.hashLength,
    outputType: "binary",
  });
  return new Uint8Array(hash);
}

export async function deriveKeys(password: string, salt: Uint8Array, kdf: KdfParams = DEFAULT_KDF) {
  if (!isValidKdfParams(kdf)) throw new Error("Parámetros KDF fuera de rango");
  const master = await argonMaster(password, salt, kdf);
  const authKey = hkdf(sha256, master, salt, utf8("kofre-auth-v1"), 32);
  const wrapKey = hkdf(sha256, master, salt, utf8("kofre-wrap-v1"), 32);
  const authVerifier = bytesToHex(sha256(authKey));
  master.fill(0);
  return { authKey, wrapKey, authVerifier };
}

function sealSymmetric(
  key: Uint8Array,
  plaintext: Uint8Array,
  type: number,
  aad: Uint8Array,
  nonce = randomBytes(24),
): string {
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return bytesToB64(concat(Uint8Array.of(FORMAT_VERSION, type), nonce, ciphertext));
}

function openSymmetric(key: Uint8Array, blob: string, type: number, aad: Uint8Array): Uint8Array {
  const raw = b64ToBytes(blob);
  if (raw[0] !== FORMAT_VERSION || raw[1] !== type) {
    throw new Error("Formato de blob no reconocido");
  }
  const nonce = raw.slice(2, 26);
  const ciphertext = raw.slice(26);
  return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}

export function wrapPrivateKey(wrapKey: Uint8Array, privateKey: Uint8Array, nonce?: Uint8Array): string {
  return sealSymmetric(wrapKey, privateKey, TYPE_WRAPPED_PRIV, AAD_WRAP, nonce);
}

export function unwrapPrivateKey(wrapKey: Uint8Array, blob: string): Uint8Array {
  return openSymmetric(wrapKey, blob, TYPE_WRAPPED_PRIV, AAD_WRAP);
}

export function wrapWithRecovery(recoveryKey: Uint8Array, privateKey: Uint8Array, nonce?: Uint8Array): string {
  return sealSymmetric(recoveryKey, privateKey, TYPE_RECOVERY, AAD_RECOVERY, nonce);
}

export function unwrapWithRecovery(recoveryKey: Uint8Array, blob: string): Uint8Array {
  return openSymmetric(recoveryKey, blob, TYPE_RECOVERY, AAD_RECOVERY);
}

export function fingerprint(publicKey: Uint8Array): string {
  const hex = bytesToHex(sha256(publicKey)).slice(0, 16);
  return hex.match(/.{4}/g)?.join(" ") ?? hex;
}

/** Sal nueva + verificador + clave privada envuelta para una contraseña. Sirve para alta y para cambio de contraseña. */
export async function createPasswordMaterial(
  password: string,
  privateKey: Uint8Array,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<PasswordMaterial> {
  const salt = randomBytes(16);
  const { wrapKey, authVerifier } = await deriveKeys(password, salt, kdf);
  const wrappedPrivateKey = wrapPrivateKey(wrapKey, privateKey);
  wrapKey.fill(0);
  return { salt: bytesToB64(salt), kdfParams: kdf, authVerifier, wrappedPrivateKey };
}

export type RecoveryMaterial = { recoveryKey: string; recoveryVerifier: string; recoveryWrap: string };

/** Clave de recuperación nueva para una clave privada: en el alta y tras cada recuperación. */
export function createRecoveryMaterial(privateKey: Uint8Array): RecoveryMaterial {
  const recoveryKey = randomBytes(32);
  return {
    recoveryKey: formatRecoveryKey(recoveryKey),
    recoveryVerifier: recoveryVerifier(recoveryKey),
    recoveryWrap: wrapWithRecovery(recoveryKey, privateKey),
  };
}

export async function createAccountMaterial(password: string, kdf: KdfParams = DEFAULT_KDF): Promise<AccountMaterial> {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  const passwordMaterial = await createPasswordMaterial(password, privateKey, kdf);
  return {
    ...passwordMaterial,
    publicKey: bytesToB64(publicKey),
    ...createRecoveryMaterial(privateKey),
  };
}

export async function unlockAccount(
  password: string,
  saltB64: string,
  wrappedPrivateKey: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<UnlockedAccount> {
  const salt = b64ToBytes(saltB64);
  const { wrapKey, authVerifier } = await deriveKeys(password, salt, kdf);
  const privateKey = unwrapPrivateKey(wrapKey, wrappedPrivateKey);
  wrapKey.fill(0);
  return { authVerifier, privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function unlockWithRecoveryKey(recoveryKeyText: string, recoveryWrap: string): UnlockedAccount {
  const recoveryKey = parseRecoveryKey(recoveryKeyText);
  const privateKey = unwrapWithRecovery(recoveryKey, recoveryWrap);
  return { authVerifier: "", privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function generateEnvKey(): Uint8Array {
  return randomBytes(32);
}

// ── Tokens de servicio ─────────────────────────────────────────────────────
// `kofre_st_<id>.<secreto>`: el secreto deriva una clave X25519 a la que se sellan las claves de ambiente.
// El servidor guarda solo sha256(secreto) y la clave pública; nunca ve el secreto ni puede abrir nada.
// El punto separa porque ni el id (cuid) ni el secreto (base64url) lo contienen.

const SERVICE_TOKEN_PREFIX = "kofre_st_";

export type ServiceTokenMaterial = { secret: Uint8Array; secretHash: string; privateKey: Uint8Array; publicKey: string };

export function serviceTokenKeys(secret: Uint8Array): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = hkdf(sha256, secret, undefined, utf8("kofre-st-key-v1"), 32);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function createServiceTokenMaterial(): ServiceTokenMaterial {
  const secret = randomBytes(32);
  const keys = serviceTokenKeys(secret);
  return { secret, secretHash: bytesToHex(sha256(secret)), privateKey: keys.privateKey, publicKey: bytesToB64(keys.publicKey) };
}

export function formatServiceToken(id: string, secret: Uint8Array): string {
  return `${SERVICE_TOKEN_PREFIX}${id}.${bytesToB64(secret)}`;
}

export function isServiceToken(text: string): boolean {
  return text.startsWith(SERVICE_TOKEN_PREFIX);
}

export function parseServiceToken(text: string): { id: string; secret: Uint8Array; secretHash: string } {
  if (!isServiceToken(text)) throw new Error("Token de servicio no válido");
  const body = text.slice(SERVICE_TOKEN_PREFIX.length);
  const split = body.indexOf(".");
  if (split <= 0) throw new Error("Token de servicio no válido");
  const secret = b64ToBytes(body.slice(split + 1));
  if (secret.length !== 32) throw new Error("Token de servicio no válido");
  return { id: body.slice(0, split), secret, secretHash: bytesToHex(sha256(secret)) };
}

export function sealEnvKeyForUser(envKey: Uint8Array, recipientPublicKey: Uint8Array): string {
  const ephemeralPrivate = randomBytes(32);
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  const shared = x25519.getSharedSecret(ephemeralPrivate, recipientPublicKey);
  const key = hkdf(sha256, shared, ephemeralPublic, utf8("kofre-seal-v1"), 32);
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce, AAD_SEAL).encrypt(envKey);
  return bytesToB64(concat(Uint8Array.of(FORMAT_VERSION, TYPE_ENV_KEY), ephemeralPublic, nonce, ciphertext));
}

export function openSealedEnvKey(blob: string, recipientPrivateKey: Uint8Array): Uint8Array {
  const raw = b64ToBytes(blob);
  if (raw[0] !== FORMAT_VERSION || raw[1] !== TYPE_ENV_KEY) {
    throw new Error("Formato de clave de ambiente no reconocido");
  }
  const ephemeralPublic = raw.slice(2, 34);
  const nonce = raw.slice(34, 58);
  const ciphertext = raw.slice(58);
  const shared = x25519.getSharedSecret(recipientPrivateKey, ephemeralPublic);
  const key = hkdf(sha256, shared, ephemeralPublic, utf8("kofre-seal-v1"), 32);
  return xchacha20poly1305(key, nonce, AAD_SEAL).decrypt(ciphertext);
}

export type SecretMeta = { projectId: string; environmentId: string; name: string; version: number };

export function secretAad(meta: SecretMeta): Uint8Array {
  return utf8(`kofre|secret|${meta.projectId}|${meta.environmentId}|${meta.name}|${meta.version}`);
}

/** La versión forma parte de la AAD: cifrar con la versión que se va a guardar, nunca con una por defecto. */
export function encryptSecret(envKey: Uint8Array, value: string, meta: SecretMeta): string {
  return sealSymmetric(envKey, utf8(value), TYPE_SECRET, secretAad(meta));
}

export function decryptSecret(envKey: Uint8Array, blob: string, meta: SecretMeta): string {
  const plain = openSymmetric(envKey, blob, TYPE_SECRET, secretAad(meta));
  return new TextDecoder().decode(plain);
}

/**
 * Caja sellada de libsodium (crypto_box_seal): lo que GitHub exige para los secretos de Actions. Formato
 * epk(32) ‖ secretbox(mac ‖ ct) con nonce = BLAKE2b-24(epk ‖ pk) y clave = HSalsa20(X25519(esk, pk), 0¹⁶).
 */
export function sealedBox(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  const ephemeralPrivate = randomBytes(32);
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  const shared = x25519.getSharedSecret(ephemeralPrivate, recipientPublicKey);
  const key = new Uint32Array(8);
  hsalsa(u32(utf8("expand 32-byte k")), u32(shared), u32(new Uint8Array(16)), key);
  const nonce = blake2b(concat(ephemeralPublic, recipientPublicKey), { dkLen: 24 });
  return concat(ephemeralPublic, xsalsa20poly1305(u8(key), nonce).encrypt(message));
}
