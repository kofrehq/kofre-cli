import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import {
  b64ToBytes,
  bytesToB64,
  decryptSecret,
  encryptSecret,
  generateEnvKey,
  openSealedEnvKey,
  publicKeyOf,
  sealEnvKeyForUser,
} from "@kofre/crypto";
import { ApiError, api, clearSession, readSession, requireSession, revokeSession, serviceToken, vaultKey } from "./config";
import { loginWithBrowser } from "./cli-login";
import { MAX_VALUE_BYTES, SECRET_NAME, gitignoreWarns, kofreHeader, parseEnvFile, readTomlProject, serializeEnv, tomlFor, isReservedName } from "./envfile";
import { choosePullTarget } from "./pull-target";
import { isNetworkError, readCache, saveCache } from "./offline";
import { promptHidden } from "./prompt";
import { printTable, when } from "./table";
import { runUiCommand } from "./ui-launch";
import { envKeyFor, environmentFor, loadProject, readSecrets, writeSecrets, type EnvironmentRow, type ProjectRow, type SecretRow } from "./secrets";
import { notifyUpdate } from "./update-check";
import { isPatchedNode } from "./node-version";
import { needsCmdShell, quoteForCmd } from "./win-command";
import { listMembers, listTokens, rotateEnvironment, wrapsForMembers, memberPrincipals } from "./sharing";
import { forgetKey, listKeys, pinKey, verifyPrincipals } from "./known-keys";
import { createServiceTokenMaterial, fingerprint, formatServiceToken } from "@kofre/crypto";

declare const __KOFRE_VERSION__: string | undefined;
const VERSION = typeof __KOFRE_VERSION__ === "string" ? __KOFRE_VERSION__ : "dev";


const program = new Command();
// exitOverride: commander lanza en vez de salir (--version, --help, comando desconocido), así el aviso de versión también sale ahí.
program.name("kofre").description("Secretos cifrados en el cliente").version(VERSION).exitOverride();
// Las opciones del programa (--version, --help) solo cuentan antes del subcomando; así run puede pasarlas a su comando.
program.enablePositionalOptions();

program
  .command("login")
  .description("Abre el navegador para autorizar esta máquina con tu sesión de Kofre")
  .action(async () => {
    await loginWithBrowser();
  });

program
  .command("logout")
  .description("Cierra la sesión: la revoca en el servidor y borra la sesión local y la clave del llavero")
  .action(async () => {
    const session = readSession();
    if (!session) {
      console.log("No hay ninguna sesión iniciada en este equipo.");
      return;
    }
    const revoked = await revokeSession(session.token);
    clearSession();
    if (revoked) console.log(`Sesión de ${session.email} cerrada y revocada en el servidor.`);
    else console.log("Sesión local borrada, pero sin conexión no se pudo revocar en el servidor. Revócala en Dispositivos.");
  });

program
  .command("lock")
  .description("Olvida la clave privada guardada en el llavero; la próxima operación pedirá la contraseña")
  .action(async () => {
    const { clearVaultKey } = await import("./vault-store");
    clearVaultKey();
    console.log("Bóveda bloqueada.");
  });

program
  .command("unlock")
  .description("Pide la contraseña maestra y deja la clave en el llavero; así `kofre mcp` y los agentes no la necesitan")
  .option("--env <slugs>", "solo estos ambientes del proyecto vinculado (separados por coma): la clave privada no se guarda y un agente no alcanza los demás, por ejemplo prod")
  .action(async (opts: { env?: string }) => {
    const minutes = process.env.KOFRE_VAULT_TTL_MIN ?? 720;
    if (!opts.env) {
      await vaultKey({ persist: true });
      console.log(`Bóveda desbloqueada durante ${minutes} minutos (todos los proyectos y ambientes). Para limitarla: kofre unlock --env dev`);
      return;
    }
    const { envCacheKey } = await import("./secrets");
    const { readEnvKeys, writeEnvKeys } = await import("./vault-store");
    const project = await loadProject();
    const privateKey = await vaultKey({ persist: false });
    const keys = readEnvKeys();
    const slugs = opts.env.split(",").map((slug) => slug.trim()).filter(Boolean);
    for (const slug of slugs) {
      const environment = project.environments.find((env) => env.slug === slug);
      if (!environment) throw new Error(`No existe el ambiente ${slug}`);
      const wrap = environment.keyWraps[0]?.ciphertext;
      if (!wrap) throw new Error(`No tienes la clave del ambiente ${slug}.`);
      keys[envCacheKey(project.id, slug)] = bytesToB64(openSealedEnvKey(wrap, privateKey, { projectId: project.id, slug }));
    }
    writeEnvKeys(keys);
    console.log(`Desbloqueado ${slugs.join(", ")} de ${project.name} durante ${minutes} minutos. La clave privada no se guardó: el resto de ambientes sigue bloqueado.`);
  });

