import { b64ToBytes, decryptSecret, encryptSecret, generateEnvKey, openSealedEnvKey, sealEnvKeyForUser, type EnvScope } from "@kofre/crypto";
import { api } from "./config";
import { verifyPrincipals, type Principal } from "./known-keys";

export type Member = { userId: string; email: string; publicKey: string; role: string };
export type ServiceTokenRow = {
  id: string;
  name: string;
  publicKey: string;
  active: boolean;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  environments: { id: string; slug: string }[];
};
type EnvRow = { id: string; slug: string; keyWraps: { ciphertext: string }[] };
type SecretRow = { id: string; name: string; ciphertext: string; version: number };

export function listMembers(projectId: string, token: string): Promise<Member[]> {
  return api<Member[]>(`/projects/${projectId}/members`, {}, token);
}

export function listTokens(projectId: string, token: string): Promise<ServiceTokenRow[]> {
  return api<ServiceTokenRow[]>(`/projects/${projectId}/tokens`, {}, token);
}

/** Claves de un ambiente nuevo selladas para cada miembro: nadie necesita la clave privada de nadie. */
export function wrapsForMembers(envKey: Uint8Array, members: Member[], scope: EnvScope) {
  return members.map((member) => ({ userId: member.userId, keyWrap: sealEnvKeyForUser(envKey, b64ToBytes(member.publicKey), scope) }));
}

export const memberPrincipals = (members: Member[]): Principal[] => members.map((m) => ({ kind: "user", id: m.userId, label: m.email, publicKey: m.publicKey }));
export const tokenPrincipals = (tokens: ServiceTokenRow[]): Principal[] => tokens.map((t) => ({ kind: "token", id: t.id, label: `token ${t.name}`, publicKey: t.publicKey }));

/**
 * Rota la clave de un ambiente: descifra con la actual, genera otra, recifra todo con versión + 1 y la sella
 * para los miembros `keep` y los tokens de servicio activos de ese ambiente. Se usa al quitar a un miembro;
 * la clave vieja que esa persona pudiera conservar deja de servir.
 */
export async function rotateEnvironment(projectId: string, env: EnvRow, privateKey: Uint8Array, keep: Member[], token: string, trust?: { self?: { userId: string; publicKey: string }; trustNew?: boolean }) {
  const wrap = env.keyWraps[0]?.ciphertext;
  if (!wrap) throw new Error(`No tienes la clave del ambiente ${env.slug}; pide a otro editor que haga la rotación.`);
  const scope: EnvScope = { projectId, slug: env.slug };
  const oldKey = openSealedEnvKey(wrap, privateKey, scope);
  const newKey = generateEnvKey();
  const [rows, tokens] = await Promise.all([api<SecretRow[]>(`/environments/${env.id}/secrets`, {}, token), listTokens(projectId, token)]);
  const activeTokens = tokens.filter((item) => item.active && item.environments.some((item2) => item2.id === env.id));
  // Las claves públicas vienen del servidor: solo se sella para las que el usuario ya confirmó (o confirma ahora).
  await verifyPrincipals([...memberPrincipals(keep), ...tokenPrincipals(activeTokens)], trust ?? {});
  const secrets = rows.map((row) => {
    const meta = { projectId, environmentId: env.id, name: row.name };
    const plain = decryptSecret(oldKey, row.ciphertext, { ...meta, version: row.version });
    return { id: row.id, version: row.version + 1, ciphertext: encryptSecret(newKey, plain, { ...meta, version: row.version + 1 }) };
  });
  const tokenWraps = activeTokens.map((item) => ({ serviceTokenId: item.id, keyWrap: sealEnvKeyForUser(newKey, b64ToBytes(item.publicKey), scope) }));
  await api(
    `/environments/${env.id}/rotate`,
    { method: "POST", body: JSON.stringify({ secrets, keyWraps: [...wrapsForMembers(newKey, keep, scope), ...tokenWraps] }) },
    token,
  );
  return rows.map((row) => row.name);
}
