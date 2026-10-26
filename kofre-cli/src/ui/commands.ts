import type { UiClient } from "./types";

export type Choice = { label: string; value: string };
export type Answers = Record<string, string>;

export type Field =
  | { key: string; kind: "text"; label: string; placeholder?: string; initial?: string; optional?: boolean }
  | {
      key: string;
      kind: "select";
      label: string;
      choices: (client: UiClient, answers: Answers) => Promise<Choice[]>;
      initial?: (client: UiClient) => string | undefined;
      /** Qué decir si no hay opciones (por defecto, un aviso genérico). */
      empty?: string;
    };

export type Needs = "session" | "linked";

export type UiCommand = {
  id: string;
  group: string;
  title: string;
  description: string;
  needs: Needs[];
  fields: Field[];
  argv(answers: Answers): string[];
};

// Opciones que salen de los datos reales: proyectos de la cuenta y ambientes del proyecto vinculado o elegido.
const linkedEnvs = async (client: UiClient): Promise<Choice[]> => {
  if (!client.linked) return [];
  const project = await client.getProject(client.linked.projectId);
  return project.environments.map((env) => ({ label: env.slug === env.name ? env.slug : `${env.slug} · ${env.name}`, value: env.slug }));
};
const projectChoices = async (client: UiClient): Promise<Choice[]> =>
  (await client.listProjects()).map((p) => ({ label: p.name, value: p.id }));

const envField: Field = {
  key: "env",
  kind: "select",
  label: "Ambiente",
  choices: linkedEnvs,
  initial: (client) => client.linked?.defaultEnv,
};

