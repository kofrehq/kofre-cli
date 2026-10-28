import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64ToBytes, fingerprint } from "@kofre/crypto";
import { promptHidden } from "./prompt";

/*
 * Claves públicas conocidas (TOFU, "confía la primera vez"). El servidor es quien dice qué clave pública tiene cada
 * miembro o token; sin esto, un servidor comprometido podría sustituir una por la suya y recibir la clave del ambiente
 * en la siguiente rotación. Cada clave se fija la primera vez que el usuario la confirma por su huella; si después
 * cambia, la CLI se niega a sellar nada para ella hasta que el usuario la olvide a propósito (`kofre keys forget`).
 */

export type Principal = { kind: "user" | "token"; id: string; label: string; publicKey: string };
type Store = { users: Record<string, string>; tokens: Record<string, string> };

function home(): string {
  return process.env.KOFRE_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".kofre");
}
const storePath = () => join(home(), "known-keys.json");

function read(): Store {
  if (!existsSync(storePath())) return { users: {}, tokens: {} };
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8")) as Partial<Store>;
    return { users: parsed.users ?? {}, tokens: parsed.tokens ?? {} };
  } catch {
    return { users: {}, tokens: {} };
  }
}

function write(store: Store) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(storePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

const bucket = (store: Store, kind: Principal["kind"]) => (kind === "user" ? store.users : store.tokens);

export function pinnedKey(kind: Principal["kind"], id: string): string | undefined {
  return bucket(read(), kind)[id];
}

export function pinKey(kind: Principal["kind"], id: string, publicKey: string) {
  const store = read();
  bucket(store, kind)[id] = publicKey;
  write(store);
}

export function forgetKey(kind: Principal["kind"], id: string): boolean {
  const store = read();
  const had = id in bucket(store, kind);
  delete bucket(store, kind)[id];
  write(store);
  return had;
}

export function listKeys(): { kind: Principal["kind"]; id: string; fingerprint: string }[] {
  const store = read();
  return [
    ...Object.entries(store.users).map(([id, key]) => ({ kind: "user" as const, id, fingerprint: fingerprint(b64ToBytes(key)) })),
    ...Object.entries(store.tokens).map(([id, key]) => ({ kind: "token" as const, id, fingerprint: fingerprint(b64ToBytes(key)) })),
  ];
}

/**
 * Antes de sellar una clave de ambiente para estos principales: los fijados tienen que coincidir; los nuevos se muestran
 * con su huella y se confirman uno a uno (o se aceptan con `trustNew`, que es el `--yes` explícito del usuario).
 * `self` es la clave pública propia derivada de la clave privada: si el servidor dice otra para tu usuario, algo va mal.
 */
export async function verifyPrincipals(principals: Principal[], opts: { trustNew?: boolean; self?: { userId: string; publicKey: string } } = {}) {
  for (const principal of principals) {
    if (opts.self && principal.kind === "user" && principal.id === opts.self.userId) {
      if (principal.publicKey !== opts.self.publicKey) throw new Error("El servidor devuelve una clave pública para tu usuario que no es la tuya. No sigas: puede estar comprometido.");
      continue;
    }
    const pinned = pinnedKey(principal.kind, principal.id);
    const print = fingerprint(b64ToBytes(principal.publicKey));
    if (pinned === principal.publicKey) continue;
    if (pinned) {
      throw new Error(
        `La clave pública de ${principal.label} cambió.\n  antes: ${fingerprint(b64ToBytes(pinned))}\n  ahora: ${print}\n` +
          `Si esa persona no regeneró su cuenta, el servidor puede estar comprometido. Si es legítimo: kofre keys forget ${principal.id}`,
      );
    }
    if (!opts.trustNew) {
      if (!process.stdin.isTTY) throw new Error(`Clave pública nueva de ${principal.label} (huella ${print}). Confírmala en una terminal interactiva o repite con --yes.`);
      const answer = await promptHidden(`Clave nueva de ${principal.label}, huella ${print}. Confírmala por otro canal y escribe 'si'`);
      if (answer.trim().toLowerCase() !== "si") throw new Error("Cancelado.");
    }
    pinKey(principal.kind, principal.id, principal.publicKey);
  }
}
