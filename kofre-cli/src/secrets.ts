import { decryptSecret, encryptSecret, openSealedEnvKey } from "@kofre/crypto";
import { ApiError, api, requireSession, vaultKey } from "./config";
import { readTomlProject } from "./envfile";
import { isNetworkError, readCache, saveCache } from "./offline";

export type EnvironmentRow = {
  id: string;
  slug: string;
  name: string;
  keyWraps: { ciphertext: string }[];
};

export type ProjectRow = {
  id: string;
  name: string;
  environments: EnvironmentRow[];
};

export type SecretRow = {
  id: string;
  name: string;
  ciphertext: string;
  version: number;
};
export async function loadProject(): Promise<ProjectRow> {
  const linked = readTomlProject();
  if (!linked) throw new Error("No hay .kofre.toml. Ejecuta `kofre init --project <id>`.");
  const session = requireSession();
  return api<ProjectRow>(`/projects/${linked.projectId}`, {}, session.token);
}

export async function environmentFor(slug?: string) {
  const linked = readTomlProject();
  const project = await loadProject();
  const chosen = slug ?? linked?.defaultEnv ?? "dev";
  const environment = project.environments.find((env) => env.slug === chosen);
  if (!environment) throw new Error(`No existe el ambiente ${chosen}`);
  return { project, environment };
}

export async function envKeyFor(environment: EnvironmentRow): Promise<Uint8Array> {
  const wrap = environment.keyWraps[0]?.ciphertext;
  if (!wrap) throw new Error("Este ambiente no tiene clave envuelta para tu usuario.");
  return openSealedEnvKey(wrap, await vaultKey());
}

/** Cifra cada valor con la versión que se va a guardar (actual + 1); el servidor rechaza escrituras obsoletas. */
/** Solo sube lo que cambió: un valor idéntico al actual no crea otra versión en el historial. */
export async function writeSecrets(values: Record<string, string>, slug?: string): Promise<{ changed: number; unchanged: number }> {
  const session = requireSession();
  const { project, environment } = await environmentFor(slug);
  const key = await envKeyFor(environment);
  const current = new Map(
    (await api<SecretRow[]>(`/environments/${environment.id}/secrets`, {}, session.token)).map((row) => [row.name, row]),
  );
  let changed = 0;
  let unchanged = 0;
  for (const [name, value] of Object.entries(values)) {
    const existing = current.get(name);
    if (existing && sameSecret(key, existing, value, { projectId: project.id, environmentId: environment.id })) {
      unchanged += 1;
      continue;
    }
    const version = (existing?.version ?? 0) + 1;
    const ciphertext = encryptSecret(key, value, { projectId: project.id, environmentId: environment.id, name, version });
    try {
      await api(
        `/environments/${environment.id}/secrets`,
        { method: "PUT", body: JSON.stringify({ name, ciphertext, version }) },
        session.token,
      );
      changed += 1;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        throw new Error(`${name} cambió en el servidor mientras subías. Vuelve a ejecutar el comando.`);
      }
      throw error;
    }
  }
  return { changed, unchanged };
}

function sameSecret(
  key: Uint8Array,
  row: SecretRow,
  value: string,
  where: { projectId: string; environmentId: string },
): boolean {
  try {
    return decryptSecret(key, row.ciphertext, { ...where, name: row.name, version: row.version }) === value;
  } catch {
    return false; // Si no se puede descifrar, se sube una versión nueva que sí se pueda.
  }
}

/** Con red, lee y refresca la copia local; sin red, usa la última copia (todo ciphertext) y avisa. */
export async function readSecrets(
  slug?: string,
): Promise<{ project: ProjectRow; environment: EnvironmentRow; values: Record<string, string> }> {
  const session = requireSession();
  let project: ProjectRow;
  let environment: EnvironmentRow;
  let rows: SecretRow[];
  try {
    ({ project, environment } = await environmentFor(slug));
    rows = await api<SecretRow[]>(`/environments/${environment.id}/secrets`, {}, session.token);
    saveCache({ project: { id: project.id, name: project.name }, environment, rows });
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    const linked = readTomlProject();
    const cached = linked ? readCache(linked.projectId, slug ?? linked.defaultEnv) : null;
    if (!cached) throw new Error("Sin conexión con la API y sin copia local de este ambiente.");
    console.error(`Sin conexión: usando la copia local del ${cached.savedAt}.`);
    project = { ...cached.project, environments: [cached.environment] };
    environment = cached.environment;
    rows = cached.rows;
  }
  const key = await envKeyFor(environment);
  const values: Record<string, string> = {};
  for (const row of rows) {
    values[row.name] = decryptSecret(key, row.ciphertext, {
      projectId: project.id,
      environmentId: environment.id,
      name: row.name,
      version: row.version,
    });
  }
  return { project, environment, values };
}
