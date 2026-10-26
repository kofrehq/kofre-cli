import { b64ToBytes, decryptSecret, encryptSecret, generateEnvKey, openSealedEnvKey, sealEnvKeyForUser } from "@kofre/crypto";
import { api } from "./config";

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
export function wrapsForMembers(envKey: Uint8Array, members: Member[]) {
  return members.map((member) => ({ userId: member.userId, keyWrap: sealEnvKeyForUser(envKey, b64ToBytes(member.publicKey)) }));
}

/**
 * Rota la clave de un ambiente: descifra con la actual, genera otra, recifra todo con versión + 1 y la sella
 * para los miembros `keep` y los tokens de servicio activos de ese ambiente. Se usa al quitar a un miembro;
 * la clave vieja que esa persona pudiera conservar deja de servir.
 */
export async function rotateEnvironment(projectId: string, env: EnvRow, privateKey: Uint8Array, keep: Member[], token: string) {
  const wrap = env.keyWraps[0]?.ciphertext;
  if (!wrap) throw new Error(`No tienes la clave del ambiente ${env.slug}; pide a otro editor que haga la rotación.`);
  const oldKey = openSealedEnvKey(wrap, privateKey);
  const newKey = generateEnvKey();
  const [rows, tokens] = await Promise.all([api<SecretRow[]>(`/environments/${env.id}/secrets`, {}, token), listTokens(projectId, token)]);
  const secrets = rows.map((row) => {
    const meta = { projectId, environmentId: env.id, name: row.name };
    const plain = decryptSecret(oldKey, row.ciphertext, { ...meta, version: row.version });
    return { id: row.id, version: row.version + 1, ciphertext: encryptSecret(newKey, plain, { ...meta, version: row.version + 1 }) };
  });
  const tokenWraps = tokens
    .filter((item) => item.active && item.environments.some((scope) => scope.id === env.id))
    .map((item) => ({ serviceTokenId: item.id, keyWrap: sealEnvKeyForUser(newKey, b64ToBytes(item.publicKey)) }));
  await api(
    `/environments/${env.id}/rotate`,
    { method: "POST", body: JSON.stringify({ secrets, keyWraps: [...wrapsForMembers(newKey, keep), ...tokenWraps] }) },
    token,
  );
  return rows.map((row) => row.name);
}
