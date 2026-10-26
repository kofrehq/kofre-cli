import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { api, readSession, requireSession } from "./config";
import { DETACH_FOR_TREE_KILL, killTree } from "./kill-tree";
import { readTomlProject } from "./envfile";
import { listMembers, listTokens } from "./sharing";
import type { UiClient, UiModule, UiProject, UiQuestion, UiRun, UiRunIo, UiSnapshot } from "./ui/types";

type Sea = { isSea(): boolean; getAsset(key: string, encoding: string): string };

function sea(): Sea | null {
  try {
    const mod = require("node:sea") as Sea;
    return mod.isSea() ? mod : null;
  } catch {
    return null; // Node sin soporte SEA.
  }
}

/**
 * ui.mjs es ESM (Ink lo exige) y kofre.js es CommonJS. Con npm se importa el archivo de al lado; dentro del ejecutable
 * SEA va como asset y se importa desde memoria con una URL data:, sin escribir código en disco.
 */
async function loadUi(): Promise<UiModule> {
  // Con un especificador variable, esbuild deja import() nativo también en la salida CommonJS.
  const load = (specifier: string) => import(specifier) as Promise<UiModule>;
  const embedded = sea();
  if (embedded) {
    const source = embedded.getAsset("ui.mjs", "utf8");
    return load(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  }
  return load(pathToFileURL(join(__dirname, "ui.mjs")).href);
}

type PromptMessage = { type: "prompt"; id: number } & UiQuestion;

/**
 * Ejecuta un `kofre ...` real como proceso hijo para la interfaz: su salida llega por `io.output` y sus preguntas
 * (contraseña, confirmaciones, el menú de pull) por `io.ask`, a través del canal IPC (ver prompt.ts). `entry` es el
 * kofre.js a ejecutar; en el ejecutable SEA no hace falta. `cwd` y `env` solo los cambian los tests.
 */
export function spawnKofre(
  argv: string[],
  io: UiRunIo,
  options: { entry?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): UiRun {
  const entry = options.entry ?? (sea() ? undefined : process.argv[1]);
  const child = spawn(process.execPath, entry ? [entry, ...argv] : argv, {
    cwd: options.cwd,
    detached: DETACH_FOR_TREE_KILL,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...(options.env ?? process.env), KOFRE_UI_CHILD: "1", KOFRE_NO_UPDATE_CHECK: "1" },
  });
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => io.output(chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => io.output(chunk));
  child.on("message", (message: PromptMessage) => {
    if (message?.type !== "prompt") return;
    void io.ask({ label: message.label, hidden: message.hidden, options: message.options }).then((value) => {
      if (child.connected) child.send({ type: "answer", id: message.id, value: value ?? "", cancelled: value === null });
    });
  });
  const done = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      io.output(`${error.message}\n`);
      resolve(1);
    });
  });
  return { done, cancel: () => killTree(child) };
}

function snapshot(): UiSnapshot {
  const session = readSession() ?? (process.env.KOFRE_TOKEN ? requireSession() : null);
  return { email: session?.email ?? null, linked: readTomlProject() };
}

function makeClient(version: string): UiClient {
  const projects = new Map<string, Promise<UiProject>>();
  return {
    ...snapshot(),
    version,
    snapshot() {
      // Tras login, logout o init cambian la sesión y la carpeta; los proyectos se vuelven a pedir.
      projects.clear();
      return snapshot();
    },
    listProjects: () => api<{ id: string; name: string }[]>("/projects", {}, requireSession().token),
    getProject(projectId) {
      // El mismo proyecto se pide varias veces (cabecera, ambientes de cada comando): una sola llamada.
      if (!projects.has(projectId)) {
        const request = api<UiProject>(`/projects/${projectId}`, {}, requireSession().token);
        request.catch(() => projects.delete(projectId));
        projects.set(projectId, request);
      }
      return projects.get(projectId)!;
    },
    listMembers: (projectId) => listMembers(projectId, requireSession().token),
    listTokens: (projectId) => listTokens(projectId, requireSession().token),
    run: (argv, io) => spawnKofre(argv, io),
  };
}

export async function runUiCommand(version: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("kofre ui necesita una terminal interactiva. En scripts usa los comandos (kofre pull, kofre run…).");
  }
  const ui = await loadUi();
  await ui.runUi(makeClient(version));
}