program
  .command("mcp")
  .description("Servidor MCP por stdio para agentes de IA: nombres y ejecución con secretos, nunca valores")
  .action(async () => {
    const { serveMcp } = await import("./mcp");
    await serveMcp(VERSION);
  });

program
  .command("scan")
  .description("Busca .env fuera de .gitignore y credenciales en claro en configuraciones de agentes (MCP, Claude, Cursor)")
  .option("--json", "salida en JSON")
  .action(async (opts: { json?: boolean }) => {
    const { formatFindings, scan } = await import("./scan");
    const findings = scan();
    console.log(opts.json ? JSON.stringify(findings, null, 2) : formatFindings(findings));
    if (findings.length > 0) process.exitCode = 1;
  });

program
  .command("guard")
  .description("Prepara el proyecto para agentes de IA: ignora los .env, bloquea su lectura en Claude Code y Cursor y registra `kofre mcp`")
  .action(async () => {
    const { guard } = await import("./guard");
    for (const change of guard()) console.log(`  ${change.action.padEnd(12)} ${change.file}`);
    console.log("Listo. Los agentes usan las variables con la herramienta kofre_run; ejecuta `kofre unlock` antes de empezar.");
  });

/** Mi propia entrada en la lista de miembros, con la clave pública derivada de mi clave privada (no la que diga el servidor). */
function selfOf(members: { userId: string; email: string }[], email: string, privateKey: Uint8Array) {
  const me = members.find((member) => member.email === email);
  return me ? { userId: me.userId, publicKey: bytesToB64(publicKeyOf(privateKey)) } : undefined;
}

/** Id de proyecto generado en el cliente (32 hex): la API lo acepta tal cual si está libre. */
const newProjectId = () => randomUUID().replaceAll("-", "");

const keys = program.command("keys").description("Claves públicas confiadas de miembros y tokens (se fijan la primera vez que las confirmas)");
keys.command("list").action(() => {
  printTable(["TIPO", "ID", "HUELLA"], listKeys().map((row) => [row.kind === "user" ? "usuario" : "token", row.id, row.fingerprint]), "Todavía no has confirmado ninguna clave.");
});
keys
  .command("forget")
  .description("Olvida una clave fijada; la próxima vez que aparezca se volverá a pedir confirmación")
  .argument("<id>", "id de usuario o de token")
  .action((id: string) => {
    const had = forgetKey("user", id) || forgetKey("token", id);
    console.log(had ? "Clave olvidada." : "No había ninguna clave fijada con ese id.");
  });

const projects = program.command("projects").description("Proyectos");

projects.command("list").action(async () => {
  const session = requireSession();
  const rows = await api<ProjectRow[]>("/projects", {}, session.token);
  printTable(
    ["ID", "NOMBRE"],
    rows.map((row) => [row.id, row.name]),
    "No tienes proyectos. Crea uno con `kofre projects create --name <nombre>`.",
  );
});

projects
  .command("create")
  .requiredOption("--name <name>", "nombre")
  .option("--envs <slugs>", "ambientes separados por coma", "dev,staging,prod")
  .action(async (opts: { name: string; envs: string }) => {
    const session = requireSession();
    const publicKey = b64ToBytes(session.publicKey);
    // El id lo genera el cliente: así la clave de cada ambiente queda ligada al proyecto desde el primer sellado.
    const id = newProjectId();
    const environments = opts.envs
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean)
      .map((slug) => ({ slug, keyWrap: sealEnvKeyForUser(generateEnvKey(), publicKey, { projectId: id, slug }) }));
    const created = await api<ProjectRow>(
      "/projects",
      { method: "POST", body: JSON.stringify({ id, name: opts.name, environments }) },
      session.token,
    );
    console.log(created.id);
  });

