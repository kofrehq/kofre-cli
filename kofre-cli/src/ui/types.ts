/**
 * Lo que `kofre ui` recibe de la CLI. La interfaz es un lanzador: ayuda a elegir un comando y sus opciones, lo ejecuta
 * con `run` y muestra su salida y sus preguntas en pantalla. Nunca recibe claves ni valores de secretos.
 */
export type UiProjectSummary = { id: string; name: string };
export type UiProject = UiProjectSummary & { environments: { slug: string; name: string }[] };

/** Sesión y carpeta en este momento: cambian tras login, logout o init. */
export type UiSnapshot = {
  /** null sin sesión: solo se ofrece iniciar sesión. */
  email: string | null;
  /** Proyecto vinculado a la carpeta actual (.kofre.toml), si lo hay. */
  linked: { projectId: string; defaultEnv: string } | null;
};

/** Con options, la pregunta es elegir una (selector con flechas); la respuesta es el value elegido. */
export type UiQuestion = { label: string; hidden: boolean; options?: { label: string; value: string }[] };

/** Cómo un comando en marcha habla con la interfaz. */
export type UiRunIo = {
  output(text: string): void;
  ask(question: UiQuestion): Promise<string | null>;
};

export type UiRun = { done: Promise<number>; cancel(): void };

export type UiClient = UiSnapshot & {
  version: string;
  snapshot(): UiSnapshot;
  listProjects(): Promise<UiProjectSummary[]>;
  getProject(projectId: string): Promise<UiProject>;
  listMembers(projectId: string): Promise<{ email: string; role: string }[]>;
  listTokens(projectId: string): Promise<{ id: string; name: string; active: boolean; environments: { slug: string }[] }[]>;
  run(argv: string[], io: UiRunIo): UiRun;
};

export type UiModule = { runUi(client: UiClient): Promise<void> };
