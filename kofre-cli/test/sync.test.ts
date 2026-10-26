import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flyAppFromToml, pushFly, pushGithub, pushVercel, repoFromRemote, vercelProject, vercelTarget } from "../src/sync";

describe("sync: resolución de destinos", () => {
  it("mapea ambientes a targets de Vercel", () => {
    expect(vercelTarget("dev")).toBe("development");
    expect(vercelTarget("prod")).toBe("production");
    expect(vercelTarget("qa")).toBe("preview");
  });

  it("lee la app de fly.toml y el repo del remoto", () => {
    expect(flyAppFromToml('# comentario\napp = "kofre-api"\nprimary_region = "iad"\n')).toBe("kofre-api");
    expect(flyAppFromToml("primary_region = 'iad'\n")).toBeNull();
    expect(repoFromRemote("git@github.com:Edavi11/kofre.git\n")).toBe("Edavi11/kofre");
    expect(repoFromRemote("https://github.com/Edavi11/kofre")).toBe("Edavi11/kofre");
    expect(repoFromRemote("https://gitlab.com/a/b.git")).toBeNull();
  });

  it("lee .vercel/project.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kofre-sync-"));
    expect(vercelProject(cwd)).toBeNull();
    mkdirSync(join(cwd, ".vercel"));
    writeFileSync(join(cwd, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_1", orgId: "team_1" }));
    expect(vercelProject(cwd)).toEqual({ projectId: "prj_1", orgId: "team_1" });
  });
});

describe("sync: llamadas a cada servicio", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  it("Vercel: una sola petición con upsert, tipo encrypted y el target", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond({ created: [{}, {}], failed: [] });
    });
    expect(await pushVercel({ project: "prj_1", team: "team_1", target: "production", token: "tok", values: { A: "1", B: "2" } })).toBe(2);
    expect(calls[0].url).toBe("https://api.vercel.com/v10/projects/prj_1/env?upsert=true&teamId=team_1");
    expect(JSON.parse(String(calls[0].init.body))).toEqual([
      { key: "A", value: "1", type: "encrypted", target: ["production"] },
      { key: "B", value: "2", type: "encrypted", target: ["production"] },
    ]);
    vi.stubGlobal("fetch", async () => respond({ created: [], failed: [{ error: { key: "A", message: "invalid" } }] }));
    await expect(pushVercel({ project: "p", target: "preview", token: "t", values: { A: "1" } })).rejects.toThrow(/rechazó 1 variables: A/);
  });

  it("Fly: mutación setSecrets y errores de GraphQL", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond({ data: { setSecrets: { release: { version: 3 } } } });
    });
    expect(await pushFly({ app: "acme-api", token: "t", values: { DB: "x" } })).toBe(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.variables).toEqual({ input: { appId: "acme-api", secrets: [{ key: "DB", value: "x" }] } });
    vi.stubGlobal("fetch", async () => respond({ errors: [{ message: "Could not find App" }] }));
    await expect(pushFly({ app: "nope", token: "t", values: { DB: "x" } })).rejects.toThrow(/Could not find App/);
  });

  it("GitHub: pide la clave pública, sella cada valor y hace PUT por secreto", async () => {
    const publicKey = Buffer.alloc(32, 7).toString("base64");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return url.endsWith("/public-key") ? respond({ key: publicKey, key_id: "k1" }) : new Response(null, { status: 204 });
    });
    expect(await pushGithub({ repo: "acme/api", environment: "production", token: "t", values: { A: "1", B: "2" } })).toBe(2);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/api/environments/production/actions/secrets/public-key",
      "https://api.github.com/repos/acme/api/environments/production/actions/secrets/A",
      "https://api.github.com/repos/acme/api/environments/production/actions/secrets/B",
    ]);
    const put = JSON.parse(String(calls[1].init.body));
    expect(put.key_id).toBe("k1");
    // epk(32) + mac(16) + 1 byte de mensaje, en base64 estándar.
    expect(Buffer.from(put.encrypted_value, "base64")).toHaveLength(49);
    expect(String(calls[1].init.body)).not.toContain('"1"');
  });
});
