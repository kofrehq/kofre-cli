import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { PasswordInput, Spinner, TextInput } from "@inkjs/ui";
import { COMMANDS, blockedReason, preview, type Answers, type Choice, type UiCommand } from "./commands";
import { COLORS, Kofri, KofriMini, Typewriter, type KofriMood } from "./kofri";
import type { UiClient, UiQuestion, UiRun, UiSnapshot } from "./types";

type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; message: string };
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Error inesperado");

// Orden de las pestañas; las que no estén aquí van al final en el orden del catálogo.
const TAB_ORDER = ["Sesión", "Secretos", "Proyecto", "Ambientes", "Equipo", "CI"];
const GROUPS = [...new Set([...TAB_ORDER, ...COMMANDS.map((c) => c.group)])].filter((g) => COMMANDS.some((c) => c.group === g));
// El panel de terminal de VS Code suele tener 8-12 filas: por eso el mínimo es tan bajo.
const MIN = { columns: 40, rows: 8 };
const LIST_WIDTH = 30;

type View =
  | { name: "menu" }
  | { name: "form"; command: UiCommand }
  | { name: "confirm"; command: UiCommand; argv: string[] }
  | { name: "run"; argv: string[]; code: number | null };

type Pending = UiQuestion & { answer(value: string | null): void };

/** Quita colores y retornos de carro de la salida de un comando para pintarla en el panel. */
const clean = (text: string) => text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "").replace(/\r(?!\n)/g, "\n").replace(/\r/g, "");

// Un servidor de desarrollo escribe sin parar: solo se guardan las últimas líneas.
const MAX_LINES = 5000;
const capLines = (text: string) => {
  const lines = text.split("\n");
  return lines.length > MAX_LINES ? lines.slice(-MAX_LINES).join("\n") : text;
};

// ponytail: heurística por palabras; "0 errors" no cuenta como error.
// Palabras sueltas (error, fatal…) y trozos que aparecen pegados (npm ERR!, UnhandledPromiseRejection, DeprecationWarning).
const ERROR_LINE = /\b(errors?|exception|fatal|failed|panic)\b|err!|eaddrinuse|enoent|eacces|uncaught|unhandled|✗/i;
const WARN_LINE = /warn|deprecat|⚠/i;
export const lineColor = (line: string) =>
  ERROR_LINE.test(line) && !/\b0 errors?\b/i.test(line) ? "red" : WARN_LINE.test(line) ? "yellow" : undefined;

/** Una línea de la salida, en rojo o amarillo si parece error o aviso, con las coincidencias de la búsqueda resaltadas. */
function LogLine({ line, term }: { line: string; term: string }) {
  const color = lineColor(line);
  if (!term) {
    return (
      <Text color={color} wrap="truncate-end">
        {line || " "}
      </Text>
    );
  }
  const parts: { text: string; match: boolean }[] = [];
  const lower = line.toLowerCase();
  const needle = term.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) {
    if (i > at) parts.push({ text: line.slice(at, i), match: false });
    parts.push({ text: line.slice(i, i + needle.length), match: true });
    at = i + needle.length;
  }
  if (at < line.length) parts.push({ text: line.slice(at), match: false });
  return (
    <Text color={color} wrap="truncate-end">
      {parts.length === 0
        ? " "
        : parts.map((part, i) =>
            part.match ? (
              <Text key={i} backgroundColor="yellow" color="black">
                {part.text}
              </Text>
            ) : (
              part.text
            ),
          )}
    </Text>
  );
}