projects
  .command("delete")
  .description("Borra un proyecto con todos sus ambientes y secretos")
  .argument("<id>", "id del proyecto")
  .option("--yes", "no pedir confirmación")
  .action(async (id: string, opts: { yes?: boolean }) => {
    const session = requireSession();
    if (!opts.yes) {
      const answer = await promptHidden(`Escribe el id ${id} para confirmar`);
      if (answer !== id) throw new Error("Cancelado.");
    }
    await api(`/projects/${id}`, { method: "DELETE" }, session.token);
    console.log("Proyecto borrado.");
  });

program
  .command("init")
  .description("Vincula esta carpeta a un proyecto para no repetir --project en cada comando")
  .requiredOption("--project <id>", "id del proyecto (kofre projects list)")
  .option("--env <slug>", "ambiente por defecto", "dev")
  .action(async (opts: { project: string; env: string }) => {
    const session = requireSession();
    let project: ProjectRow | null = null;
    try {
      project = await api<ProjectRow>(`/projects/${opts.project}`, {}, session.token);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        throw new Error(`No existe el proyecto ${opts.project} o no tienes acceso. Mira tus proyectos con \`kofre projects list\`.`);
      }
      if (!isNetworkError(error)) throw error;
    }
    if (project && !project.environments.some((env) => env.slug === opts.env)) {
      const slugs = project.environments.map((env) => env.slug).join(", ");
      throw new Error(`${project.name} no tiene el ambiente ${opts.env}. Ambientes: ${slugs}.`);
    }
    writeFileSync(".kofre.toml", tomlFor(opts.project, opts.env));
    console.log(
      project
        ? `Carpeta vinculada a ${project.name} (ambiente por defecto: ${opts.env}).`
        : "Carpeta vinculada sin comprobar el proyecto (sin conexión).",
    );
    console.log(".kofre.toml solo guarda el id del proyecto y el ambiente, nunca secretos: puedes subirlo a git para que tu equipo use el mismo.");
  });

const envs = program.command("envs").description("Ambientes del proyecto vinculado");

envs
  .command("list")
  .description("Lista los ambientes del proyecto")
  .action(async () => {
    const project = await loadProject();
    printTable(
      ["AMBIENTE", "ID", "NOMBRE"],
      project.environments.map((env) => [env.slug, env.id, env.name]),
      "El proyecto no tiene ambientes.",
    );
  });

envs
  .command("create")
  .description("Crea un ambiente con una clave nueva sellada para tu cuenta")
  .argument("<slug>", "slug en minúsculas, por ejemplo qa")
  .option("--name <name>", "nombre legible")
  .option("--yes", "aceptar claves públicas aún no confirmadas sin preguntar una a una")
  .action(async (slug: string, opts: { name?: string; yes?: boolean }) => {
    const session = requireSession();
    const project = await loadProject();
    const members = await listMembers(project.id, session.token);
    const privateKey = await vaultKey();
    await verifyPrincipals(memberPrincipals(members), { self: selfOf(members, session.email, privateKey), trustNew: opts.yes });
    const created = await api<EnvironmentRow>(
      `/projects/${project.id}/environments`,
      { method: "POST", body: JSON.stringify({ slug, name: opts.name, keyWraps: wrapsForMembers(generateEnvKey(), members, { projectId: project.id, slug }) }) },
      session.token,
    );
    console.log(`${created.slug}\t${created.id}`);
  });

const members = program.command("members").description("Personas con acceso al proyecto vinculado");

members
  .command("list")
  .action(async () => {
    const session = requireSession();
    const project = await loadProject();
    printTable(
      ["ROL", "EMAIL", "HUELLA"],
      (await listMembers(project.id, session.token)).map((member) => [
        member.role,
        member.email,
        fingerprint(b64ToBytes(member.publicKey)),
      ]),
      "El proyecto no tiene miembros.",
    );
  });

