import { describe, expect, it } from "vitest";
import {
  DEFAULT_KDF,
  b64ToBytes,
  bytesToB64,
  createAccountMaterial,
  createPasswordMaterial,
  decryptSecret,
  deriveKeys,
  encryptSecret,
  fingerprint,
  formatRecoveryKey,
  generateEnvKey,
  isValidKdfParams,
  openSealedEnvKey,
  parseRecoveryKey,
  recoveryVerifier,
  sealEnvKeyForUser,
  isLegacyEnvKeyWrap,
  publicKeyOf,
  unlockAccount,
  unlockWithRecoveryKey,
  unwrapPrivateKey,
  unwrapWithRecovery,
  wrapPrivateKey,
  wrapWithRecovery,
} from "../src/index";

const SALT = new Uint8Array(16).fill(7);
const PRIV = new Uint8Array(32).fill(9);
const NONCE = new Uint8Array(24).fill(1);
const RECOVERY = new Uint8Array(32).fill(3);

// Vectores fijos: si cambian, el formato dejó de ser compatible con cuentas existentes.
// Se calcularon con los parámetros KDF de la primera versión (8 MiB); el valor por defecto actual es mayor.
const VECTOR_KDF = { memorySize: 8192, iterations: 2, parallelism: 1, hashLength: 32 };
const VECTORS = {
  authVerifier: "6dd07e83fd9ba6bc7624e4958ec17761005f4880f28949c2a1e28cf5e53dad16",
  wrapKeyHex: "4efbd2ecb66aa4584226012d16c1d5c1c433dd03df4c25983036e3c37cf999ae",
  wrapped: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEtf_9ig1tiM8UN56uv7Z_vwrhoWW0zqhJ0mj9U5bvoEskKgD7vHTxXsp-4j_sKrZY",
  recoveryWrap: "AQQBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH9mRs0tAvEVLQCeWc2QHkGaynkptTos4-JxaMu2a3fWMsZilgYqshOkXrtXZv828Y",
  recoveryText: "AMBQ-GAYD-AMBQ-GAYD-AMBQ-GAYD-AMBQ-GAYD-AMBQ-GAYD-AMBQ-GAYD-AMBQ",
  recoveryVerifier: "d50ef4e199c3db2dc4d74a4e2910ba7100d44d1c5a4680303156e9b838b64836",
  fingerprint: "8c0c c17a 0494 2cc4",
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function flipByte(blob: string, index: number): string {
  const raw = b64ToBytes(blob);
  raw[index] ^= 0x01;
  return bytesToB64(raw);
}

describe("vectores fijos", () => {
  it("deriva las mismas claves que la versión publicada", async () => {
    const keys = await deriveKeys("correct horse", SALT, VECTOR_KDF);
    expect(keys.authVerifier).toBe(VECTORS.authVerifier);
    expect(hex(keys.wrapKey)).toBe(VECTORS.wrapKeyHex);
  });

  it("usa el mínimo OWASP por defecto sin bajar el rango aceptado", () => {
    expect(DEFAULT_KDF).toEqual({ memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32 });
    expect(isValidKdfParams(VECTOR_KDF)).toBe(true);
  });

  it("envuelve y recupera con nonce fijo", async () => {
    const { wrapKey } = await deriveKeys("correct horse", SALT, VECTOR_KDF);
    expect(wrapPrivateKey(wrapKey, PRIV, NONCE)).toBe(VECTORS.wrapped);
    expect(same(unwrapPrivateKey(wrapKey, VECTORS.wrapped), PRIV)).toBe(true);
    expect(wrapWithRecovery(RECOVERY, PRIV, NONCE)).toBe(VECTORS.recoveryWrap);
    expect(same(unwrapWithRecovery(RECOVERY, VECTORS.recoveryWrap), PRIV)).toBe(true);
  });

  it("formatea la clave de recuperación y su verificador", () => {
    expect(formatRecoveryKey(RECOVERY)).toBe(VECTORS.recoveryText);
    expect(recoveryVerifier(RECOVERY)).toBe(VECTORS.recoveryVerifier);
    expect(fingerprint(PRIV)).toBe(VECTORS.fingerprint);
  });
});

describe("parámetros KDF", () => {
  it("acepta los valores por defecto y rechaza fuera de rango", () => {
    expect(isValidKdfParams(DEFAULT_KDF)).toBe(true);
    expect(isValidKdfParams({ ...DEFAULT_KDF, memorySize: 1024 })).toBe(false);
    expect(isValidKdfParams({ ...DEFAULT_KDF, iterations: 0 })).toBe(false);
    expect(isValidKdfParams({ ...DEFAULT_KDF, hashLength: 16 })).toBe(false);
    expect(isValidKdfParams(null)).toBe(false);
  });

  it("parámetros distintos producen claves distintas y viajan con la cuenta", async () => {
    const stronger = { ...DEFAULT_KDF, iterations: 3 };
    const a = await deriveKeys("pw", SALT);
    const b = await deriveKeys("pw", SALT, stronger);
    expect(a.authVerifier).not.toBe(b.authVerifier);

    const account = await createAccountMaterial("pw", stronger);
    expect(account.kdfParams).toEqual(stronger);
    await expect(unlockAccount("pw", account.salt, account.wrappedPrivateKey)).rejects.toThrow();
    const unlocked = await unlockAccount("pw", account.salt, account.wrappedPrivateKey, stronger);
    expect(bytesToB64(unlocked.publicKey)).toBe(account.publicKey);
  });

  it("rechaza derivar con parámetros inválidos", async () => {
    await expect(deriveKeys("pw", SALT, { ...DEFAULT_KDF, memorySize: 1 })).rejects.toThrow();
  });
});

describe("cuenta", () => {
  it("alta, desbloqueo, recuperación y cambio de contraseña conservan la clave privada", async () => {
    const account = await createAccountMaterial("master-password");
    const unlocked = await unlockAccount("master-password", account.salt, account.wrappedPrivateKey, account.kdfParams);
    expect(unlocked.authVerifier).toBe(account.authVerifier);

    const recovered = unlockWithRecoveryKey(account.recoveryKey, account.recoveryWrap);
    expect(same(recovered.privateKey, unlocked.privateKey)).toBe(true);
    expect(recoveryVerifier(parseRecoveryKey(account.recoveryKey))).toBe(account.recoveryVerifier);

    const changed = await createPasswordMaterial("new-password", unlocked.privateKey);
    expect(changed.salt).not.toBe(account.salt);
    expect(changed.authVerifier).not.toBe(account.authVerifier);
    const reopened = await unlockAccount("new-password", changed.salt, changed.wrappedPrivateKey, changed.kdfParams);
    expect(same(reopened.privateKey, unlocked.privateKey)).toBe(true);
  });

  it("la clave de recuperación tolera minúsculas, espacios y 0/1 confundidos", () => {
    const text = formatRecoveryKey(RECOVERY);
    const sloppy = text.toLowerCase().replaceAll("-", " ").replaceAll("o", "0").replaceAll("i", "1");
    expect(same(parseRecoveryKey(sloppy), RECOVERY)).toBe(true);
    expect(() => parseRecoveryKey("AMBQ-GAYD")).toThrow();
  });

  it("rechaza la contraseña incorrecta y la clave de recuperación incorrecta", async () => {
    const account = await createAccountMaterial("master-password");
    await expect(unlockAccount("other-password", account.salt, account.wrappedPrivateKey, account.kdfParams)).rejects.toThrow();
    const other = formatRecoveryKey(new Uint8Array(32).fill(5));
    expect(() => unlockWithRecoveryKey(other, account.recoveryWrap)).toThrow();
  });
});

describe("tokens de servicio", () => {
  it("el token lleva id y secreto; el secreto deriva la clave y el hash identifica sin revelar", async () => {
    const { createServiceTokenMaterial, formatServiceToken, isServiceToken, parseServiceToken, serviceTokenKeys } = await import("../src/index");
    const material = createServiceTokenMaterial();
    const token = formatServiceToken("tok_abc", material.secret);
    expect(isServiceToken(token)).toBe(true);
    expect(token).toMatch(/^kofre_st_tok_abc\.[A-Za-z0-9_-]{43}$/);
    const parsed = parseServiceToken(token);
    expect(parsed.id).toBe("tok_abc");
    expect(parsed.secretHash).toBe(material.secretHash);
    expect(bytesToB64(serviceTokenKeys(parsed.secret).publicKey)).toBe(material.publicKey);

    const envKey = generateEnvKey();
    const sealed = sealEnvKeyForUser(envKey, b64ToBytes(material.publicKey));
    expect(same(openSealedEnvKey(sealed, serviceTokenKeys(parsed.secret).privateKey), envKey)).toBe(true);
    expect(() => parseServiceToken("kofre_st_x")).toThrow();
    expect(() => parseServiceToken("Bearer abc")).toThrow();
  });
});

describe("secretos", () => {
  const meta = { projectId: "proj_1", environmentId: "env_dev", name: "STRIPE_KEY", version: 1 };

  it("viaja cifrado a través de la clave de ambiente sellada", async () => {
    const account = await createAccountMaterial("master-password");
    const unlocked = await unlockAccount("master-password", account.salt, account.wrappedPrivateKey, account.kdfParams);
    const envKey = generateEnvKey();
    const sealed = sealEnvKeyForUser(envKey, unlocked.publicKey);
    const opened = openSealedEnvKey(sealed, unlocked.privateKey);
    expect(same(opened, envKey)).toBe(true);

    const blob = encryptSecret(envKey, "sk_live_example", meta);
    expect(blob.includes("sk_live_example")).toBe(false);
    expect(decryptSecret(opened, blob, meta)).toBe("sk_live_example");
  });

  it("la clave de ambiente sellada no se abre con otra clave privada", async () => {
    const a = await createAccountMaterial("a");
    const b = await createAccountMaterial("b");
    const ua = await unlockAccount("a", a.salt, a.wrappedPrivateKey, a.kdfParams);
    const ub = await unlockAccount("b", b.salt, b.wrappedPrivateKey, b.kdfParams);
    const sealed = sealEnvKeyForUser(generateEnvKey(), ua.publicKey);
    expect(() => openSealedEnvKey(sealed, ub.privateKey)).toThrow();
  });

  it("falla si cambian nombre, ambiente, proyecto o versión (AAD)", () => {
    const envKey = generateEnvKey();
    const blob = encryptSecret(envKey, "value", meta);
    expect(() => decryptSecret(envKey, blob, { ...meta, name: "OTHER" })).toThrow();
    expect(() => decryptSecret(envKey, blob, { ...meta, environmentId: "env_prod" })).toThrow();
    expect(() => decryptSecret(envKey, blob, { ...meta, projectId: "proj_2" })).toThrow();
    expect(() => decryptSecret(envKey, blob, { ...meta, version: 2 })).toThrow();
  });

  it("falla con un byte alterado en cabecera, nonce, cuerpo o etiqueta", () => {
    const envKey = generateEnvKey();
    const blob = encryptSecret(envKey, "value", meta);
    const length = b64ToBytes(blob).length;
    for (const index of [0, 1, 2, 26, length - 1]) {
      expect(() => decryptSecret(envKey, flipByte(blob, index), meta)).toThrow();
    }
  });

  it("falla con otra clave de ambiente y con un tipo de blob distinto", async () => {
    const envKey = generateEnvKey();
    const blob = encryptSecret(envKey, "value", meta);
    expect(() => decryptSecret(generateEnvKey(), blob, meta)).toThrow();
    const wrapped = wrapPrivateKey(envKey, PRIV);
    expect(() => decryptSecret(envKey, wrapped, meta)).toThrow();
  });

  it("round-trip con valores vacíos, unicode y saltos de línea", () => {
    const envKey = generateEnvKey();
    for (const value of ["", "ñandú 🔐", "line1\nline2\r\n", "a".repeat(20000)]) {
      expect(decryptSecret(envKey, encryptSecret(envKey, value, meta), meta)).toBe(value);
    }
  });
});

describe("clave de ambiente ligada al proyecto y al ambiente", () => {
  it("el formato 2 solo abre con el mismo proyecto y slug; el formato 1 sigue abriendo sin ámbito", () => {
    const priv = new Uint8Array(32).map((_, i) => i + 1);
    const pub = publicKeyOf(priv);
    const envKey = generateEnvKey();
    const scope = { projectId: "p1", slug: "prod" };
    const sealed = sealEnvKeyForUser(envKey, pub, scope);
    expect(isLegacyEnvKeyWrap(sealed)).toBe(false);
    expect(Buffer.from(openSealedEnvKey(sealed, priv, scope)).equals(Buffer.from(envKey))).toBe(true);
    expect(() => openSealedEnvKey(sealed, priv, { projectId: "p1", slug: "dev" })).toThrow();
    expect(() => openSealedEnvKey(sealed, priv, { projectId: "p2", slug: "prod" })).toThrow();
    expect(() => openSealedEnvKey(sealed, priv)).toThrow(/ámbito/);
    const legacy = sealEnvKeyForUser(envKey, pub);
    expect(isLegacyEnvKeyWrap(legacy)).toBe(true);
    expect(Buffer.from(openSealedEnvKey(legacy, priv, scope)).equals(Buffer.from(envKey))).toBe(true);
    // Clave pública de orden bajo (todo ceros): se rechaza en vez de derivar una clave predecible.
    expect(() => sealEnvKeyForUser(envKey, new Uint8Array(32), scope)).toThrow();
  });
});
