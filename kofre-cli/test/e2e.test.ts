import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAccountMaterial, decryptSecret, openSealedEnvKey, unlockAccount } from "@kofre/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { spawnKofre } from "../src/ui-launch";

// Corre contra una API real (KOFRE_API_URL, por defecto :3001). Si no responde, se omite.
const API = process.env.KOFRE_API_URL ?? "http://localhost:3001";
const PASSWORD = "contraseña-cli-e2e-123";
const root = resolve(__dirname, "..");
const dist = join(root, "dist", "kofre.js");

let home: string;
let work: string;
let apiUp = false;
let token = "";
let privateKey: Uint8Array;
let firstProjectId = "";

// Ejecuta el artefacto empaquetado (pnpm build) o, con KOFRE_BIN, un ejecutable SEA; sin shell para que las comillas lleguen intactas.
const seaBinary = process.env.KOFRE_BIN;

function kofre(args: string[], extraEnv: Record<string, string> = {}, input?: string) {
  // Sin NODE_OPTIONS: el worker de vitest inyecta loaders que harían abortar al proceso hijo.
  const { NODE_OPTIONS: _nodeOptions, NODE_CHANNEL_FD: _channel, ...baseEnv } = process.env;
  const [command, prefix] = seaBinary ? [seaBinary, []] : [process.execPath, [dist]];
  const result = spawnSync(command, [...prefix, ...args], {
    cwd: work,
    encoding: "utf8",
    input,
    env: {
      ...baseEnv,
      KOFRE_HOME: home,
      KOFRE_API_URL: API,
      KOFRE_PASSWORD: PASSWORD,
      KOFRE_VAULT_FILE: "1",
      ...extraEnv,
    },
  });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

beforeAll(async () => {
  try {
    apiUp = existsSync(seaBinary ?? dist) && (await fetch(`${API}/health`)).ok;
  } catch {
    apiUp = false;
  }
  if (!apiUp) {
    console.warn("e2e de la CLI omitido: falta dist/kofre.js (pnpm build) o la API no responde en", API);
    return;
  }

  home = mkdtempSync(join(tmpdir(), "kofre-home-"));
  work = mkdtempSync(join(tmpdir(), "kofre-work-"));
  const email = `cli-${Date.now()}@kofre.test`;
  const material = await createAccountMaterial(PASSWORD);
  const response = await fetch(`${API}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      salt: material.salt,
      kdfParams: material.kdfParams,
      authVerifier: material.authVerifier,
      publicKey: material.publicKey,
      wrappedPrivateKey: material.wrappedPrivateKey,
      recoveryWrap: material.recoveryWrap,
      recoveryVerifier: material.recoveryVerifier,
      deviceName: "cli-e2e",
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const session = (await response.json()) as { token: string };
  token = session.token;
  privateKey = (await unlockAccount(PASSWORD, material.salt, material.wrappedPrivateKey, material.kdfParams)).privateKey;
  // Equivale a lo que deja `kofre login` (el login real tiene su propio test al final).
  writeFileSync(
    join(home, "session.json"),
    JSON.stringify({
      apiUrl: API,
      token,
      email,
      salt: material.salt,
      kdfParams: material.kdfParams,
      wrappedPrivateKey: material.wrappedPrivateKey,
      publicKey: material.publicKey,
    }),
  );
}, 60_000);

describe("CLI contra la API", () => {
  it("push, pull, set y run mantienen los valores y el servidor solo ve ciphertext", async (ctx) => {
    if (!apiUp) return ctx.skip();

    const created = kofre(["projects", "create", "--name", "cli-e2e"]);
    expect(created.code, created.err).toBe(0);
    const projectId = created.out;
    firstProjectId = projectId;
    expect(projectId).toMatch(/^[a-z0-9]+$/);

    expect(kofre(["init", "--project", projectId, "--env", "dev"]).code).toBe(0);
    expect(readFileSync(join(work, ".kofre.toml"), "utf8")).not.toContain(token);

    writeFileSync(join(work, "input.env"), 'DB_URL="postgres://u:p@h/db?x=1"\nMULTI="a\\nb"\nTOKEN=abc123\n');
    const push = kofre(["push", "input.env"]);
    expect(push.code, push.err).toBe(0);
    expect(push.out).toContain("3 variables");

    // Repetir el push no crea versiones nuevas de valores idénticos.
    const pushAgain = kofre(["push", "input.env"]);
    expect(pushAgain.code, pushAgain.err).toBe(0);
    expect(pushAgain.out).toBe("0 variables cifradas y subidas, 3 sin cambios.");

    const pull = kofre(["pull", "-o", "out.env"]);
    expect(pull.code, pull.err).toBe(0);
    expect(pull.err).toContain(".gitignore");
    const { parse } = await import("dotenv");
    const values = parse(readFileSync(join(work, "out.env"), "utf8"));
    expect(values).toEqual({ DB_URL: "postgres://u:p@h/db?x=1", MULTI: "a\nb", TOKEN: "abc123" });

    const set = kofre(["set", "TOKEN"], { KOFRE_PASSWORD: "valor-nuevo" });
    expect(set.code, set.err).toBe(0);

    const run = kofre(["run", "--", "node", "-e", "console.log(process.env.TOKEN + '|' + process.env.DB_URL)"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("valor-nuevo|postgres://u:p@h/db?x=1");

    // Sin `--` (PowerShell se lo come al lanzar kofre.ps1): las opciones de después del comando son del comando.
    const noSeparator = kofre(["run", "node", "--version"]);
    expect(noSeparator.code, noSeparator.err).toBe(0);
    expect(noSeparator.out).toBe(process.version);

    const project = (await (
      await fetch(`${API}/projects/${projectId}`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { environments: { id: string; slug: string; keyWraps: { ciphertext: string }[] }[] };
    const dev = project.environments.find((env) => env.slug === "dev")!;
    const rows = (await (
      await fetch(`${API}/environments/${dev.id}/secrets`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { name: string; ciphertext: string; version: number }[];
    const tokenRow = rows.find((row) => row.name === "TOKEN")!;
    expect(tokenRow.version).toBe(2);
    expect(rows.find((row) => row.name === "DB_URL")!.version).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("valor-nuevo");
    const envKey = openSealedEnvKey(dev.keyWraps[0].ciphertext, privateKey);
    expect(decryptSecret(envKey, tokenRow.ciphertext, { projectId, environmentId: dev.id, name: "TOKEN", version: 2 })).toBe("valor-nuevo");
    expect(kofre(["set", "TOKEN"], { KOFRE_PASSWORD: "valor-nuevo" }).out).toContain("ya tenía ese valor");
  }, 120_000);

  it("ambientes, historial y copia local sin red", async (ctx) => {
    if (!apiUp) return ctx.skip();
    const created = kofre(["projects", "create", "--name", "cli-fase3", "--envs", "dev"]);
    expect(created.code, created.err).toBe(0);
    expect(kofre(["init", "--project", created.out]).code).toBe(0);

    const qa = kofre(["envs", "create", "qa", "--name", "QA"]);
    expect(qa.code, qa.err).toBe(0);
    expect(qa.out).toMatch(/^qa\t/);
    expect(kofre(["envs", "list"]).out.split("\n")).toHaveLength(2);

    writeFileSync(join(work, "qa.env"), "FLAG=uno\n");
    expect(kofre(["push", "qa.env", "--env", "qa"]).code).toBe(0);
    expect(kofre(["set", "FLAG", "--env", "qa"], { KOFRE_PASSWORD: "dos" }).code).toBe(0);
    const history = kofre(["history", "FLAG", "--env", "qa", "--show"]);
    expect(history.code, history.err).toBe(0);
    expect(history.out.split("\n").map((line) => line.split("\t")[0])).toEqual(["v2", "v1"]);
    expect(history.out).toContain("\tdos");
    expect(history.out).toContain("\tuno");

    const pull = kofre(["pull", "--env", "qa", "-o", "qa-out.env"]);
    expect(pull.code, pull.err).toBe(0);
    const offline = kofre(["pull", "--env", "qa", "-o", "qa-offline.env"], { KOFRE_API_URL: "http://127.0.0.1:9" });
    expect(offline.code, offline.err).toBe(0);
    expect(offline.err).toContain("Sin conexión");
    expect(readFileSync(join(work, "qa-offline.env"), "utf8")).toMatch(/^# kofre: cli-fase3\/qa \(.*\nFLAG=dos\n$/);
    const noCache = kofre(["pull", "--env", "dev", "-o", "dev-offline.env"], { KOFRE_API_URL: "http://127.0.0.1:9" });
    expect(noCache.code).toBe(1);
    expect(noCache.err).toContain("sin copia local");

    expect(kofre(["envs", "delete", "qa", "--yes"]).code).toBe(0);
    expect(kofre(["envs", "delete", "dev", "--yes"]).code).toBe(1);
    expect(kofre(["projects", "delete", created.out, "--yes"]).code).toBe(0);
    expect(kofre(["envs", "list"]).code).toBe(1);
  }, 120_000);

  it("comparte con otra cuenta, el invitado descifra, y al quitarlo se rota la clave", async (ctx) => {
    if (!apiUp) return ctx.skip();
    expect(kofre(["init", "--project", firstProjectId]).code).toBe(0);
    const guestEmail = `guest-${Date.now()}@kofre.test`;
    const guestMaterial = await createAccountMaterial("guest-pass-123456");
    const guestRegister = await fetch(`${API}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: guestEmail,
        salt: guestMaterial.salt,
        kdfParams: guestMaterial.kdfParams,
        authVerifier: guestMaterial.authVerifier,
        publicKey: guestMaterial.publicKey,
        wrappedPrivateKey: guestMaterial.wrappedPrivateKey,
        recoveryWrap: guestMaterial.recoveryWrap,
        recoveryVerifier: guestMaterial.recoveryVerifier,
      }),
    });
    const guest = (await guestRegister.json()) as { token: string; user: { id: string } };
    const guestKey = (await unlockAccount("guest-pass-123456", guestMaterial.salt, guestMaterial.wrappedPrivateKey, guestMaterial.kdfParams)).privateKey;

    const added = kofre(["members", "add", guestEmail, "--role", "reader", "--yes"]);
    expect(added.code, added.err).toBe(0);
    expect(added.out).toMatch(/Huella: [0-9a-f]{4} [0-9a-f]{4}/);
    expect(kofre(["members", "list"]).out).toContain(`reader\t${guestEmail}`);

    const project = (await (await fetch(`${API}/projects/${firstProjectId}`, { headers: { authorization: `Bearer ${guest.token}` } })).json()) as {
      environments: { id: string; slug: string; keyWraps: { ciphertext: string }[] }[];
    };
    const dev = project.environments.find((env) => env.slug === "dev")!;
    const rows = (await (await fetch(`${API}/environments/${dev.id}/secrets`, { headers: { authorization: `Bearer ${guest.token}` } })).json()) as {
      name: string; ciphertext: string; version: number;
    }[];
    const oldEnvKey = openSealedEnvKey(dev.keyWraps[0].ciphertext, guestKey);
    const tokenRow = rows.find((row) => row.name === "TOKEN")!;
    expect(decryptSecret(oldEnvKey, tokenRow.ciphertext, { projectId: firstProjectId, environmentId: dev.id, name: "TOKEN", version: tokenRow.version })).toBe("valor-nuevo");

    const removed = kofre(["members", "remove", guestEmail]);
    expect(removed.code, removed.err).toBe(0);
    expect(removed.out).toContain("rotadas");
    expect(removed.err).toContain("dev/TOKEN");
    expect((await fetch(`${API}/projects/${firstProjectId}`, { headers: { authorization: `Bearer ${guest.token}` } })).status).toBe(403);

    const after = (await (await fetch(`${API}/environments/${dev.id}/secrets`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      name: string; ciphertext: string; version: number;
    }[];
    const afterRow = after.find((row) => row.name === "TOKEN")!;
    expect(afterRow.version).toBe(tokenRow.version + 1);
    expect(() => decryptSecret(oldEnvKey, afterRow.ciphertext, { projectId: firstProjectId, environmentId: dev.id, name: "TOKEN", version: afterRow.version })).toThrow();
    const pull = kofre(["pull", "-o", "after-rotate.env"]);
    expect(pull.code, pull.err).toBe(0);
    expect(readFileSync(join(work, "after-rotate.env"), "utf8")).toContain("TOKEN=valor-nuevo");
  }, 120_000);

  it("un token de servicio lee con KOFRE_TOKEN, no escribe y muere al revocar", (ctx) => {
    if (!apiUp) return ctx.skip();
    expect(kofre(["init", "--project", firstProjectId]).code).toBe(0);
    const created = kofre(["tokens", "create", "--name", "ci", "--envs", "dev", "--expires", "7"]);
    expect(created.code, created.err).toBe(0);
    const token = created.out.trim();
    expect(token).toMatch(/^kofre_st_[a-z0-9]+\.[A-Za-z0-9_-]{43}$/);
    expect(created.err).toContain("no se puede volver a ver");

    const ciHome = mkdtempSync(join(tmpdir(), "kofre-ci-"));
    const asCi = (args: string[]) => kofre(args, { KOFRE_TOKEN: token, KOFRE_HOME: ciHome, KOFRE_PASSWORD: "" });
    const pull = asCi(["pull", "--env", "dev", "-o", "ci.env"]);
    expect(pull.code, pull.err).toBe(0);
    expect(readFileSync(join(work, "ci.env"), "utf8")).toContain("TOKEN=valor-nuevo");
    const run = asCi(["run", "--env", "dev", "--", "node", "-e", "console.log(process.env.TOKEN)"]);
    expect(run.out).toContain("valor-nuevo");
    writeFileSync(join(work, "ci-push.env"), "NUEVA=1\n");
    const push = asCi(["push", "ci-push.env"]);
    expect(push.code).toBe(1);
    expect(push.err).toMatch(/solo lectura/i);

    const list = kofre(["tokens", "list"]);
    expect(list.out).toContain("\tci\tactivo\tdev\t");
    const id = list.out.split("\t")[0];
    expect(kofre(["tokens", "revoke", id]).code).toBe(0);
    const dead = asCi(["pull", "--env", "dev", "-o", "ci2.env"]);
    expect(dead.code).toBe(1);
    expect(kofre(["tokens", "list"]).out).toContain("\tci\trevocado\t");
  }, 120_000);

  it("rechaza nombres inválidos y contraseña incorrecta", (ctx) => {
    if (!apiUp) return ctx.skip();
    expect(kofre(["init", "--project", firstProjectId]).code).toBe(0);
    writeFileSync(join(work, "bad.env"), "BAD-NAME=1\n");
    const bad = kofre(["push", "bad.env"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("BAD-NAME");

    const lock = kofre(["lock"]);
    expect(lock.code, lock.err).toBe(0);
    const wrong = kofre(["pull", "-o", "x.env"], { KOFRE_PASSWORD: "incorrecta" });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("Contraseña maestra incorrecta");
  }, 60_000);

  it("kofre login canjea el código que muestra la web y guarda la sesión", async (ctx) => {
    if (!apiUp) return ctx.skip();
    const loginHome = mkdtempSync(join(tmpdir(), "kofre-login-"));
    const { NODE_OPTIONS: _nodeOptions, NODE_CHANNEL_FD: _channel, ...baseEnv } = process.env;
    const [command, prefix] = seaBinary ? [seaBinary, []] : [process.execPath, [dist]];
    const child = spawn(command, [...prefix, "login"], {
      cwd: work,
      env: { ...baseEnv, KOFRE_HOME: loginHome, KOFRE_API_URL: API, KOFRE_NO_BROWSER: "1" },
    });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    const exited = new Promise<number | null>((done) => child.on("close", done));

    const requestId = await new Promise<string>((done, fail) => {
      const timer = setInterval(() => {
        const match = out.match(/\/cli\/connect\?request=([A-Za-z0-9]+)/);
        if (match && out.includes("Código:")) {
          clearInterval(timer);
          done(match[1]);
        }
      }, 50);
      setTimeout(() => (clearInterval(timer), fail(new Error(`login no pidió el código:\n${out}`))), 15_000);
    });

    // Lo que hace la web al pulsar "Autorizar terminal" con la sesión iniciada.
    const approve = await fetch(`${API}/auth/cli/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ requestId }),
    });
    const { code } = (await approve.json()) as { code: string };
    child.stdin.write("ZZZZ-ZZZZ\n");
    await new Promise((done) => setTimeout(done, 1500));
    child.stdin.write(`${code}\n`);

    expect(await exited, out).toBe(0);
    expect(out).toContain("Código incorrecto");
    expect(out).toContain("Sesión guardada como");
    const saved = JSON.parse(readFileSync(join(loginHome, "session.json"), "utf8")) as { token: string; apiUrl: string };
    expect(saved.apiUrl).toBe(API);
    expect((await fetch(`${API}/auth/me`, { headers: { authorization: `Bearer ${saved.token}` } })).status).toBe(200);

    // logout revoca el token en el servidor; un segundo logout no finge cerrar nada.
    const asLoginHome = (args: string[]) => kofre(args, { KOFRE_HOME: loginHome });
    expect(asLoginHome(["logout"]).out).toContain("revocada en el servidor");
    expect((await fetch(`${API}/auth/me`, { headers: { authorization: `Bearer ${saved.token}` } })).status).toBe(401);
    expect(asLoginHome(["logout"]).out).toBe("No hay ninguna sesión iniciada en este equipo.");
  }, 60_000);

  it("pull no pisa un .env ajeno ni cambios locales sin preguntar", (ctx) => {
    if (!apiUp) return ctx.skip();
    expect(kofre(["init", "--project", firstProjectId]).code).toBe(0);
    const file = join(work, "mine.env");
    const read = (name: string) => readFileSync(join(work, name), "utf8");
    writeFileSync(file, "MIO=1\n");

    // Sin terminal no pregunta: falla y deja el archivo intacto.
    const blocked = kofre(["pull", "-o", "mine.env"]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("no lo generó Kofre");
    expect(blocked.err).toContain("-o mine.env.kofre");
    expect(read("mine.env")).toBe("MIO=1\n");

    // Opción 1: escribe en el alternativo y no toca el original.
    const elsewhere = kofre(["pull", "-o", "mine.env"], { KOFRE_PROMPT: "1" }, "1\n");
    expect(elsewhere.code, elsewhere.err).toBe(0);
    expect(elsewhere.out).toContain("Escrito mine.env.kofre");
    expect(read("mine.env")).toBe("MIO=1\n");
    expect(read("mine.env.kofre")).toMatch(/^# kofre: cli-e2e\/dev \(/);

    // Opción 3: cancelar no escribe nada.
    const cancelled = kofre(["pull", "-o", "mine.env"], { KOFRE_PROMPT: "1" }, "3\n");
    expect(cancelled.out).toContain("Cancelado");
    expect(read("mine.env")).toBe("MIO=1\n");

    // --force reemplaza y guarda una copia del anterior.
    const forced = kofre(["pull", "-o", "mine.env", "--force"]);
    expect(forced.code, forced.err).toBe(0);
    const backupName = forced.err.match(/Copia del anterior en (\S+)\./)?.[1];
    expect(backupName && read(backupName)).toBe("MIO=1\n");

    // Ahora es de Kofre: un pull repetido lo actualiza sin preguntar...
    expect(kofre(["pull", "-o", "mine.env"]).code).toBe(0);
    // El flujo de "cambiar una variable y bajar el .env": pull dice qué trae y pregunta por la copia.
    const backups = () => readdirSync(work).filter((name) => name.startsWith("mine.env.backup-")).length;
    const setToken = (value: string) => expect(kofre(["set", "TOKEN"], { KOFRE_PASSWORD: value }).code).toBe(0);

    setToken("remoto-1");
    let start = backups();
    const withCopy = kofre(["pull", "-o", "mine.env"], { KOFRE_PROMPT: "1" }, "1\n");
    expect(withCopy.code, withCopy.err).toBe(0);
    expect(withCopy.err).toContain("Kofre trae cambios para mine.env:");
    expect(withCopy.err).toContain("~ TOKEN");
    expect(withCopy.err).not.toContain("remoto-1"); // los valores nunca se muestran
    expect(withCopy.err).toContain("¿Guardar una copia del mine.env actual antes de actualizarlo?");
    expect(backups()).toBe(start + 1);
    expect(read("mine.env")).toContain("TOKEN=remoto-1");

    setToken("remoto-2");
    start = backups();
    expect(kofre(["pull", "-o", "mine.env"], { KOFRE_PROMPT: "1" }, "2\n").code).toBe(0);
    expect(backups()).toBe(start);
    expect(read("mine.env")).toContain("TOKEN=remoto-2");

    setToken("remoto-3");
    expect(kofre(["pull", "-o", "mine.env"], { KOFRE_PROMPT: "1" }, "3\n").out).toContain("Cancelado");
    expect(read("mine.env")).toContain("TOKEN=remoto-2");

    // Sin terminal (scripts, CI) actualiza sin copia y deja constancia de qué cambió.
    start = backups();
    const ci = kofre(["pull", "-o", "mine.env"]);
    expect(ci.code, ci.err).toBe(0);
    expect(ci.err).toContain("~ TOKEN");
    expect(backups()).toBe(start);
    expect(read("mine.env")).toContain("TOKEN=remoto-3");

    // Sin diferencias no pregunta nada.
    const same = kofre(["pull", "-o", "mine.env"], { KOFRE_PROMPT: "1" }, "");
    expect(same.code, same.err).toBe(0);
    expect(same.err).not.toContain("Kofre trae cambios");

    // Editado a mano: pregunta y dice qué difiere; cancelar lo deja como estaba.
    writeFileSync(file, `${read("mine.env")}EXTRA=1\n`);
    const drift = kofre(["pull", "-o", "mine.env"]);
    expect(drift.code).toBe(1);
    expect(drift.err).toContain("cambios locales que no están en Kofre: EXTRA");
    expect(kofre(["pull", "-o", "mine.env"], { KOFRE_PROMPT: "1" }, "2\n").out).toContain("Cancelado");
    expect(read("mine.env")).toContain("EXTRA=1");

    // Reemplazar (1) y, a la pregunta de la copia, no (2). Las dos respuestas llegan juntas por stdin.
    const before = readdirSync(work).filter((name) => name.startsWith("mine.env.backup-")).length;
    const noCopy = kofre(["pull", "-o", "mine.env"], { KOFRE_PROMPT: "1" }, "1\n2\n");
    expect(noCopy.code, noCopy.err).toBe(0);
    expect(noCopy.err).toContain("¿Guardar una copia de mine.env antes de reemplazarlo?");
    expect(noCopy.err).toContain("mine.env reemplazado sin copia");
    expect(read("mine.env")).not.toContain("EXTRA=1");
    expect(readdirSync(work).filter((name) => name.startsWith("mine.env.backup-")).length).toBe(before);

    // En scripts: --force --no-backup tampoco deja copia.
    writeFileSync(file, "MIO=2\n");
    const forcedNoCopy = kofre(["pull", "-o", "mine.env", "--force", "--no-backup"]);
    expect(forcedNoCopy.err).toContain("reemplazado sin copia");
    expect(readdirSync(work).filter((name) => name.startsWith("mine.env.backup-")).length).toBe(before);
  });

  it("dentro de kofre ui, las preguntas viajan por IPC y la salida se captura", async (ctx) => {
    if (!apiUp || seaBinary) return ctx.skip();
    expect(kofre(["init", "--project", firstProjectId]).code).toBe(0);
    // Sin KOFRE_PASSWORD: así la contraseña también tiene que preguntarse por la interfaz.
    const { KOFRE_PASSWORD: _password, NODE_OPTIONS: _nodeOptions, NODE_CHANNEL_FD: _channel, ...baseEnv } = process.env;
    const options = { entry: dist, cwd: work, env: { ...baseEnv, KOFRE_HOME: home, KOFRE_API_URL: API, KOFRE_VAULT_FILE: "1" } };
    expect(kofre(["lock"]).code).toBe(0);

    const asked: string[] = [];
    let out = "";
    const set = spawnKofre(
      ["set", "UI_VAR", "--env", "dev"],
      {
        output: (text) => (out += text),
        ask: async (question) => {
          asked.push(`${question.hidden ? "oculta" : "visible"}: ${question.label}`);
          return question.label.startsWith("Valor") ? "desde-ui" : PASSWORD;
        },
      },
      options,
    );
    expect(await set.done, out).toBe(0);
    expect(asked).toEqual(["oculta: Valor de UI_VAR", "oculta: Contraseña maestra"]);
    expect(out).toContain("UI_VAR actualizada.");

    // La salida va a un panel, no a una tubería: las tablas llevan cabecera.
    let list = "";
    const projects = spawnKofre(["projects", "list"], { output: (text) => (list += text), ask: async () => null }, options);
    expect(await projects.done).toBe(0);
    expect(list).toMatch(/^ID\s+NOMBRE/m);

    expect(kofre(["pull", "--env", "dev", "-o", "ui.env"]).code).toBe(0);
    expect(readFileSync(join(work, "ui.env"), "utf8")).toContain("UI_VAR=desde-ui");

    // Los menús (pull sobre un archivo ajeno) llegan como opciones para el selector, no como texto numerado.
    writeFileSync(join(work, "ajeno.env"), "MIO=1\n");
    let menu: { label: string; options?: { label: string; value: string }[] } | null = null;
    let pullOut = "";
    const pull = spawnKofre(
      ["pull", "--env", "dev", "-o", "ajeno.env"],
      {
        output: (text) => (pullOut += text),
        ask: async (question) => {
          menu = question;
          return question.options?.[0].value ?? null; // "Escribir en ajeno.env.kofre y no tocar ajeno.env"
        },
      },
      options,
    );
    expect(await pull.done, pullOut).toBe(0);
    expect(menu!.label).toContain("ajeno.env ya existe y no lo generó Kofre");
    expect(menu!.options!.map((option) => option.label)).toEqual([
      "Escribir en ajeno.env.kofre y no tocar ajeno.env",
      "Reemplazar ajeno.env",
      "Cancelar",
    ]);
    expect(pullOut).not.toContain("1)");
    expect(pullOut).toContain("Escrito ajeno.env.kofre");
    expect(readFileSync(join(work, "ajeno.env"), "utf8")).toBe("MIO=1\n");
  });

  it("init comprueba que el proyecto y el ambiente existen", (ctx) => {
    if (!apiUp) return ctx.skip();
    const missing = kofre(["init", "--project", "no-existe"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("kofre projects list");
    const badEnv = kofre(["init", "--project", firstProjectId, "--env", "nope"]);
    expect(badEnv.code).toBe(1);
    expect(badEnv.err).toContain("no tiene el ambiente nope");
    const ok = kofre(["init", "--project", firstProjectId]);
    expect(ok.out).toContain("Carpeta vinculada a cli-e2e");
  });

  it("whoami dice la cuenta, el dispositivo y el proyecto, y falla sin sesión", (ctx) => {
    if (!apiUp) return ctx.skip();
    expect(kofre(["init", "--project", firstProjectId]).code).toBe(0);
    const me = kofre(["whoami"]);
    expect(me.code, me.err).toBe(0);
    expect(me.out).toMatch(/Cuenta:\s+cli-\d+@kofre\.test/);
    expect(me.out).toMatch(/Dispositivo:\s+\S/);
    expect(me.out).toContain(`(${firstProjectId})`);
    const none = kofre(["status"], { KOFRE_HOME: mkdtempSync(join(tmpdir(), "kofre-none-")) });
    expect(none.code).toBe(1);
    expect(none.err).toContain("kofre login");
  });
});