members
  .command("add")
  .description("Comparte el proyecto con una cuenta existente; muestra su huella para que la verifiques")
  .argument("<email>")
  .option("--role <role>", "editor o reader", "reader")
  .option("--yes", "no pedir confirmación de la huella")
  .action(async (email: string, opts: { role: string; yes?: boolean }) => {
    const session = requireSession();
    const project = await loadProject();
    const user = await api<{ id: string; email: string; publicKey: string }>(`/users/lookup?email=${encodeURIComponent(email)}`, {}, session.token);
    console.log(`${user.email}\nHuella: ${fingerprint(b64ToBytes(user.publicKey))}`);
    // Confirmada la huella, la clave queda fijada: en rotaciones futuras tiene que seguir siendo esta.
    await verifyPrincipals([{ kind: "user", id: user.id, label: user.email, publicKey: user.publicKey }], { trustNew: opts.yes });
    const privateKey = await vaultKey();
    const keyWraps = project.environments.map((env) => {
      const wrap = env.keyWraps[0]?.ciphertext;
      if (!wrap) throw new Error(`No tienes la clave del ambiente ${env.slug}.`);
      const scope = { projectId: project.id, slug: env.slug };
      return { environmentId: env.id, keyWrap: sealEnvKeyForUser(openSealedEnvKey(wrap, privateKey, scope), b64ToBytes(user.publicKey), scope) };
    });
    await api(`/projects/${project.id}/members`, { method: "POST", body: JSON.stringify({ userId: user.id, role: opts.role, keyWraps }) }, session.token);
    console.log(`${user.email} añadido como ${opts.role}.`);
  });

members
  .command("remove")
  .description("Quita a un miembro y rota las claves de cifrado de todos los ambientes")
  .argument("<email>")
  .option("--yes", "aceptar claves públicas aún no confirmadas sin preguntar una a una")
  .action(async (email: string, opts: { yes?: boolean }) => {
    const session = requireSession();
    const project = await loadProject();
    const all = await listMembers(project.id, session.token);
    const target = all.find((member) => member.email === email.trim().toLowerCase());
    if (!target) throw new Error("Esa cuenta no es miembro del proyecto.");
    const keep = all.filter((member) => member.userId !== target.userId);
    const privateKey = await vaultKey();
    const self = selfOf(all, session.email, privateKey);
    const seen = new Set<string>();
    for (const env of project.environments) {
      for (const name of await rotateEnvironment(project.id, env, privateKey, keep, session.token, { self, trustNew: opts.yes })) seen.add(`${env.slug}/${name}`);
    }
    await api(`/projects/${project.id}/members/${target.userId}`, { method: "DELETE" }, session.token);
    console.log(`${target.email} ya no tiene acceso. Claves de cifrado rotadas en ${project.environments.length} ambiente(s).`);
    if (seen.size > 0) {
      console.error(`Aviso: esa persona pudo ver los valores de ${seen.size} variable(s). Kofre no puede cambiarlos en el proveedor; rótalos tú:`);
      for (const item of [...seen].sort()) console.error(`  - ${item}`);
    }
  });

envs
  .command("delete")
  .description("Borra un ambiente y sus secretos")
  .argument("<slug>", "slug del ambiente")
  .option("--yes", "no pedir confirmación")
  .action(async (slug: string, opts: { yes?: boolean }) => {
    const session = requireSession();
    const { environment } = await environmentFor(slug);
    if (!opts.yes) {
      const answer = await promptHidden(`Escribe ${slug} para confirmar`);
      if (answer !== slug) throw new Error("Cancelado.");
    }
    await api(`/environments/${environment.id}`, { method: "DELETE" }, session.token);
    console.log(`Ambiente ${slug} borrado.`);
  });

const tokens = program.command("tokens").description("Tokens de servicio (solo lectura) para CI");

