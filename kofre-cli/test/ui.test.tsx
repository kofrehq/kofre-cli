import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App, lineColor } from "../src/ui/app";
import { COMMANDS, blockedReason, preview } from "../src/ui/commands";
import type { UiClient, UiRunIo } from "../src/ui/types";

const KEYS = { down: "\u001B[B", right: "\u001B[C", enter: "\r" };
const SIZE = { columns: 100, rows: 34 };

// Espera a que el fotograma cumpla la condición en vez de dormir un tiempo fijo: la suite completa va más lenta.
async function until(frame: () => string, ok: (text: string) => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!ok(frame())) {
    if (Date.now() > end) throw new Error(`No apareció lo esperado. Último fotograma:\n${frame()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
// Ink registra el teclado justo después de pintar: se deja un instante, como haría una persona.
const press = async (stdin: { write(data: string): void }, data: string) => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  stdin.write(data);
};

const project = {
  id: "p1",
  name: "test_project",
  environments: [
    { slug: "dev", name: "dev" },
    { slug: "prod", name: "prod" },
  ],
};
type Script = (io: UiRunIo) => Promise<number>;
const client = (overrides: Partial<UiClient> = {}, script: Script = async () => 0) => {
  const runs: string[][] = [];
  const value: UiClient = {
    email: "erick@kofre.test",
    linked: { projectId: "p1", defaultEnv: "dev" },
    version: "0.4.0",
    snapshot: () => ({ email: value.email, linked: value.linked }),
    listProjects: async () => [{ id: "p1", name: "test_project" }],
    getProject: async () => project,
    listMembers: async () => [
      { email: "erick@kofre.test", role: "owner" },
      { email: "ana@empresa.dev", role: "reader" },
    ],
    listTokens: async () => [
      { id: "t1", name: "ci", active: true, environments: [{ slug: "dev" }, { slug: "prod" }] },
      { id: "t2", name: "viejo", active: false, environments: [{ slug: "dev" }] },
    ],
    run: (argv, io) => {
      runs.push(argv);
      return { done: script(io), cancel: () => {} };
    },
    ...overrides,
  };
  return { value, runs };
};

process.env.KOFRE_REDUCED_MOTION = "1";

describe("kofre ui", () => {
  it("cubre los comandos de la CLI y nunca ofrece ver valores", () => {
    const top = ["pull", "push", "set", "run", "history", "init", "login", "logout", "lock", "devices", "whoami"];
    for (const id of top) expect(COMMANDS.some((c) => c.id === id)).toBe(true);
    const sample = Object.fromEntries(["env", "name", "file", "output", "command", "project"].map((k) => [k, "x"]));
    for (const command of COMMANDS) expect(command.argv(sample)).not.toContain("--show");
  });

  it("bloquea lo que necesita sesión o carpeta vinculada y lo explica", () => {
    const pull = COMMANDS.find((c) => c.id === "pull")!;
    expect(blockedReason(pull, client({ email: null }).value)).toContain("inicia sesión");
    expect(blockedReason(pull, client({ linked: null }).value)).toContain("vincula esta carpeta");
    expect(blockedReason(pull, client().value)).toBeNull();
    expect(blockedReason(COMMANDS.find((c) => c.id === "login")!, client({ email: null }).value)).toBeNull();
  });

  it("ejecuta pull dentro de la interfaz y muestra su salida en el panel", async () => {
    const fake = client({}, async (io) => {
      io.output("Escrito .env (3 variables)\n");
      return 0;
    });
    const { lastFrame, stdin, unmount } = render(<App client={fake.value} size={SIZE} />);
    const frame = () => lastFrame() ?? "";

    await until(frame, (f) => f.includes("Carpeta: test_project · dev"));
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("Ambiente") && f.includes("prod"));
    await press(stdin, KEYS.enter); // dev, el ambiente de la carpeta
    await until(frame, (f) => f.includes("Archivo de salida"));
    await press(stdin, KEYS.enter); // .env
    await until(frame, (f) => f.includes("$ kofre pull --env dev -o .env"));
    await press(stdin, KEYS.enter);

    await until(frame, (f) => f.includes("Escrito .env (3 variables)") && f.includes("✓"));
    expect(fake.runs).toEqual([["pull", "--env", "dev", "-o", ".env"]]);
    await until(frame, (f) => f.includes("^   ^"));
    expect(frame()).toContain("¡Listo!");

    await press(stdin, KEYS.enter); // vuelve al menú
    await until(frame, (f) => f.includes("› Bajar un .env"));
    unmount();
  });

  it("las preguntas del comando aparecen en la interfaz y la contraseña no se ve", async () => {
    let answered: string | null = "";
    const fake = client({}, async (io) => {
      answered = await io.ask({ label: "Contraseña maestra", hidden: true });
      io.output("Bóveda bloqueada.\n");
      return 0;
    });
    const { lastFrame, stdin, unmount } = render(<App client={fake.value} size={SIZE} />);
    const frame = () => lastFrame() ?? "";
    await until(frame, (f) => f.includes("Carpeta: test_project"));
    // Sesión › Bloquear la bóveda: sin preguntas previas, va directo a confirmar. Sesión está a la izquierda de Secretos.
    await press(stdin, "\u001B[D");
    await until(frame, (f) => f.includes("[Sesión]"));
    for (let i = 0; i < 3; i++) await press(stdin, KEYS.down);
    await until(frame, (f) => f.includes("› Bloquear la bóveda"));
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("$ kofre lock"));
    await press(stdin, KEYS.enter);

    await until(frame, (f) => f.includes("Contraseña maestra"));
    for (const char of "secreto-123") await press(stdin, char);
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("Bóveda bloqueada."));
    expect(answered).toBe("secreto-123");
    expect(frame()).not.toContain("secreto-123");
    unmount();
  });

  it("los menús se eligen con flechas, un Enter de más no elige y lo respondido queda en la salida", async () => {
    const answers: (string | null)[] = [];
    // Igual que pull con un archivo editado: primero qué hacer y, si se reemplaza, si guardar copia.
    const fake = client({}, async (io) => {
      answers.push(
        await io.ask({
          label: ".env.dev tiene cambios locales que no están en Kofre: NEW_CLI_VAR. ¿Qué hago?",
          hidden: false,
          options: [
            { label: "Reemplazar .env.dev", value: "replace" },
            { label: "Cancelar", value: "cancel" },
          ],
        }),
      );
      answers.push(
        await io.ask({
          label: "¿Guardar una copia de .env.dev antes de reemplazarlo?",
          hidden: false,
          options: [
            { label: "Sí, guardar una copia (.backup-<fecha>)", value: "yes" },
            { label: "No, reemplazar sin copia", value: "no" },
          ],
        }),
      );
      io.output(".env.dev reemplazado sin copia.\n");
      return 0;
    });
    const { lastFrame, stdin, unmount } = render(<App client={fake.value} size={SIZE} />);
    const frame = () => lastFrame() ?? "";
    const armed = () => new Promise((resolve) => setTimeout(resolve, 450));
    await until(frame, (f) => f.includes("› Bajar un .env"));
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("Ambiente"));
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("Archivo de salida"));
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("Se ejecutará:"));
    await press(stdin, KEYS.enter);
    await press(stdin, KEYS.enter); // el Enter de más

    await until(frame, (f) => f.includes("❯ Reemplazar .env.dev"));
    expect(frame()).toContain("NEW_CLI_VAR");
    expect(frame()).toContain("↑↓ elegir · ⏎ confirmar · esc cancelar");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(answers).toEqual([]);

    await armed();
    await press(stdin, KEYS.enter); // Reemplazar
    await until(frame, (f) => f.includes("¿Guardar una copia de .env.dev antes de reemplazarlo?"));
    await armed();
    await press(stdin, KEYS.down);
    await until(frame, (f) => f.includes("❯ No, reemplazar sin copia"));
    await press(stdin, KEYS.enter);

    await until(frame, (f) => f.includes(".env.dev reemplazado sin copia."));
    expect(answers).toEqual(["replace", "no"]);
    expect(frame()).toContain("→ Reemplazar .env.dev");
    expect(frame()).toContain("? ¿Guardar una copia de .env.dev antes de reemplazarlo?");
    expect(frame()).toContain("→ No, reemplazar sin copia");
    unmount();
  });

  it("se adapta a la ventana sin pasarse nunca de ella", async () => {
    for (const size of [
      { columns: 120, rows: 40 },
      { columns: 100, rows: 34 },
      { columns: 70, rows: 22 },
      { columns: 44, rows: 20 },
      { columns: 178, rows: 9 }, // el panel de terminal de VS Code
      { columns: 60, rows: 10 },
      { columns: 48, rows: 8 },
    ]) {
      const { lastFrame, unmount } = render(<App client={client().value} size={size} />);
      await until(() => lastFrame() ?? "", (f) => f.includes("Bajar un .env"));
      const lines = (lastFrame() ?? "").split("\n");
      expect(lines.length, `${size.columns}×${size.rows}`).toBeLessThanOrEqual(size.rows);
      for (const line of lines) expect(line.length, `${size.columns}×${size.rows}: ${line}`).toBeLessThanOrEqual(size.columns);
      // El comando a ejecutar se ve siempre, aunque el panel sea muy bajo.
      expect(lastFrame(), `${size.columns}×${size.rows}`).toContain("$ kofre pull");
      // Ventanas bajas: Kofri en una línea.
      if (size.rows < 30) expect(lastFrame()).toContain("[●▾●]");
      unmount();
    }
    for (const size of [
      { columns: 40, rows: 7 },
      { columns: 45, rows: 12 }, // baja y estrecha: no caben lista y detalle
    ]) {
      const tiny = render(<App client={client().value} size={size} />);
      expect(tiny.lastFrame()).toContain("Agranda la ventana");
      tiny.unmount();
    }
  });

  it("se recalcula al cambiar el tamaño sin reiniciarse", async () => {
    const app = client().value;
    const { lastFrame, rerender, unmount } = render(<App client={app} size={{ columns: 178, rows: 6 }} />);
    expect(lastFrame()).toContain("Agranda la ventana");
    rerender(<App client={app} size={{ columns: 178, rows: 9 }} />);
    await until(() => lastFrame() ?? "", (f) => f.includes("Bajar un .env"));
    rerender(<App client={app} size={{ columns: 120, rows: 40 }} />);
    await until(() => lastFrame() ?? "", (f) => f.includes("╰─────────╯")); // Kofri grande
    expect((lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(40);
    unmount();
  });

  it("Sesión es la primera pestaña; sin sesión se abre ahí y con sesión en Secretos", async () => {
    const guest = render(<App client={client({ email: null, linked: null }).value} size={SIZE} />);
    await until(() => guest.lastFrame() ?? "", (f) => f.includes("› Iniciar sesión"));
    expect(guest.lastFrame()).toMatch(/\[Sesión\]\s+Secretos\s+Proyecto/);
    guest.unmount();

    const member = render(<App client={client().value} size={SIZE} />);
    await until(() => member.lastFrame() ?? "", (f) => f.includes("› Bajar un .env"));
    expect(member.lastFrame()).toMatch(/Sesión\s+\[Secretos\]\s+Proyecto/);
    member.unmount();
  });

  it("Eliminar a alguien elige entre los miembros reales, sin uno mismo", async () => {
    const remove = COMMANDS.find((c) => c.id === "members-remove")!;
    expect(remove.title).toBe("Eliminar a alguien");
    const field = remove.fields[0];
    if (field.kind !== "select") throw new Error("debería ser un selector");

    expect(await field.choices(client().value, {})).toEqual([{ label: "ana@empresa.dev · reader", value: "ana@empresa.dev" }]);
    expect(await field.choices(client({ listMembers: async () => [{ email: "erick@kofre.test", role: "owner" }] }).value, {})).toEqual([]);
    expect(remove.argv({ email: "ana@empresa.dev" })).toEqual(["members", "remove", "ana@empresa.dev"]);

    // En la interfaz: Equipo › Eliminar a alguien muestra a Ana y no al propio usuario.
    const { lastFrame, stdin, unmount } = render(<App client={client().value} size={SIZE} />);
    const frame = () => lastFrame() ?? "";
    await until(frame, (f) => f.includes("› Bajar un .env"));
    for (let i = 0; i < 3; i += 1) await press(stdin, "\u001B[C");
    await until(frame, (f) => f.includes("[Equipo]"));
    await press(stdin, KEYS.down);
    await press(stdin, KEYS.down);
    await until(frame, (f) => f.includes("› Eliminar a alguien"));
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("❯ ana@empresa.dev · reader"));
    expect(frame()).not.toContain("erick@kofre.test · owner");
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("$ kofre members remove ana@empresa.dev"));
    unmount();
  });

  it("Revocar un token elige entre los tokens activos", async () => {
    const revoke = COMMANDS.find((c) => c.id === "tokens-revoke")!;
    const field = revoke.fields[0];
    if (field.kind !== "select") throw new Error("debería ser un selector");
    expect(await field.choices(client().value, {})).toEqual([{ label: "ci · dev,prod", value: "t1" }]);
    expect(await field.choices(client({ listTokens: async () => [] }).value, {})).toEqual([]);
    expect(revoke.argv({ id: "t1" })).toEqual(["tokens", "revoke", "t1"]);

    // En la interfaz: buscar "revocar", elegir el token y ver el comando que se va a lanzar.
    const { lastFrame, stdin, unmount } = render(<App client={client().value} size={SIZE} />);
    const frame = () => lastFrame() ?? "";
    await until(frame, (f) => f.includes("› Bajar un .env"));
    await press(stdin, "/");
    for (const char of "revocar") await press(stdin, char);
    await until(frame, (f) => f.includes("› Revocar un token"));
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("❯ ci · dev,prod"));
    expect(frame()).not.toContain("viejo");
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("$ kofre tokens revoke t1"));
    unmount();
  });

  it("con un comando que no termina: desplazar, seguir, buscar, reiniciar y salir matándolo", async () => {
    // Como `kofre run -- pnpm dev`: escribe y no acaba hasta que se le detiene.
    const runs: string[][] = [];
    let cancels = 0;
    let io: UiRunIo | null = null;
    const fake = client({
      run: (argv, runIo) => {
        runs.push(argv);
        io = runIo;
        for (let i = 0; i < 60; i++) {
          runIo.output(i === 30 ? "kofre-api dev: Error: listen EADDRINUSE: address already in use :::3001\n" : `linea ${i}\n`);
        }
        let finish: (code: number) => void = () => {};
        const done = new Promise<number>((resolve) => (finish = resolve));
        return { done, cancel: () => (cancels++, finish(1)) };
      },
    }).value;
    const { lastFrame, stdin, unmount } = render(<App client={fake} size={SIZE} />);
    const frame = () => lastFrame() ?? "";
    await until(frame, (f) => f.includes("Carpeta: test_project · dev"));
    for (let i = 0; i < 4; i++) await press(stdin, KEYS.enter); // pull: dev, .env, ejecutar
    await until(frame, (f) => f.includes("linea 59"));
    expect(frame()).toContain("esc detener");

    // Subir mientras corre: lo nuevo no mueve la vista, y Fin vuelve a seguir el final.
    await press(stdin, "\u001B[5~"); // RePág
    await until(frame, (f) => f.includes("líneas más abajo") && !f.includes("linea 59"));
    io!.output("linea nueva\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frame()).not.toContain("linea nueva");
    await press(stdin, "\u001B[F"); // Fin
    await until(frame, (f) => f.includes("linea nueva") && !f.includes("líneas más abajo"));

    // Buscar: cuenta, salta a la línea y la mantiene resaltada.
    await press(stdin, "/");
    for (const ch of "eaddrinuse") await press(stdin, ch);
    await until(frame, (f) => f.includes("1 coincidencia"));
    await press(stdin, KEYS.enter);
    await until(frame, (f) => f.includes("EADDRINUSE") && f.includes("n/N coincidencias (1)"));
    expect(frame()).not.toContain("linea 59"); // la coincidencia sube arriba del todo

    // r reinicia: detiene el comando y lo lanza otra vez con los mismos argumentos.
    await press(stdin, "r");
    await until(frame, () => runs.length === 2);
    expect(cancels).toBe(1);
    expect(runs[1]).toEqual(runs[0]);

    // q vuelve al menú y no deja el comando vivo detrás.
    await press(stdin, "q");
    await until(frame, (f) => f.includes("› Bajar un .env"));
    expect(cancels).toBe(2);
    unmount();
  });

  it("pinta en rojo los errores y en amarillo los avisos de la salida", () => {
    expect(lineColor("kofre-api dev: Error: listen EADDRINUSE: address already in use :::3001")).toBe("red");
    expect(lineColor("kofre-api dev:   code: 'EADDRINUSE',")).toBe("red");
    expect(lineColor("npm ERR! code ELIFECYCLE")).toBe("red");
    expect(lineColor("UnhandledPromiseRejection: fetch failed")).toBe("red");
    expect(lineColor("(node:123) [DEP0190] DeprecationWarning: Passing args")).toBe("yellow");
    expect(lineColor(" WARN  deprecated inflight@1.0.6")).toBe("yellow");
    expect(lineColor("Found 0 errors. Watching for file changes.")).toBeUndefined();
    expect(lineColor("kofre-web dev: ✓ Ready in 2.1s")).toBeUndefined();
  });

  it("filtra con / en todas las secciones", async () => {
    const { lastFrame, stdin, unmount } = render(<App client={client().value} size={SIZE} />);
    const frame = () => lastFrame() ?? "";
    await until(frame, (f) => f.includes("› Bajar un .env"));
    await press(stdin, "/");
    await until(frame, (f) => f.includes("/▏"));
    for (const char of "token") await press(stdin, char);
    await until(frame, (f) => f.includes("/token"));
    expect(frame()).toContain("Crear un token para CI");
    expect(frame()).not.toContain("Bajar un .env");

    // Retroceso borra letra a letra y, con la búsqueda vacía, también el "/".
    for (let i = 0; i < "token".length; i += 1) await press(stdin, "\u007F");
    await until(frame, (f) => f.includes("/▏") && !f.includes("/t"));
    await press(stdin, "\u007F");
    await until(frame, (f) => !f.includes("/▏") && f.includes("[Secretos]"));
    unmount();
  });

  it("muestra el comando exacto con comillas cuando hace falta", () => {
    expect(preview(["run", "--env", "dev", "--", "npm", "run", "dev"])).toBe("kofre run --env dev -- npm run dev");
    expect(preview(["set", "MI VAR"])).toBe('kofre set "MI VAR"');
  });
});
