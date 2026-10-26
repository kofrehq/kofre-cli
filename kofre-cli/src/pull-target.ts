import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "dotenv";
import { bodyFingerprint, bodyOf, gitignoreWarns, readKofreHeader } from "./envfile";
import { insideUi, promptChoice } from "./prompt";

export type TargetState =
  | { kind: "missing" }
  /** edited: alguien lo cambió a mano desde el último pull; changed: variables que difieren de Kofre. */
  | { kind: "ours"; edited: boolean; changed: string[] }
  | { kind: "foreign"; reason: string };

/**
 * Qué hay en el archivo de destino. "ours" es un .env que escribió Kofre para este mismo proyecto y ambiente. Que Kofre
 * tenga valores nuevos no es un cambio local: solo cuenta lo editado a mano, según la huella de la cabecera.
 */
export function inspectTarget(text: string | null, projectId: string, slug: string, remote: Record<string, string>): TargetState {
  if (text === null) return { kind: "missing" };
  const header = readKofreHeader(text);
  if (!header) return { kind: "foreign", reason: "no lo generó Kofre" };
  if (header.projectId !== projectId || header.slug !== slug) {
    return { kind: "foreign", reason: `lo generó Kofre para otro proyecto o ambiente (${header.slug})` };
  }
  const local = parse(text);
  const changed = Object.keys(local).filter((key) => local[key] !== remote[key]);
  // Sin huella (archivos de antes de 0.4.0) no se puede saber qué se editó: se usa la comparación con Kofre.
  const edited = header.hash ? bodyFingerprint(bodyOf(text)) !== header.hash : changed.length > 0;
  return { kind: "ours", edited, changed };
}

/** Qué cambiaría al escribir `remote` sobre `local`, solo por nombre (nunca valores): ~ distinto, + nueva, - quitada. */
export function diffEnv(local: Record<string, string>, remote: Record<string, string>): string[] {
  const changed = Object.keys(remote).filter((key) => key in local && local[key] !== remote[key]);
  const added = Object.keys(remote).filter((key) => !(key in local));
  const removed = Object.keys(local).filter((key) => !(key in remote));
  return [
    ...changed.map((key) => `~ ${key}   (valor nuevo)`),
    ...added.map((key) => `+ ${key}   (nueva)`),
    ...removed.map((key) => `- ${key}   (ya no está en Kofre)`),
  ];
}

/** .env → .env.<ambiente>; cualquier otro nombre → <nombre>.kofre. Nunca devuelve el mismo archivo. */
export function alternativeFor(target: string, slug: string): string {
  const name = basename(target);
  return join(dirname(target), name === ".env" ? `.env.${slug}` : `${name}.kofre`);
}

function backup(target: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  // Dos copias en el mismo segundo no se pisan: la segunda lleva -2, la tercera -3…
  let copy = `${target}.backup-${stamp}`;
  for (let n = 2; existsSync(copy); n += 1) copy = `${target}.backup-${stamp}-${n}`;
  copyFileSync(target, copy);
  // La copia puede llevar secretos igual que el original: que no acabe en git sin querer.
  const warning = gitignoreWarns(copy);
  if (warning) console.error(warning);
  return copy;
}

function replace(target: string, withBackup: boolean): string {
  if (withBackup) console.error(`Copia del anterior en ${backup(target)}.`);
  else console.error(`${target} reemplazado sin copia.`);
  return target;
}

// KOFRE_PROMPT=1 permite contestar por una tubería (scripts y tests); sin él, solo se pregunta en una terminal.
const interactive = () =>
  Boolean(process.env.KOFRE_PROMPT) || insideUi() || Boolean(process.stdin.isTTY && process.stderr.isTTY);

/**
 * Decide dónde escribe `kofre pull` sin perder nada sin querer: un archivo propio sin editar se actualiza; uno ajeno o
 * editado a mano nunca se reemplaza sin preguntar, y al reemplazar se elige si guardar copia. null si se cancela.
 */
export async function choosePullTarget(
  target: string,
  where: { projectId: string; slug: string; remote: Record<string, string> },
  options: { force: boolean; backup: boolean },
): Promise<string | null> {
  for (;;) {
    const text = existsSync(target) ? readFileSync(target, "utf8") : null;
    const state = inspectTarget(text, where.projectId, where.slug, where.remote);
    if (state.kind === "missing") return target;

    // Archivo propio sin tocar: si Kofre trae valores distintos, se dice cuáles y se pregunta por la copia.
    if (state.kind === "ours" && !state.edited) {
      const diff = diffEnv(parse(text ?? ""), where.remote);
      if (diff.length === 0) return target;
      const summary = `Kofre trae cambios para ${target}:\n${diff.map((line) => `  ${line}`).join("\n")}`;
      if (options.force) {
        console.error(summary);
        return replace(target, options.backup);
      }
      if (!interactive()) {
        // En scripts y CI se actualiza sin copia, para no acumular backups; queda constancia de qué cambió.
        console.error(summary);
        return target;
      }
      const keep = await promptChoice(`${summary}\n¿Guardar una copia del ${target} actual antes de actualizarlo?`, [
        { label: "Sí, guardar una copia (.backup-<fecha>)", value: "yes" },
        { label: "No, actualizar sin copia", value: "no" },
        { label: "Cancelar", value: "cancel" },
      ]);
      if (keep === "yes") console.error(`Copia del anterior en ${backup(target)}.`);
      return keep === "yes" || keep === "no" ? target : null;
    }

    const alt = alternativeFor(target, where.slug);
    const problem =
      state.kind === "ours"
        ? `${target} tiene cambios locales que no están en Kofre${state.changed.length ? `: ${state.changed.join(", ")}` : ""}`
        : `${target} ya existe y ${state.reason}`;

    if (options.force) {
      console.error(`${problem}.`);
      return replace(target, options.backup);
    }
    if (!interactive()) {
      throw new Error(
        `${problem}. No lo reemplazo sin preguntar: usa -o ${alt} para escribir en otro archivo, o --force para reemplazarlo dejando una copia (--force --no-backup, sin copia).`,
      );
    }

    // Primero qué hacer; con un archivo ajeno, lo primero es no tocarlo.
    const action = await promptChoice(`${problem}. ¿Qué hago?`, [
      ...(state.kind === "foreign" ? [{ label: `Escribir en ${alt} y no tocar ${target}`, value: "alt" }] : []),
      { label: `Reemplazar ${target}`, value: "replace" },
      { label: "Cancelar", value: "cancel" },
    ]);
    if (action === "alt") {
      target = alt; // Se vuelve a comprobar: el alternativo también podría existir.
      continue;
    }
    if (action !== "replace") return null;

    // Después, y siempre de forma explícita, si se guarda una copia del archivo que se va a reemplazar.
    const keep = await promptChoice(`¿Guardar una copia de ${target} antes de reemplazarlo?`, [
      { label: "Sí, guardar una copia (.backup-<fecha>)", value: "yes" },
      { label: "No, reemplazar sin copia", value: "no" },
    ]);
    if (keep === null) return null;
    return replace(target, keep === "yes");
  }
}