tokens
  .command("create")
  .description("Crea un token con acceso de lectura a los ambientes indicados; se muestra una sola vez")
  .requiredOption("--name <name>", "nombre, por ejemplo github-actions")
  .requiredOption("--envs <slugs>", "ambientes separados por coma")
  .option("--expires <days>", "caducidad en días")
  .action(async (opts: { name: string; envs: string; expires?: string }) => {
    const session = requireSession();
    const project = await loadProject();
    const privateKey = await vaultKey();
    const material = createServiceTokenMaterial();
    const slugs = opts.envs.split(",").map((slug) => slug.trim()).filter(Boolean);
    const keyWraps = slugs.map((slug) => {
      const env = project.environments.find((item) => item.slug === slug);
      if (!env) throw new Error(`No existe el ambiente ${slug}`);
      const wrap = env.keyWraps[0]?.ciphertext;
      if (!wrap) throw new Error(`No tienes la clave del ambiente ${slug}.`);
      const scope = { projectId: project.id, slug };
      return { environmentId: env.id, keyWrap: sealEnvKeyForUser(openSealedEnvKey(wrap, privateKey, scope), b64ToBytes(material.publicKey), scope) };
    });
    const created = await api<{ id: string }>(
      `/projects/${project.id}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          name: opts.name,
          secretHash: material.secretHash,
          publicKey: material.publicKey,
          expiresInDays: opts.expires ? Number(opts.expires) : undefined,
          keyWraps,
        }),
      },
      session.token,
    );
    pinKey("token", created.id, material.publicKey);
    console.error("Guarda este token ahora; no se puede volver a ver. Úsalo como KOFRE_TOKEN en tu CI (solo lectura).");
    console.log(formatServiceToken(created.id, material.secret));
  });

tokens
  .command("list")
  .action(async () => {
    const session = requireSession();
    const project = await loadProject();
    printTable(
      ["ID", "NOMBRE", "ESTADO", "AMBIENTES", "ÚLTIMO USO"],
      (await listTokens(project.id, session.token)).map((item) => [
        item.id,
        item.name,
        item.revokedAt ? "revocado" : item.active ? "activo" : "caducado",
        item.environments.map((env) => env.slug).join(","),
        item.lastUsedAt ? when(item.lastUsedAt) : "nunca usado",
      ]),
      "No hay tokens de servicio. Crea uno con `kofre tokens create`.",
    );
  });

tokens
  .command("revoke")
  .argument("<id>")
  .action(async (id: string) => {
    const session = requireSession();
    const project = await loadProject();
    await api(`/projects/${project.id}/tokens/${id}`, { method: "DELETE" }, session.token);
    console.log("Token revocado.");
  });

program
  .command("history")
  .description("Versiones anteriores de una variable")
  .argument("<name>", "nombre de la variable")
  .option("--env <slug>", "ambiente")
  .option("--show", "muestra los valores descifrados")
  .action(async (name: string, opts: { env?: string; show?: boolean }) => {
    const session = requireSession();
    const { project, environment } = await environmentFor(opts.env);
    const rows = await api<SecretRow[]>(`/environments/${environment.id}/secrets`, {}, session.token);
    const row = rows.find((item) => item.name === name);
    if (!row) throw new Error(`No existe ${name} en ${environment.slug}.`);
    const versions = await api<{ version: number; ciphertext: string; createdAt: string }[]>(
      `/environments/${environment.id}/secrets/${row.id}/versions`,
      {},
      session.token,
    );
    const key = opts.show ? await envKeyFor(environment, project.id) : null;
    printTable(
      ["VERSIÓN", "FECHA", "VALOR"],
      versions.map((entry) => [
        `v${entry.version}`,
        when(entry.createdAt),
        key
          ? decryptSecret(key, entry.ciphertext, { projectId: project.id, environmentId: environment.id, name, version: entry.version })
          : "••••••••",
      ]),
      `${name} no tiene versiones anteriores.`,
    );
  });

program
  .command("push")
  .description("Sube un archivo .env al ambiente (cifrado en el cliente)")
  .argument("<file>", "archivo .env")
  .option("--env <slug>", "ambiente")
  .action(async (file: string, opts: { env?: string }) => {
    const values = parseEnvFile(readFileSync(file, "utf8"));
    const { changed, unchanged } = await writeSecrets(values, opts.env);
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const parts = [plural(changed, "variable cifrada y subida", "variables cifradas y subidas")];
    if (unchanged) parts.push(plural(unchanged, "sin cambios", "sin cambios"));
    console.log(`${parts.join(", ")}.`);
  });

program
  .command("import")
  .description("Sube al ambiente lo que exporta otra herramienta: .env, JSON de Doppler o de Infisical")
  .argument("<file>", "archivo exportado (.env o .json)")
  .option("--env <slug>", "ambiente")
  .action(async (file: string, opts: { env?: string }) => {
    const { parseImport } = await import("./import");
    const values = parseImport(readFileSync(file, "utf8"));
    if (Object.keys(values).length === 0) throw new Error(`${file} no contiene variables que importar.`);
    const { changed, unchanged } = await writeSecrets(values, opts.env);
    console.log(`${changed} variables importadas y cifradas${unchanged ? `, ${unchanged} sin cambios` : ""}.`);
  });

program
  .command("set")
  .argument("<name>", "nombre de la variable")
  .option("--env <slug>", "ambiente")
  .action(async (name: string, opts: { env?: string }) => {
    if (!SECRET_NAME.test(name)) throw new Error("Nombre no válido. Usa letras, dígitos y guion bajo.");
    const value = await promptHidden(`Valor de ${name}`);
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new Error(`El valor supera ${MAX_VALUE_BYTES / 1024} KiB.`);
    const { changed } = await writeSecrets({ [name]: value }, opts.env);
    console.log(changed ? `${name} actualizada.` : `${name} ya tenía ese valor; no se creó otra versión.`);
  });

program
  .command("pull")
  .description("Genera un archivo .env descifrado en tu máquina")
  .option("--env <slug>", "ambiente")
  .option("-o, --output <file>", "archivo de salida", ".env")
  .option("--force", "reemplaza un archivo que no generó Kofre o con cambios locales (deja una copia)")
  .option("--no-backup", "con --force, reemplaza sin dejar copia del archivo anterior")
  .action(async (opts: { env?: string; output: string; force?: boolean; backup: boolean }) => {
    const { project, environment, values } = await readSecrets(opts.env);
    const file = await choosePullTarget(
      opts.output,
      { projectId: project.id, slug: environment.slug, remote: values },
      { force: Boolean(opts.force), backup: opts.backup },
    );
    if (!file) {
      console.log("Cancelado. No se escribió nada.");
      return;
    }
    const body = serializeEnv(values);
    writeFileSync(file, kofreHeader(project.name, project.id, environment.slug, body) + body, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows.
    }
    const warning = gitignoreWarns(file);
    if (warning) console.error(warning);
    console.log(`Escrito ${file} (${Object.keys(values).length} variables)`);
  });

program
  .command("run")
  .description("Ejecuta un comando con las variables del ambiente en memoria")
  .option("--env <slug>", "ambiente")
  .argument("[cmd...]")
  .allowUnknownOption()
  // Todo lo que va después del comando es suyo: PowerShell se come el `--` al lanzar kofre.ps1, y sin esto
  // `kofre run -- pnpm --version` imprimía la versión de kofre.
  .passThroughOptions()
  .action(async (cmd: string[], opts: { env?: string }) => {
    const separator = process.argv.indexOf("--");
    const command = separator >= 0 ? process.argv.slice(separator + 1) : cmd;
    if (command.length === 0) {
      throw new Error("Indica un comando después de --. Para exportar un .env: kofre pull --env dev -o .env");
    }
    const { values: secrets } = await readSecrets(opts.env);
    const env = { ...process.env, ...Object.fromEntries(Object.entries(secrets).filter(([key]) => !isReservedName(key))) };
    // Con cmd.exe se pasa una sola línea ya entrecomillada: Node concatena los argumentos igual (y avisa con DEP0190).
    const child = needsCmdShell(command[0])
      ? spawn(command.map(quoteForCmd).join(" "), { stdio: "inherit", shell: true, env })
      : spawn(command[0], command.slice(1), { stdio: "inherit", env });
    child.on("error", (error: NodeJS.ErrnoException) => {
      console.error(
        error.code === "ENOENT"
          ? `No se encontró el comando "${command[0]}". Comprueba que está instalado y en el PATH.`
          : `No se pudo ejecutar "${command[0]}": ${error.message}`,
      );
      process.exitCode = 127;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  });

const sync = program.command("sync").description("Envía las variables de un ambiente a otro servicio, descifradas en esta máquina");

/** Lee el ambiente, o solo lista los nombres con --dry-run. Devuelve null cuando no hay que enviar nada. */
async function syncValues(slug: string | undefined, dryRun: boolean | undefined, where: string) {
  const { environment, values } = await readSecrets(slug);
  const names = Object.keys(values).sort();
  if (names.length === 0) {
    console.log(`El ambiente ${environment.slug} no tiene variables.`);
    return null;
  }
  if (dryRun) {
    console.log(`Se enviarían ${names.length} variables de ${environment.slug} a ${where}:\n  ${names.join("\n  ")}`);
    return null;
  }
  return { environment, values };
}

sync
  .command("vercel")
  .description("Variables de entorno de un proyecto de Vercel (dev → development, staging → preview, prod → production)")
  .option("--env <slug>", "ambiente")
  .option("--project <id>", "proyecto de Vercel; por defecto el de .vercel/project.json")
  .option("--team <id>", "equipo de Vercel; por defecto el de .vercel/project.json")
  .option("--target <target>", "production, preview o development")
  .option("--token <token>", "token de Vercel (o VERCEL_TOKEN, o la sesión de `vercel login`)")
  .option("--dry-run", "solo lista las variables que se enviarían")
  .action(async (opts: { env?: string; project?: string; team?: string; target?: string; token?: string; dryRun?: boolean }) => {
    const { pushVercel, vercelProject, vercelTarget, vercelToken } = await import("./sync");
    const linked = vercelProject();
    const project = opts.project ?? linked?.projectId;
    if (!project) throw new Error("Indica --project o ejecuta `vercel link` en esta carpeta.");
    const team = opts.team ?? (linked?.orgId.startsWith("team_") ? linked.orgId : undefined);
    const read = await syncValues(opts.env, opts.dryRun, `Vercel (${project})`);
    if (!read) return;
    const target = opts.target ?? vercelTarget(read.environment.slug);
    const sent = await pushVercel({ project, team, target, token: vercelToken(opts.token), values: read.values });
    console.log(`${sent} variables de ${read.environment.slug} enviadas a Vercel (${project} · ${target}).`);
  });

sync
  .command("fly")
  .description("Secretos de una app de Fly.io (Fly despliega una versión nueva al aplicarlos)")
  .option("--env <slug>", "ambiente")
  .option("--app <name>", "app de Fly; por defecto la de fly.toml")
  .option("--token <token>", "token de Fly (o FLY_API_TOKEN, o la sesión de `fly auth login`)")
  .option("--dry-run", "solo lista las variables que se enviarían")
  .action(async (opts: { env?: string; app?: string; token?: string; dryRun?: boolean }) => {
    const { flyAppFromToml, flyToken, pushFly } = await import("./sync");
    const app = opts.app ?? (existsSync("fly.toml") ? flyAppFromToml(readFileSync("fly.toml", "utf8")) : null);
    if (!app) throw new Error("Indica --app o crea fly.toml en esta carpeta.");
    const read = await syncValues(opts.env, opts.dryRun, `Fly (${app})`);
    if (!read) return;
    const sent = await pushFly({ app, token: flyToken(opts.token), values: read.values });
    console.log(`${sent} variables de ${read.environment.slug} enviadas a Fly (${app}). Fly está desplegando la versión nueva.`);
  });

sync
  .command("github")
  .description("Secretos de GitHub Actions de un repositorio (cifrados con la clave pública del repo)")
  .option("--env <slug>", "ambiente")
  .option("--repo <owner/name>", "repositorio; por defecto el remoto origin")
  .option("--environment <name>", "environment de GitHub; sin él, secretos del repositorio")
  .option("--token <token>", "token de GitHub (o GITHUB_TOKEN, o la sesión de `gh auth login`)")
  .option("--dry-run", "solo lista las variables que se enviarían")
  .action(async (opts: { env?: string; repo?: string; environment?: string; token?: string; dryRun?: boolean }) => {
    const { githubToken, pushGithub, repoFromRemote } = await import("./sync");
    const { execFileSync } = await import("node:child_process");
    const remote = () => {
      try {
        return repoFromRemote(execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      } catch {
        return null;
      }
    };
    const repo = opts.repo ?? remote();
    if (!repo) throw new Error("Indica --repo owner/nombre; no hay un remoto origin de GitHub.");
    const where = `GitHub (${repo}${opts.environment ? ` · ${opts.environment}` : ""})`;
    const read = await syncValues(opts.env, opts.dryRun, where);
    if (!read) return;
    const sent = await pushGithub({ repo, environment: opts.environment, token: githubToken(opts.token), values: read.values });
    console.log(`${sent} variables de ${read.environment.slug} enviadas a ${where}.`);
  });

program
  .command("ui")
  .description("Interfaz interactiva: elige un comando, responde sus preguntas y Kofre lo ejecuta")
  .action(() => runUiCommand(VERSION));

program
  .command("devices")
  .description("Dispositivos con sesión en tu cuenta")
  .action(async () => {
    const session = requireSession();
    const rows = await api<{ id: string; name: string; lastSeenAt: string; current?: boolean }[]>("/devices", {}, session.token);
    // Cada inicio de sesión es un dispositivo; las pestañas del navegador comparten uno.
    printTable(
      ["ID", "NOMBRE", "ÚLTIMO USO", ""],
      rows.map((row) => [row.id, row.name, when(row.lastSeenAt), row.current ? "← esta terminal" : ""]),
      "No hay dispositivos con sesión.",
    );
  });

program
  .command("whoami")
  .alias("status")
  .description("Con qué cuenta, dispositivo y proyecto estás")
  .action(async () => {
    const session = requireSession();
    const rows: [string, string][] = [
      ["Cuenta", session.email],
      ["API", session.apiUrl],
    ];
    // Un token de servicio no es un dispositivo ni guarda la clave en el llavero. /devices también comprueba que la sesión sigue viva.
    if (!serviceToken()) {
      const devices = await api<{ id: string; name: string; current?: boolean }[]>("/devices", {}, session.token);
      const device = devices.find((row) => row.current);
      const { readVaultKey } = await import("./vault-store");
      rows.push(
        ["Dispositivo", device ? `${device.name} (${device.id})` : "desconocido"],
        ["Bóveda", readVaultKey() ? "desbloqueada" : "bloqueada (pedirá la contraseña)"],
      );
    }
    const linked = readTomlProject();
    if (linked) {
      const project = await api<ProjectRow>(`/projects/${linked.projectId}`, {}, session.token).catch(() => null);
      rows.push(
        ["Proyecto", project ? `${project.name} (${project.id})` : `${linked.projectId} (sin acceso o no existe)`],
        ["Ambiente", linked.defaultEnv],
      );
    } else {
      rows.push(["Proyecto", "esta carpeta no está vinculada (kofre init)"]);
    }
    const width = Math.max(...rows.map(([label]) => label.length)) + 1;
    for (const [label, value] of rows) console.log(`${`${label}:`.padEnd(width)} ${value}`);
  });


// npm solo avisa con "engines"; aquí se corta de verdad. Los binarios SEA llevan su propio Node y pasan siempre.
if (!isPatchedNode(process.version)) {
  console.error(`kofre necesita un Node sin vulnerabilidades conocidas (22.23.4+, 24.22.1+ o 26.12.1+). Tienes ${process.version}.`);
  process.exit(1);
}

program
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    // Commander ya escribió la versión, la ayuda o su error; solo falta su código de salida.
    if (error instanceof CommanderError) return void (process.exitCode = error.exitCode);
    const message = error instanceof Error ? error.message : "Error";
    console.error(message);
    // exitCode en vez de exit(): deja vaciar stderr cuando es una tubería (Windows aborta si se corta a medias).
    process.exitCode = 1;
  })
  .then(() => notifyUpdate(VERSION));
