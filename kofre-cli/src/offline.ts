import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ponytail: copia local del último pull (todo ciphertext) para trabajar sin red. Sin invalidación: la próxima
// lectura con red la sobrescribe. Si hace falta control fino, añadir ETag por ambiente.

export type CachedEnvironment = {
  savedAt: string;
  project: { id: string; name: string };
  environment: { id: string; slug: string; name: string; keyWraps: { ciphertext: string }[] };
  rows: { id: string; name: string; ciphertext: string; version: number }[];
};

function cacheDir(): string {
  const home = process.env.KOFRE_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".kofre");
  return join(home, "cache");
}

function cachePath(projectId: string, slug: string): string {
  // Los dos vienen del servidor: solo caracteres de id y slug, nunca una ruta.
  if (!/^[a-z0-9]{1,40}$/i.test(projectId) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) throw new Error("Nombre de proyecto o ambiente no válido para la caché");
  return join(cacheDir(), `${projectId}-${slug}.json`);
}

export function saveCache(entry: Omit<CachedEnvironment, "savedAt">) {
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(cachePath(entry.project.id, entry.environment.slug), JSON.stringify({ ...entry, savedAt: new Date().toISOString() }), {
    mode: 0o600,
  });
}

export function readCache(projectId: string, slug: string): CachedEnvironment | null {
  const path = cachePath(projectId, slug);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as CachedEnvironment;
}

/** fetch falla con TypeError cuando no hay red o el servidor no responde; cualquier otro error es de la API. */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}
