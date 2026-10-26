import nacl from "tweetnacl";
import { blake2b } from "@noble/hashes/blake2b";
import { describe, expect, it } from "vitest";
import { sealedBox } from "../src/index";

describe("sealedBox", () => {
  it("lo abre NaCl con la clave del destinatario (mismo formato que libsodium crypto_box_seal)", () => {
    const recipient = nacl.box.keyPair();
    const message = new TextEncoder().encode("postgres://user:pw@host/db");
    const sealed = sealedBox(message, recipient.publicKey);
    expect(sealed.length).toBe(32 + 16 + message.length);
    const ephemeralPublic = sealed.slice(0, 32);
    const nonce = blake2b(new Uint8Array([...ephemeralPublic, ...recipient.publicKey]), { dkLen: 24 });
    const opened = nacl.box.open(sealed.slice(32), nonce, ephemeralPublic, recipient.secretKey);
    expect(opened && new TextDecoder().decode(opened)).toBe("postgres://user:pw@host/db");
    // Otra clave no lo abre y cada sellado usa una clave efímera distinta.
    expect(nacl.box.open(sealed.slice(32), nonce, ephemeralPublic, nacl.box.keyPair().secretKey)).toBeNull();
    expect(sealedBox(message, recipient.publicKey)).not.toEqual(sealed);
  });
});