/** El mismo catálogo que `kofre --help`, con las preguntas que cada comando necesita. Nunca se ofrece --show. */
export const COMMANDS: UiCommand[] = [
  {
    id: "pull",
    group: "Secretos",
    title: "Bajar un .env",
    description: "Descifra las variables del ambiente en un archivo. Si ya existe un .env que no es de Kofre, te preguntará antes de tocarlo.",
    needs: ["session", "linked"],
    fields: [envField, { key: "output", kind: "text", label: "Archivo de salida", initial: ".env" }],
    argv: (a) => ["pull", "--env", a.env, "-o", a.output || ".env"],
  },
  {
    id: "push",
    group: "Secretos",
    title: "Subir un .env",
    description: "Cifra en tu máquina y sube las variables del archivo. Las que no cambiaron no crean otra versión.",
    needs: ["session", "linked"],
    fields: [{ key: "file", kind: "text", label: "Archivo", initial: ".env" }, envField],
    argv: (a) => ["push", a.file || ".env", "--env", a.env],
  },
  {
    id: "set",
    group: "Secretos",
    title: "Cambiar una variable",
    description: "Crea o actualiza una sola variable. El valor se escribe sin eco en el siguiente paso.",
    needs: ["session", "linked"],
    fields: [{ key: "name", kind: "text", label: "Nombre de la variable", placeholder: "DATABASE_URL" }, envField],
    argv: (a) => ["set", a.name, "--env", a.env],
  },
  {
    id: "run",
    group: "Secretos",
    title: "Ejecutar con las variables",
    description: "Lanza un comando con las variables en memoria, sin escribir ningún .env en disco.",
    needs: ["session", "linked"],
    fields: [envField, { key: "command", kind: "text", label: "Comando", placeholder: "npm run dev" }],
    argv: (a) => ["run", "--env", a.env, "--", ...a.command.trim().split(/\s+/)],
  },
  {
    id: "history",
    group: "Secretos",
    title: "Historial de una variable",
    description: "Versiones y fechas de una variable. Los valores no se muestran.",
    needs: ["session", "linked"],
    fields: [{ key: "name", kind: "text", label: "Nombre de la variable", placeholder: "API_KEY" }, envField],
    argv: (a) => ["history", a.name, "--env", a.env],
  },
  {
    id: "init",
    group: "Proyecto",
    title: "Vincular esta carpeta",
    description: "Guarda en .kofre.toml el proyecto y el ambiente por defecto. No guarda secretos.",
    needs: ["session"],
    fields: [
      { key: "project", kind: "select", label: "Proyecto", choices: projectChoices, initial: (c) => c.linked?.projectId },
      {
        key: "env",
        kind: "select",
        label: "Ambiente por defecto",
        choices: async (client, answers) => (await client.getProject(answers.project)).environments.map((e) => ({ label: e.slug, value: e.slug })),
      },
    ],
    argv: (a) => ["init", "--project", a.project, "--env", a.env],
  },
  {
    id: "projects-list",
    group: "Proyecto",
    title: "Ver mis proyectos",
    description: "Lista los proyectos a los que tienes acceso.",
    needs: ["session"],
    fields: [],
    argv: () => ["projects", "list"],
  },
  {
    id: "projects-create",
    group: "Proyecto",
    title: "Crear un proyecto",
    description: "Crea un proyecto con sus ambientes y la clave de cifrado de cada uno.",
    needs: ["session"],
    fields: [
      { key: "name", kind: "text", label: "Nombre", placeholder: "api-pagos" },
      { key: "envs", kind: "text", label: "Ambientes (separados por coma)", initial: "dev,staging,prod" },
    ],
    argv: (a) => ["projects", "create", "--name", a.name, "--envs", a.envs || "dev,staging,prod"],
  },
  {
    id: "projects-delete",
    group: "Proyecto",
    title: "Borrar un proyecto",
    description: "Borra el proyecto con todos sus ambientes y secretos. Pedirá confirmación.",
    needs: ["session"],
    fields: [{ key: "project", kind: "select", label: "Proyecto", choices: projectChoices }],
    argv: (a) => ["projects", "delete", a.project],
  },
  {
    id: "envs-list",
    group: "Ambientes",
    title: "Ver ambientes",
    description: "Ambientes del proyecto vinculado a esta carpeta.",
    needs: ["session", "linked"],
    fields: [],
    argv: () => ["envs", "list"],
  },
  {
    id: "envs-create",
    group: "Ambientes",
    title: "Crear un ambiente",
    description: "Añade un ambiente al proyecto vinculado, con su propia clave de cifrado.",
    needs: ["session", "linked"],
    fields: [
      { key: "slug", kind: "text", label: "Slug", placeholder: "qa" },
      { key: "name", kind: "text", label: "Nombre legible", placeholder: "QA", optional: true },
    ],
    argv: (a) => ["envs", "create", a.slug, ...(a.name ? ["--name", a.name] : [])],
  },
  {
    id: "envs-delete",
    group: "Ambientes",
    title: "Borrar un ambiente",
    description: "Borra el ambiente y sus secretos. Pedirá confirmación.",
    needs: ["session", "linked"],
    fields: [{ ...envField, initial: undefined }],
    argv: (a) => ["envs", "delete", a.env],
  },
  {
    id: "members-list",
    group: "Equipo",
    title: "Ver miembros",
    description: "Personas con acceso al proyecto, su rol y la huella de su clave.",
    needs: ["session", "linked"],
    fields: [],
    argv: () => ["members", "list"],
  },
  {
    id: "members-add",
    group: "Equipo",
    title: "Invitar a alguien",
    description: "Da acceso a una cuenta de Kofre existente. Verás su huella para confirmarla.",
    needs: ["session", "linked"],
    fields: [
      { key: "email", kind: "text", label: "Correo", placeholder: "colega@empresa.dev" },
      {
        key: "role",
        kind: "select",
        label: "Rol",
        choices: async () => [
          { label: "reader · solo lectura", value: "reader" },
          { label: "editor · lee y escribe", value: "editor" },
        ],
      },
    ],
    argv: (a) => ["members", "add", a.email, "--role", a.role],
  },
  {
    id: "members-remove",
    group: "Equipo",
    title: "Eliminar a alguien",
    description: "Retira el acceso a un miembro y rota las claves de cifrado de los ambientes.",
    needs: ["session", "linked"],
    fields: [
      {
        key: "email",
        kind: "select",
        label: "Miembro",
        // Los miembros reales del proyecto, sin uno mismo: quien es owner no puede eliminarse.
        choices: async (client) => {
          if (!client.linked) return [];
          const members = await client.listMembers(client.linked.projectId);
          return members
            .filter((member) => member.email !== client.email)
            .map((member) => ({ label: `${member.email} · ${member.role}`, value: member.email }));
        },
        empty: "No hay otros miembros en este proyecto. Invita a alguien desde Equipo › Invitar a alguien.",
      },
    ],
    argv: (a) => ["members", "remove", a.email],
  },
  {
    id: "tokens-list",
    group: "CI",
    title: "Ver tokens de servicio",
    description: "Tokens de solo lectura del proyecto, su estado y último uso.",
    needs: ["session", "linked"],
    fields: [],
    argv: () => ["tokens", "list"],
  },
  {
    id: "tokens-create",
    group: "CI",
    title: "Crear un token para CI",
    description: "Token de solo lectura para pipelines. Se muestra una sola vez.",
    needs: ["session", "linked"],
    fields: [
      { key: "name", kind: "text", label: "Nombre", placeholder: "github-actions" },
      { key: "envs", kind: "text", label: "Ambientes (separados por coma)", placeholder: "prod" },
      { key: "expires", kind: "text", label: "Caduca en días (vacío: nunca)", placeholder: "90", optional: true },
    ],
    argv: (a) => ["tokens", "create", "--name", a.name, "--envs", a.envs, ...(a.expires ? ["--expires", a.expires] : [])],
  },
  {
    id: "tokens-revoke",
    group: "CI",
    title: "Revocar un token",
    description: "El token deja de funcionar de inmediato.",
    needs: ["session", "linked"],
    fields: [
      {
        key: "id",
        kind: "select",
        label: "Token",
        // Solo los activos: uno revocado o caducado ya no hace nada.
        choices: async (client) => {
          if (!client.linked) return [];
          const tokens = await client.listTokens(client.linked.projectId);
          return tokens
            .filter((token) => token.active)
            .map((token) => ({ label: `${token.name} · ${token.environments.map((env) => env.slug).join(",")}`, value: token.id }));
        },
        empty: "No hay tokens activos en este proyecto. Crea uno desde CI › Crear un token para CI.",
      },
    ],
    argv: (a) => ["tokens", "revoke", a.id],
  },
  {
    id: "login",
    group: "Sesión",
    title: "Iniciar sesión",
    description: "Abre el navegador, autorizas la terminal y pegas el código que te muestra la web.",
    needs: [],
    fields: [],
    argv: () => ["login"],
  },
  {
    id: "whoami",
    group: "Sesión",
    title: "Quién soy",
    description: "Cuenta, dispositivo, estado de la bóveda y proyecto vinculado a esta carpeta.",
    needs: ["session"],
    fields: [],
    argv: () => ["whoami"],
  },
  {
    id: "devices",
    group: "Sesión",
    title: "Ver dispositivos",
    description: "Sesiones abiertas en tu cuenta. Las revocas desde la web.",
    needs: ["session"],
    fields: [],
    argv: () => ["devices"],
  },
  {
    id: "lock",
    group: "Sesión",
    title: "Bloquear la bóveda",
    description: "Olvida la clave guardada en el llavero; la próxima operación pedirá la contraseña.",
    needs: ["session"],
    fields: [],
    argv: () => ["lock"],
  },
  {
    id: "logout",
    group: "Sesión",
    title: "Cerrar sesión",
    description: "Revoca la sesión en el servidor y borra la local.",
    needs: ["session"],
    fields: [],
    argv: () => ["logout"],
  },
];

/** Por qué un comando no se puede usar ahora, o null si se puede. */
export function blockedReason(command: UiCommand, client: UiClient): string | null {
  if (command.needs.includes("session") && !client.email) return "Primero inicia sesión (Sesión › Iniciar sesión).";
  if (command.needs.includes("linked") && !client.linked) return "Primero vincula esta carpeta (Proyecto › Vincular esta carpeta).";
  return null;
}

/** Comando como se escribiría a mano, para mostrarlo antes de ejecutarlo. */
export function preview(argv: string[]): string {
  return ["kofre", ...argv.map((arg) => (/^[\w./:@,=-]+$/.test(arg) ? arg : JSON.stringify(arg)))].join(" ");
}
