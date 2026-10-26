import { createInterface as createReadline } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/** El comando corre dentro de `kofre ui`: las preguntas van a la interfaz por el canal IPC en vez de a la terminal. */
export const insideUi = () => Boolean(process.env.KOFRE_UI_CHILD && process.send);

let nextQuestion = 0;

export type PromptOption = { label: string; value: string };

/** Pregunta a la interfaz y espera su respuesta; null si se canceló. */
function askUi(question: { label: string; hidden: boolean; options?: PromptOption[] }): Promise<string | null> {
  const id = nextQuestion++;
  // El canal está sin referencia para que el proceso termine solo; mientras se espera respuesta debe mantenerlo vivo.
  process.channel?.ref();
  process.send!({ type: "prompt", id, ...question });
  return new Promise((resolve) => {
    const onMessage = (message: { type?: string; id?: number; value?: string; cancelled?: boolean }) => {
      if (message?.type !== "answer" || message.id !== id) return;
      process.off("message", onMessage);
      process.channel?.unref();
      resolve(message.cancelled ? null : (message.value ?? ""));
    };
    process.on("message", onMessage);
  });
}

async function askUiText(label: string, hidden: boolean): Promise<string> {
  const value = await askUi({ label, hidden });
  if (value === null) throw new Error("Cancelado");
  return value;
}

if (insideUi()) process.channel?.unref();

/**
 * Elegir una opción. Dentro de `kofre ui` llega como un selector con flechas; en la terminal y en scripts es un menú
 * numerado (se contesta con el número). Devuelve el value elegido, o null si se cancela o la respuesta no vale.
 */
export async function promptChoice(question: string, options: PromptOption[]): Promise<string | null> {
  if (insideUi()) return askUi({ label: question, hidden: false, options });
  console.error(question);
  options.forEach((option, i) => console.error(`  ${i + 1}) ${option.label}`));
  const numbers = options.map((_, i) => i + 1);
  const answer = Number((await promptLine(`Elige ${numbers.slice(0, -1).join(", ")} o ${numbers.at(-1)}`)).trim());
  return options[answer - 1]?.value ?? null;
}

// Sin terminal (scripts, tuberías) varias respuestas pueden llegar juntas ("1\n2\n"). Un lector por pregunta se
// tragaba las siguientes, así que hay uno solo y una cola. Se cierra en cuanto no hay preguntas pendientes para no
// mantener vivo el proceso con stdin abierto; la siguiente pregunta abre otro y lee lo que quede.
let pipedReader: ReturnType<typeof createLineReader> | null = null;
const pipedLines: string[] = [];
const pipedWaiting: ((line: string) => void)[] = [];

function createLineReader() {
  const reader = createReadline({ input });
  reader.on("line", (line) => {
    const waiter = pipedWaiting.shift();
    if (waiter) waiter(line);
    else pipedLines.push(line);
    setImmediate(() => {
      if (pipedWaiting.length === 0 && pipedReader === reader) {
        pipedReader = null;
        reader.close();
      }
    });
  });
  reader.on("close", () => {
    if (pipedReader === reader) pipedReader = null;
    while (pipedWaiting.length > 0) pipedWaiting.shift()!(""); // stdin terminó: respuesta vacía
  });
  return reader;
}

function nextPipedLine(): Promise<string> {
  if (pipedLines.length > 0) return Promise.resolve(pipedLines.shift()!);
  return new Promise((resolve) => {
    pipedWaiting.push(resolve);
    pipedReader ??= createLineReader();
  });
}

/** Lee una línea con eco (para pegar el código de la web y ver qué se pegó). */
export async function promptLine(label: string): Promise<string> {
  if (insideUi()) return askUiText(label, false);
  if (!input.isTTY) {
    process.stderr.write(`${label}: `);
    return nextPipedLine();
  }
  const rl = createInterface({ input, output: process.stderr });
  try {
    return await rl.question(`${label}: `);
  } finally {
    rl.close();
  }
}

/** Lee sin eco. En CI usa KOFRE_PASSWORD; sin TTY lee una línea de stdin. */
export async function promptHidden(label: string): Promise<string> {
  if (process.env.KOFRE_PASSWORD) return process.env.KOFRE_PASSWORD;
  if (insideUi()) return askUiText(label, true);
  if (!input.isTTY) return nextPipedLine();

  process.stderr.write(`${label}: `);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") {
          finish(new Error("Cancelado"));
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on("data", onData);
  });
}