export function App({ client, size }: { client: UiClient; size?: { columns: number; rows: number } }) {
  const { exit } = useApp();
  const windowSize = useWindowSize();
  const { columns, rows } = size ?? windowSize;

  const [snap, setSnap] = useState<UiSnapshot>({ email: client.email, linked: client.linked });
  const ctx = useMemo(() => ({ ...client, ...snap }), [client, snap]);

  const [view, setView] = useState<View>({ name: "menu" });
  // Sin sesión se abre en Sesión (iniciar sesión); con sesión, en Secretos, que es lo que más se usa.
  const [groupIndex, setGroupIndex] = useState(() => (client.email ? Math.max(0, GROUPS.indexOf("Secretos")) : 0));
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkedName, setLinkedName] = useState<Load<string> | null>(null);
  const [output, setOutput] = useState("");
  const [scroll, setScroll] = useState(0);
  const [question, setQuestion] = useState<Pending | null>(null);
  // Búsqueda en la salida: `search` es el texto mientras se escribe; `term`, lo que se resalta.
  const [search, setSearch] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const running = useRef<UiRun | null>(null);
  // Cada ejecución tiene un número: al volver al menú o reiniciar, el final de la anterior ya no pinta nada.
  const runId = useRef(0);
  const restartAfterStop = useRef(false);

  useEffect(() => {
    if (!snap.linked || !snap.email) return setLinkedName(null);
    setLinkedName({ state: "loading" });
    client
      .getProject(snap.linked.projectId)
      .then((project) => setLinkedName({ state: "ready", data: project.name }))
      .catch((error) => setLinkedName({ state: "error", message: errorText(error) }));
  }, [client, snap]);

  // Si se sale con un comando en marcha, no se deja huérfano.
  useEffect(() => () => running.current?.cancel(), []);

  // Una sección cada vez (←→) para que quepa; al buscar, se busca en todas.
  const visible = useMemo(() => {
    const q = (filter ?? "").toLowerCase().trim();
    if (!q) return COMMANDS.filter((c) => c.group === GROUPS[groupIndex]);
    return COMMANDS.filter((c) => `${c.group} ${c.title} ${c.id}`.toLowerCase().includes(q));
  }, [filter, groupIndex]);
  const current = visible[Math.min(selected, Math.max(visible.length - 1, 0))];

  const run = (argv: string[]) => {
    const id = ++runId.current;
    setOutput("");
    setScroll(0);
    setSearch(null);
    setView({ name: "run", argv, code: null });
    const handle = client.run(argv, {
      output: (text) => {
        if (id !== runId.current) return;
        const chunk = clean(text);
        setOutput((previous) => capLines(previous + chunk));
        // Leyendo más arriba, la salida nueva no mueve la vista: el desplazamiento se cuenta desde el final.
        const added = chunk.split("\n").length - 1;
        if (added > 0) setScroll((s) => (s > 0 ? s + added : 0));
      },
      ask: (q) =>
        new Promise((resolve) =>
          setQuestion({
            ...q,
            answer: (value) => {
              // La pregunta y lo elegido quedan en la salida: después se ve qué se respondió.
              const shown =
                value === null
                  ? "cancelado"
                  : q.options
                    ? (q.options.find((option) => option.value === value)?.label ?? value)
                    : q.hidden
                      ? "••••••"
                      : value;
              // En dos líneas: con una pregunta larga, la respuesta no queda cortada al final.
              setOutput((previous) => `${previous}? ${q.label}\n  → ${shown}\n`);
              resolve(value);
            },
          }),
        ),
    });
    running.current = handle;
    void handle.done.then((code) => {
      if (id !== runId.current) return;
      running.current = null;
      setQuestion(null);
      if (restartAfterStop.current) {
        restartAfterStop.current = false;
        return run(argv);
      }
      setView({ name: "run", argv, code });
    });
  };

  /** Detiene el comando y todo lo que lanzó (ver kill-tree.ts). */
  const stop = () => running.current?.cancel();

  const restart = (argv: string[]) => {
    if (running.current) {
      restartAfterStop.current = true;
      stop();
    } else {
      run(argv);
    }
  };

  const backToMenu = () => {
    // Si sigue en marcha, se detiene: no queda nada corriendo detrás del menú.
    runId.current++;
    restartAfterStop.current = false;
    stop();
    running.current = null;
    setQuestion(null);
    setSearch(null);
    setTerm("");
    // login, logout o init pueden haber cambiado la sesión o la carpeta.
    setSnap(client.snapshot());
    setView({ name: "menu" });
  };

  const mood: KofriMood =
    busy || linkedName?.state === "loading" || (view.name === "run" && view.code === null)
      ? "loading"
      : view.name === "run"
        ? view.code === 0
          ? "happy"
          : "sad"
        : "idle";

  // ── Geometría: todo sale del tamaño real de la ventana para no pasarse nunca de ella. ──
  // Muy baja (< 14 filas): sin separaciones, lista y detalle siempre lado a lado y detalle mínimo.
  const tiny = rows < 14;
  const compact = rows < 30 || columns < 80;
  const sideBySide = columns >= 80 || (tiny && columns >= 48);
  const tooSmall = columns < MIN.columns || rows < MIN.rows || (tiny && !sideBySide);
  const headerHeight = compact ? 1 : 7;
  const gap = tiny ? 0 : 1;
  // bordes (2) + cabecera + pestañas (1) + separación + pie (1) + separación tras la cabecera grande
  const bodyHeight = Math.max(3, rows - 2 - headerHeight - 1 - gap - 1 - (compact ? 0 : 1));
  const innerWidth = columns - 4;
  const listWidth = Math.min(LIST_WIDTH, Math.floor(columns * 0.4));
  const listHeight = sideBySide ? bodyHeight : Math.min(Math.max(visible.length, 1), Math.max(3, Math.floor(bodyHeight / 3)));
  const panelHeight = sideBySide ? bodyHeight : bodyHeight - listHeight;
  const panelInner = Math.max(1, panelHeight - 2);
  const tight = panelInner < 6;

  const outputLines = output.replace(/\n+$/, "").split("\n");
  // estado del comando (1) + separación (si cabe) + la pregunta abierta (2)
  // Ancho útil del panel (bordes y relleno incluidos) para saber cuántas líneas ocupa una pregunta larga.
  const panelTextWidth = Math.max(10, (sideBySide ? innerWidth - listWidth - (tiny ? 1 : 2) : innerWidth) - 4);
  // Una pregunta puede traer varias líneas (el resumen de cambios de pull y la pregunta en sí).
  const labelLines = question
    ? question.label.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / panelTextWidth)), 0)
    : 0;
  // Elegir: la pregunta y todas las opciones que quepan (al menos una). Texto: la pregunta y el campo.
  const questionLines = !question
    ? 0
    : question.options
      ? tight
        ? Math.min(panelInner, 1 + question.options.length)
        : Math.min(Math.max(1, panelInner - 1), labelLines + question.options.length)
      : tight
        ? 1
        : 2;
  // Con una sola línea y una pregunta abierta, solo se ve la pregunta.
  const showStatus = !(question && panelInner - questionLines < 1);
  const outputRoom = Math.max(0, panelInner - (showStatus ? 1 : 0) - (tight ? 0 : 1) - questionLines);
  const maxScroll = Math.max(0, outputLines.length - outputRoom);
  // scroll = líneas desde el final; 0 es seguir la salida nueva.
  const firstLine = Math.max(0, maxScroll - Math.min(scroll, maxScroll));
  const matchLines = useMemo(() => {
    const needle = term.toLowerCase();
    if (!needle) return [];
    return outputLines.flatMap((line, i) => (line.toLowerCase().includes(needle) ? [i] : []));
    // outputLines sale de output: se recalcula cuando cambia la salida, no en cada pintado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output, term]);
  /** Lleva la siguiente (1) o anterior (-1) coincidencia arriba del todo; `from` incluye la línea de arriba. */
  const jump = (direction: 1 | -1, from = false) => {
    if (matchLines.length === 0) return;
    const target =
      direction === 1
        ? (matchLines.find((i) => (from ? i >= firstLine : i > firstLine)) ?? matchLines[0])
        : ([...matchLines].reverse().find((i) => i < firstLine) ?? matchLines[matchLines.length - 1]);
    setScroll(Math.max(0, maxScroll - target));
  };

  useInput(
    (input, key) => {
      if (filter !== null) {
        // Borrar con la búsqueda ya vacía (o ←) la cierra: el "/" también se borra.
        if (key.escape || (filter === "" && (key.backspace || key.delete || key.leftArrow))) return setFilter(null);
        if (key.backspace || key.delete) return setFilter((f) => (f ?? "").slice(0, -1));
        if (!(key.upArrow || key.downArrow || key.return) && input && !key.ctrl && !key.meta) {
          setSelected(0);
          return setFilter((f) => (f ?? "") + input);
        }
      } else {
        if (input === "q" || key.escape || (key.ctrl && input === "c")) return exit();
        if (input === "/") return setFilter("");
        if (key.leftArrow || key.rightArrow) {
          const step = key.rightArrow ? 1 : GROUPS.length - 1;
          setGroupIndex((g) => (g + step) % GROUPS.length);
          return setSelected(0);
        }
      }
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setSelected((s) => Math.min(visible.length - 1, s + 1));
      if (key.return && current && !blockedReason(current, ctx)) {
        setFilter(null);
        if (current.fields.length === 0) setView({ name: "confirm", command: current, argv: current.argv({}) });
        else setView({ name: "form", command: current });
      }
    },
    { isActive: view.name === "menu" && !tooSmall },
  );

  useInput(
    (_input, key) => {
      if (key.escape) return setView({ name: "menu" });
      if (key.return && view.name === "confirm") run(view.argv);
    },
    { isActive: (view.name === "form" || view.name === "confirm") && !tooSmall },
  );

  useInput(
    (input, key) => {
      // Con una pregunta abierta, las teclas son de la pregunta (esc la cancela, ver más abajo).
      if (view.name !== "run" || question) return;
      const live = view.code === null;

      if (search !== null) {
        if (key.escape) {
          setSearch(null);
          return setTerm("");
        }
        if (key.return) {
          setSearch(null);
          return jump(1, true);
        }
        const next = key.backspace || key.delete ? search.slice(0, -1) : input && !key.ctrl && !key.meta ? search + input : search;
        setSearch(next);
        return setTerm(next);
      }

      if (key.ctrl && input === "c") return live ? stop() : backToMenu();
      if (key.escape) {
        if (term) return setTerm(""); // primero se quita el resaltado
        return live ? stop() : backToMenu();
      }
      if (input === "q") return backToMenu();
      if (input === "r") return restart(view.argv);
      if (input === "/") return setSearch(term);
      if (input === "n" || input === "N") return jump(input === "n" ? 1 : -1);
      if (key.upArrow) setScroll((s) => Math.min(maxScroll, s + 1));
      if (key.downArrow) setScroll((s) => Math.max(0, s - 1));
      if (key.pageUp) setScroll((s) => Math.min(maxScroll, s + outputRoom));
      if (key.pageDown) setScroll((s) => Math.max(0, s - outputRoom));
      if (key.home) setScroll(maxScroll);
      if (key.end) setScroll(0);
      if (key.return && !live) backToMenu();
    },
    { isActive: view.name === "run" && !tooSmall },
  );

  useInput(
    (_input, key) => {
      if (key.escape && question) {
        question.answer(null);
        setQuestion(null);
      }
    },
    { isActive: question !== null },
  );

  if (tooSmall) {
    return (
      <Box width={columns} height={rows} alignItems="center" justifyContent="center" flexDirection="column">
        <KofriMini mood="sad" />
        <Text>
          Agranda la ventana: mínimo {MIN.columns}×{MIN.rows}
        </Text>
        <Text color={COLORS.dim}>
          ahora {columns}×{rows}
        </Text>
      </Box>
    );
  }

  const folder = !snap.linked
    ? "sin vincular"
    : linkedName?.state === "ready"
      ? `${linkedName.data} · ${snap.linked.defaultEnv}`
      : linkedName?.state === "error"
        ? linkedName.message
        : "cargando…";
  const greeting = !snap.email
    ? "¡Hola! Inicia sesión para empezar."
    : view.name === "run" && view.code !== null
      ? view.code === 0
        ? "¡Listo! ¿Qué más hacemos?"
        : "Eso no salió bien. Revisa la salida."
      : view.name === "run"
        ? "Trabajando en ello…"
        : "¡Hola! ¿Qué hacemos hoy?";

  const tabsWidth = GROUPS.reduce((sum, group) => sum + group.length + 4, 0);

  return (
    <Box flexDirection="column" width={columns} height={rows} borderStyle="round" borderColor={COLORS.lid} paddingX={1}>
      {compact ? (
        <Box height={1}>
          <Text wrap="truncate-end">
            <KofriMini mood={mood} />
            <Text> </Text>
            <Text bold color={COLORS.body}>
              Kofre
            </Text>
            <Text color={COLORS.dim}>
              {" "}
              · {snap.email ?? "sin sesión"} · {folder}
            </Text>
          </Text>
        </Box>
      ) : (
        <Box gap={1} height={7}>
          <Kofri mood={mood} />
          <Box flexDirection="column" justifyContent="center" flexGrow={1}>
            <Text>
              <Text bold color={COLORS.body}>
                Kofre
              </Text>
              <Text color={COLORS.dim}> v{client.version}</Text>
            </Text>
            <Typewriter text={greeting} />
            <Text color={COLORS.dim} wrap="truncate-end">
              {snap.email ? `Sesión: ${snap.email}` : "Sin sesión"}
            </Text>
            <Text color={COLORS.dim} wrap="truncate-end">
              Carpeta: {folder}
            </Text>
          </Box>
        </Box>
      )}

      <Box height={1} marginTop={compact ? 0 : 1}>
        {filter !== null ? (
          <Text>
            <Text color={COLORS.body}>/</Text>
            {filter}
            <Text color={COLORS.dim}>▏</Text>
          </Text>
        ) : tabsWidth <= innerWidth ? (
          GROUPS.map((group, i) => (
            <Text key={group} color={i === groupIndex ? COLORS.body : COLORS.dim} bold={i === groupIndex}>
              {i === groupIndex ? `[${group}]` : ` ${group} `}
              {"  "}
            </Text>
          ))
        ) : (
          <Text>
            <Text color={COLORS.dim}>‹ </Text>
            <Text bold color={COLORS.body}>
              {GROUPS[groupIndex]}
            </Text>
            <Text color={COLORS.dim}>
              {" "}
              › {groupIndex + 1}/{GROUPS.length}
            </Text>
          </Text>
        )}
      </Box>

      <Box marginTop={gap} height={bodyHeight} flexDirection={sideBySide ? "row" : "column"} gap={sideBySide ? (tiny ? 1 : 2) : 0}>
        <Box flexDirection="column" width={sideBySide ? listWidth : undefined} height={listHeight} flexShrink={0} overflow="hidden">
          {visible.length === 0 ? <Text color={COLORS.dim}>Nada coincide con «{filter}».</Text> : null}
          {windowed(visible, selected, listHeight).map(({ item: command, index: i }) => {
            const active = i === selected && view.name === "menu";
            const blocked = blockedReason(command, ctx) !== null;
            return (
              <Text key={command.id} color={active ? COLORS.body : blocked ? COLORS.dim : undefined} bold={active} wrap="truncate-end">
                {active ? "› " : "  "}
                {command.title}
                {filter !== null ? <Text color={COLORS.dim}> · {command.group}</Text> : null}
              </Text>
            );
          })}
        </Box>

        <Box
          flexDirection="column"
          flexGrow={1}
          height={panelHeight}
          overflow="hidden"
          borderStyle="single"
          borderColor={view.name === "menu" ? COLORS.dim : COLORS.lid}
          paddingX={1}
        >
          {view.name === "menu" && current ? <Detail command={current} ctx={ctx} room={panelInner} /> : null}
          {view.name === "form" ? (
            <CommandForm
              command={view.command}
              ctx={ctx}
              room={panelInner}
              onBusy={setBusy}
              onDone={(answers) => setView({ name: "confirm", command: view.command, argv: view.command.argv(answers) })}
            />
          ) : null}
          {view.name === "confirm" ? (
            <Box flexDirection="column" gap={1}>
              <Text bold>{view.command.title}</Text>
              <Box flexDirection="column">
                <Text color={COLORS.dim}>Se ejecutará:</Text>
                <Text wrap="truncate-end">
                  <Text color={COLORS.dim}>$ </Text>
                  <Typewriter text={preview(view.argv)} color={COLORS.body} ms={12} />
                </Text>
              </Box>
              <Text color={COLORS.dim}>⏎ ejecutar · esc volver</Text>
            </Box>
          ) : null}
          {view.name === "run" ? (
            <Box flexDirection="column">
              {/* Solo se pinta lo que cabe: Ink superpone las líneas que no caben en vez de cortarlas. */}
              {showStatus ? (
                <Box gap={1} height={1}>
                  {view.code === null ? (
                    <Spinner />
                  ) : (
                    <Text color={view.code === 0 ? "green" : "red"}>{view.code === 0 ? "✓" : `✗ código ${view.code}`}</Text>
                  )}
                  <Text color={COLORS.body} wrap="truncate-end">
                    $ {preview(view.argv)}
                    {scroll > 0 && maxScroll > 0 ? (
                      <Text color={COLORS.dim}> · {Math.min(scroll, maxScroll)} líneas más abajo</Text>
                    ) : null}
                  </Text>
                </Box>
              ) : null}
              {outputRoom > 0 ? (
                <Box flexDirection="column" height={outputRoom} marginTop={tight ? 0 : 1} overflow="hidden">
                  {outputLines.slice(firstLine, firstLine + outputRoom).map((line, i) => (
                    <LogLine key={`${firstLine + i}`} line={line} term={term} />
                  ))}
                </Box>
              ) : null}
              {question?.options ? (
                // Elegir una opción: el mismo selector con flechas que en los formularios. En poco espacio, la pregunta
                // ocupa una línea y las opciones que no quepan se desplazan con las flechas.
                <Box flexDirection="column">
                  {questionLines > 1 ? (
                    // En poco espacio, solo la última línea: la pregunta en sí.
                    <Text color={COLORS.body} wrap={tight ? "truncate-end" : "wrap"}>
                      {tight ? question.label.split("\n").at(-1) : question.label}
                    </Text>
                  ) : null}
                  <Picker
                    key={question.label}
                    options={question.options}
                    armAfterMs={400}
                    height={Math.max(1, questionLines - (questionLines > 1 ? (tight ? 1 : labelLines) : 0))}
                    onSubmit={(value) => {
                      question.answer(value);
                      setQuestion(null);
                    }}
                  />
                </Box>
              ) : question ? (
                // Con poco espacio, la pregunta y el campo comparten línea.
                <Box flexDirection={tight ? "row" : "column"} gap={tight ? 1 : 0}>
                  <Text color={COLORS.body} wrap="truncate-end">
                    {question.label}
                    {tight ? ":" : ""}
                  </Text>
                  {question.hidden ? (
                    <PasswordInput
                      onSubmit={(value) => {
                        question.answer(value);
                        setQuestion(null);
                      }}
                    />
                  ) : (
                    <TextInput
                      onSubmit={(value) => {
                        question.answer(value);
                        setQuestion(null);
                      }}
                    />
                  )}
                </Box>
              ) : null}
            </Box>
          ) : null}
        </Box>
      </Box>

      <Box height={1}>
        <Text color={COLORS.dim} wrap="truncate-end">
          {view.name === "menu"
            ? filter !== null
              ? "escribe para filtrar · ↑↓ elegir · ⏎ abrir · esc salir de la búsqueda"
              : "←→ sección · ↑↓ elegir · ⏎ abrir · / buscar · q salir"
            : view.name === "form"
              ? "↑↓ elegir · ⏎ confirmar · esc volver al menú"
              : view.name === "confirm"
                ? "⏎ ejecutar · esc volver al menú"
                : question
                  ? question.options
                    ? "↑↓ elegir · ⏎ confirmar · esc cancelar"
                    : "⏎ responder · esc cancelar"
                  : search !== null
                    ? `/${search}▏ · ${matchLines.length} coincidencia${matchLines.length === 1 ? "" : "s"} · ⏎ ir · esc cerrar`
                    : [
                        view.code === null ? "esc detener" : "⏎ menú",
                        view.code === null ? "r reiniciar" : "r repetir",
                        "q volver",
                        term ? `n/N coincidencias (${matchLines.length})` : "/ buscar",
                        maxScroll > 0 ? (scroll > 0 ? "↑↓ RePág · Fin seguir" : "↑↓ RePág desplazar") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
        </Text>
      </Box>
    </Box>
  );
}

/** La parte de la lista que cabe, siempre con el elemento elegido a la vista. */
function windowed<T>(items: T[], selected: number, height: number): { item: T; index: number }[] {
  const start = Math.max(0, Math.min(selected - height + 1, items.length - height));
  return items.slice(start, start + height).map((item, i) => ({ item, index: start + i }));
}

function Detail({ command, ctx, room }: { command: UiCommand; ctx: UiClient; room: number }) {
  const blocked = blockedReason(command, ctx);
  const sample = command.fields.length === 0 ? preview(command.argv({})) : `kofre ${command.argv(sampleAnswers(command)).join(" ")}`;
  const hint = blocked ? (
    <Text color="yellow" wrap="truncate-end">
      {blocked}
    </Text>
  ) : (
    <Text color={COLORS.dim}>⏎ {command.fields.length > 0 ? "continuar" : "ejecutar"}</Text>
  );
  const command$ = (
    <Text color={COLORS.dim} wrap="truncate-end">
      $ {sample}
    </Text>
  );
  // En un panel bajo, lo que importa: qué se va a ejecutar y si se puede. El título ya se ve en la lista.
  if (room < 6) {
    return (
      <Box flexDirection="column">
        {command$}
        {room >= 2 ? hint : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={COLORS.body} wrap="truncate-end">
        {command.title}
      </Text>
      <Text>{command.description}</Text>
      {command$}
      {hint}
    </Box>
  );
}

/** Ejemplo legible para el panel de detalle: <campo> donde irá cada respuesta. */
function sampleAnswers(command: UiCommand): Answers {
  return Object.fromEntries(command.fields.map((field) => [field.key, `<${field.key}>`]));
}

/**
 * Lista con flechas y Enter. No se usa el Select de @inkjs/ui porque solo avisa cuando el valor cambia: Enter sobre la
 * opción por defecto (el caso más común, el ambiente de la carpeta) no hacía nada.
 */
function Picker({
  options,
  initial,
  height,
  armAfterMs = 0,
  onSubmit,
}: {
  options: Choice[];
  initial?: string;
  height: number;
  /** Ignora Enter durante este tiempo: un Enter pulsado de más mientras el comando arranca no elige por ti. */
  armAfterMs?: number;
  onSubmit: (value: string) => void;
}) {
  const [index, setIndex] = useState(() => Math.max(0, options.findIndex((o) => o.value === initial)));
  const [armed, setArmed] = useState(armAfterMs === 0);
  useEffect(() => {
    if (armAfterMs === 0) return;
    const id = setTimeout(() => setArmed(true), armAfterMs);
    return () => clearTimeout(id);
  }, [armAfterMs]);
  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setIndex((i) => Math.min(options.length - 1, i + 1));
    if (key.return && armed) onSubmit(options[index].value);
  });
  return (
    <Box flexDirection="column">
      {windowed(options, index, Math.max(1, height)).map(({ item: option, index: i }) => (
        <Text key={option.value} color={i === index ? COLORS.body : undefined} bold={i === index} wrap="truncate-end">
          {i === index ? "❯ " : "  "}
          {option.label}
          {option.value === initial ? <Text color={COLORS.dim}> (actual)</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function CommandForm({
  command,
  ctx,
  room,
  onDone,
  onBusy,
}: {
  command: UiCommand;
  ctx: UiClient;
  /** Filas disponibles en el panel: con pocas, solo se ve la pregunta actual. */
  room: number;
  onDone: (answers: Answers) => void;
  onBusy: (busy: boolean) => void;
}) {
  const tight = room < 6;
  const inline = room < 3;
  const [answers, setAnswers] = useState<Answers>({});
  const [step, setStep] = useState(0);
  const [choices, setChoices] = useState<Load<Choice[]> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const field = command.fields[step];

  useEffect(() => {
    if (!field || field.kind !== "select") return setChoices(null);
    setChoices({ state: "loading" });
    onBusy(true);
    field
      .choices(ctx, answers)
      .then((data) => setChoices({ state: "ready", data }))
      .catch((error) => setChoices({ state: "error", message: errorText(error) }))
      .finally(() => onBusy(false));
    // Solo al cambiar de paso: las respuestas anteriores ya están fijadas.
  }, [step]);

  const answer = (value: string) => {
    if (!field) return;
    if (!value.trim() && !(field.kind === "text" && field.optional)) {
      return setProblem("Este campo es obligatorio.");
    }
    setProblem(null);
    const next = { ...answers, [field.key]: value.trim() };
    setAnswers(next);
    if (step + 1 >= command.fields.length) onDone(next);
    else setStep(step + 1);
  };

  return (
    <Box flexDirection="column">
      {tight ? null : (
        <Text bold color={COLORS.body}>
          {command.title}
        </Text>
      )}
      {(tight ? [] : command.fields.slice(0, step)).map((done) => (
        <Text key={done.key} color={COLORS.dim} wrap="truncate-end">
          <Text color="green">✓ </Text>
          {done.label}: {answers[done.key] || "—"}
        </Text>
      ))}
      {field ? (
        // Con una o dos filas, la pregunta y el campo comparten línea (y el aviso ocupa el lugar de la pregunta).
        <Box flexDirection={inline ? "row" : "column"} gap={inline ? 1 : 0} marginTop={tight ? 0 : 1}>
          <Text wrap="truncate-end" color={inline && problem ? "red" : undefined}>
            {inline && problem ? problem : field.label}
            {inline ? ":" : ""}
          </Text>
          {field.kind === "text" ? (
            <TextInput key={field.key} defaultValue={field.initial} placeholder={field.placeholder} onSubmit={answer} />
          ) : choices?.state === "loading" ? (
            <Spinner label="Cargando opciones" />
          ) : choices?.state === "error" ? (
            <Text color="red">{choices.message}</Text>
          ) : choices?.state === "ready" && choices.data.length === 0 ? (
            <Text color="yellow">{field.empty ?? "No hay opciones disponibles."}</Text>
          ) : choices?.state === "ready" ? (
            <Picker
              key={field.key}
              options={choices.data}
              initial={field.initial?.(ctx)}
              height={inline ? room : tight ? room - 1 : room - 3 - step}
              onSubmit={answer}
            />
          ) : null}
          {problem && !inline ? <Text color="red">{problem}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}
