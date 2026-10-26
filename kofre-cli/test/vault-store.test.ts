import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("vault-store (archivo)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kofre-vault-"));
    process.env.KOFRE_HOME = home;
    process.env.KOFRE_VAULT_FILE = "1";
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.KOFRE_HOME;
    delete process.env.KOFRE_VAULT_FILE;
    delete process.env.KOFRE_VAULT_TTL_MIN;
    vi.useRealTimers();
  });

  it("guarda con vencimiento y lo respeta", async () => {
    process.env.KOFRE_VAULT_TTL_MIN = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
    const store = await import("../src/vault-store");
    expect(store.readVaultKey()).toBeNull();
    store.writeVaultKey("c2VjcmV0");
    expect(store.readVaultKey()).toBe("c2VjcmV0");
    expect(readFileSync(join(home, "vault.key"), "utf8")).toContain('"exp"');

    vi.setSystemTime(new Date("2026-10-20T10:02:00Z"));
    expect(store.readVaultKey()).toBeNull();
    expect(() => readFileSync(join(home, "vault.key"))).toThrow();
  });

  it("limpia sin fallar aunque no haya nada", async () => {
    const store = await import("../src/vault-store");
    expect(() => store.clearVaultKey()).not.toThrow();
  });
});

describe.runIf(process.platform === "win32")("vault-store (DPAPI en Windows)", () => {
  it("cifra con la cuenta de Windows y recupera", async () => {
    process.env.KOFRE_HOME = mkdtempSync(join(tmpdir(), "kofre-dpapi-"));
    delete process.env.KOFRE_VAULT_FILE;
    vi.resetModules();
    const store = await import("../src/vault-store");
    store.writeVaultKey("c2VjcmV0LWRwYXBp");
    const onDisk = readFileSync(join(process.env.KOFRE_HOME, "vault.dpapi"), "utf8");
    expect(onDisk).not.toContain("c2VjcmV0LWRwYXBp");
    expect(store.readVaultKey()).toBe("c2VjcmV0LWRwYXBp");
    store.clearVaultKey();
    expect(store.readVaultKey()).toBeNull();
    delete process.env.KOFRE_HOME;
  }, 30_000);
});
