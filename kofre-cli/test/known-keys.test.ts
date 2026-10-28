import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const home = mkdtempSync(join(tmpdir(), "kofre-keys-"));
const PK_A = Buffer.alloc(32, 1).toString("base64");
const PK_B = Buffer.alloc(32, 2).toString("base64");

beforeEach(() => {
  process.env.KOFRE_HOME = home;
  process.env.KOFRE_VAULT_FILE = "1";
});
afterEach(() => {
  delete process.env.KOFRE_HOME;
  delete process.env.KOFRE_VAULT_FILE;
});

describe("claves públicas confiadas (TOFU)", () => {
  it("fija una clave al confiar, acepta la misma después y se niega si cambia", async () => {
    const { verifyPrincipals, pinnedKey, forgetKey, listKeys } = await import("../src/known-keys");
    const ana = { kind: "user" as const, id: "u-ana", label: "ana@acme.dev", publicKey: PK_A };
    // Sin TTY y sin --yes, una clave nueva no se acepta sola.
    await expect(verifyPrincipals([ana])).rejects.toThrow(/Confírmala|--yes/);
    await verifyPrincipals([ana], { trustNew: true });
    expect(pinnedKey("user", "u-ana")).toBe(PK_A);
    await verifyPrincipals([ana]); // misma clave: pasa sin preguntar
    // El servidor devuelve otra clave para la misma persona: se aborta aunque se pase --yes.
    await expect(verifyPrincipals([{ ...ana, publicKey: PK_B }], { trustNew: true })).rejects.toThrow(/cambió/);
    expect(listKeys()).toEqual([{ kind: "user", id: "u-ana", fingerprint: expect.any(String) }]);
    expect(forgetKey("user", "u-ana")).toBe(true);
    await verifyPrincipals([{ ...ana, publicKey: PK_B }], { trustNew: true });
    expect(pinnedKey("user", "u-ana")).toBe(PK_B);
  });

  it("mi propia clave tiene que ser la que deriva de mi clave privada, no la que diga el servidor", async () => {
    const { verifyPrincipals } = await import("../src/known-keys");
    const me = { kind: "user" as const, id: "u-me", label: "yo", publicKey: PK_B };
    await expect(verifyPrincipals([me], { self: { userId: "u-me", publicKey: PK_A } })).rejects.toThrow(/comprometido/);
    await verifyPrincipals([me], { self: { userId: "u-me", publicKey: PK_B } });
  });
});

describe("desbloqueo por ambiente", () => {
  it("con solo dev desbloqueado, el MCP abre dev y rechaza prod pidiendo kofre unlock --env prod", async () => {
    const { writeEnvKeys, readVaultKey, clearVaultKey } = await import("../src/vault-store");
    const { handle } = await import("../src/mcp");
    const cwd = mkdtempSync(join(tmpdir(), "kofre-proj-"));
    writeFileSync(join(cwd, ".kofre.toml"), 'projectId = "p1"\ndefaultEnv = "dev"\n');
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      writeEnvKeys({ "p1:dev": Buffer.alloc(32, 7).toString("base64") });
      expect(readVaultKey()).toBeNull(); // la clave privada no está en el llavero
      const prod = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kofre_list", arguments: { env: "prod" } } }, "test");
      expect(prod).toMatchObject({ result: { isError: true } });
      expect(JSON.stringify(prod)).toMatch(/kofre unlock --env prod/);
      // dev sí pasa el candado (falla después por no haber sesión, que es otro mensaje).
      const devOpen = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kofre_list", arguments: { env: "dev" } } }, "test");
      expect(JSON.stringify(devOpen)).not.toMatch(/bloqueado/);
      clearVaultKey();
      const dev = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kofre_list", arguments: {} } }, "test");
      expect(JSON.stringify(dev)).toMatch(/kofre unlock --env dev/);
    } finally {
      process.chdir(previous);
    }
  });
});
