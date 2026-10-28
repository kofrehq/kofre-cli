import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guard } from "../src/guard";
import { handle, redact } from "../src/mcp";
import { looksLikeSecret, scan, secretPaths } from "../src/scan";

const fresh = () => mkdtempSync(join(tmpdir(), "kofre-agents-"));

describe("scan", () => {
  it("encuentra .env sin ignorar, rastreados y credenciales en configs de agentes", () => {
    const cwd = fresh();
    const home = fresh();
    spawnSync("git", ["init", "-q"], { cwd });
    writeFileSync(join(cwd, ".env"), "A=1\n");
    writeFileSync(join(cwd, ".env.example"), "A=\n");
    mkdirSync(join(cwd, "api"));
    writeFileSync(join(cwd, "api", ".env.local"), "B=2\n");
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
    spawnSync("git", ["add", "-f", ".env"], { cwd });
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { gh: { env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", PORT: "3000", API_KEY: "${API_KEY}" } } } }),
    );
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { x: { env: { SECRET: "aB3dE6gH9jK2mN5pQ8sT" } } } }));

    const findings = scan(cwd, home);
    expect(findings.map((f) => [f.kind, f.file])).toEqual([
      ["env-tracked", ".env"],
      ["env-unignored", "api/.env.local"],
      ["agent-config", ".mcp.json"],
      ["agent-config", "~/.claude.json"],
    ]);
    expect(findings[2].detail).toContain("mcpServers.gh.env.GITHUB_TOKEN");
  });

  it("sin git ni .gitignore lo dice; sin hallazgos devuelve vacío", () => {
    const cwd = fresh();
    writeFileSync(join(cwd, ".env"), "A=1\n");
    expect(scan(cwd, fresh())[0].kind).toBe("env-no-gitignore");
    expect(scan(fresh(), fresh())).toEqual([]);
  });

  it("distingue credenciales de valores normales", () => {
    expect(looksLikeSecret("token", "sk-proj-abcdefghijklmnop")).toBe(true);
    expect(looksLikeSecret("DATABASE_PASSWORD", "x9Kq2mP7vL4nR8tW1zB5")).toBe(true);
    expect(looksLikeSecret("DATABASE_PASSWORD", "${DATABASE_PASSWORD}")).toBe(false);
    expect(looksLikeSecret("PORT", "aB3dE6gH9jK2mN5pQ8sT")).toBe(false);
    expect(looksLikeSecret("API_KEY", "aaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(looksLikeSecret("firstTokenDate", "2026-10-26T15:39:43.123Z")).toBe(false);
    expect(secretPaths({ a: [{ password: "x9Kq2mP7vL4nR8tW1zB5" }] })).toEqual(["a[0].password"]);
  });
});

describe("guard", () => {
  it("crea los archivos, conserva lo existente y es idempotente", () => {
    const cwd = fresh();
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n.env\n");
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git:*)"], deny: ["Read(./.env)"] } }));

    const first = guard(cwd);
    expect(first.map((c) => c.action)).toEqual(["actualizado", "actualizado", "creado", "creado", "creado"]);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("node_modules\n.env\n.env.*\n!.env.example\n");
    const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(git:*)"]);
    expect(settings.permissions.deny).toContain("Read(./**/.env.*)");
    expect(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers.kofre).toEqual({ command: "kofre", args: ["mcp"] });

    expect(guard(cwd).every((c) => c.action === "sin cambios")).toBe(true);
  });
});

describe("mcp", () => {
  it("responde initialize, tools/list, ping y rechaza métodos desconocidos", async () => {
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, "1.2.3");
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "kofre", version: "1.2.3" } } });
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, "x")).toBeNull();
    expect(await handle({ jsonrpc: "2.0", id: 2, method: "ping" }, "x")).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    const list = (await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }, "x")) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["kofre_status", "kofre_list", "kofre_run", "kofre_set"]);
    expect(await handle({ jsonrpc: "2.0", id: 4, method: "resources/list" }, "x")).toMatchObject({ error: { code: -32601 } });
  });

  it("con la bóveda bloqueada las herramientas devuelven isError sin romper el canal", async () => {
    const prev = { home: process.env.KOFRE_HOME, token: process.env.KOFRE_TOKEN, file: process.env.KOFRE_VAULT_FILE };
    process.env.KOFRE_HOME = fresh();
    process.env.KOFRE_VAULT_FILE = "1";
    delete process.env.KOFRE_TOKEN;
    try {
      const res = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "kofre_run", arguments: { command: ["node", "-v"] } } }, "x");
      expect(res).toMatchObject({ result: { isError: true } });
      expect(JSON.stringify(res)).toContain("kofre unlock");
    } finally {
      process.env.KOFRE_HOME = prev.home;
      process.env.KOFRE_TOKEN = prev.token;
      process.env.KOFRE_VAULT_FILE = prev.file;
    }
  });

  it("tacha los valores largos y deja los cortos", () => {
    const out = redact("db=postgres://u:supersecretpw@h/db port=3000 key=abcdef", { DB_PASS: "supersecretpw", PORT: "3000", KEY: "abcdef" });
    expect(out).toBe("db=postgres://u:[DB_PASS]@h/db port=3000 key=[KEY]");
  });
});

describe("redact codificado", () => {
  it("tacha el valor también en base64, hex, URL y JSON", async () => {
    const { redact } = await import("../src/mcp");
    const values = { TOKEN: "supersecretvalue123", DB: "postgres://u:p@h/db" };
    const text = [Buffer.from(values.TOKEN).toString("base64"), Buffer.from(values.TOKEN).toString("hex"), encodeURIComponent(values.DB), JSON.stringify(values.DB)].join(" ");
    expect(redact(text, values)).toBe('[TOKEN] [TOKEN] [DB] "[DB]"');
  });
});
