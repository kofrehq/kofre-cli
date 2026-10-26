import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitignoreWarns, parseEnvFile, readTomlProject, serializeEnv, tomlFor } from "../src/envfile";

describe("parseEnvFile", () => {
  it("entiende comentarios, export, comillas y multilínea", () => {
    const text = [
      "# comentario",
      "PLAIN=hello",
      "export EXPORTED=yes",
      'QUOTED="with spaces" # inline',
      "SINGLE='keep $raw'",
      'MULTI="line1\nline2"',
      "EMPTY=",
    ].join("\n");
    expect(parseEnvFile(text)).toEqual({
      PLAIN: "hello",
      EXPORTED: "yes",
      QUOTED: "with spaces",
      SINGLE: "keep $raw",
      MULTI: "line1\nline2",
      EMPTY: "",
    });
  });

  it("rechaza nombres inválidos y valores enormes", () => {
    expect(() => parseEnvFile("BAD-NAME=1")).toThrow(/BAD-NAME/);
    expect(() => parseEnvFile(`BIG=${"x".repeat(48 * 1024 + 1)}`)).toThrow(/BIG/);
  });
});

describe("serializeEnv", () => {
  it("round-trip exacto con valores peligrosos", () => {
    const values = {
      SIMPLE: "abc123",
      URL: "postgres://u:p@h:5432/db?schema=public",
      SPACES: "hello world",
      NEWLINE: "first\nsecond",
      INJECT: "x\nEVIL=1",
      QUOTES: 'say "hi" and \'bye\'',
      DOUBLE: 'say "hi"',
      SINGLE: "it's",
      HASH: "value # not a comment",
      BACKSLASH: "C:\\path\\to",
      LITERAL_ESCAPE: "C:\\new\\results",
      EMPTY: "",
      UNICODE: "ñandú 🔐",
    };
    const text = serializeEnv(values);
    expect(text.split("\n").filter(Boolean)).toHaveLength(Object.keys(values).length);
    expect(parseEnvFile(text)).toEqual(values);
  });

  it("devuelve vacío sin variables y rechaza lo irrepresentable", () => {
    expect(serializeEnv({})).toBe("");
    expect(() => serializeEnv({ X: "a\"b'c`d\ne" })).toThrow(/X/);
  });
});

describe("archivos del proyecto", () => {
  it("lee .kofre.toml y avisa de .gitignore", () => {
    const dir = mkdtempSync(join(tmpdir(), "kofre-"));
    expect(readTomlProject(dir)).toBeNull();
    writeFileSync(join(dir, ".kofre.toml"), tomlFor("proj_1", "staging"));
    expect(readTomlProject(dir)).toEqual({ projectId: "proj_1", defaultEnv: "staging" });

    expect(gitignoreWarns(".env", dir)).toMatch(/no existe/);
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.envrc\n");
    expect(gitignoreWarns(".env", dir)).toMatch(/no está/);
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.env\n");
    expect(gitignoreWarns(".env", dir)).toBeNull();
    // El archivo alternativo de pull también lleva secretos.
    expect(gitignoreWarns(".env.dev", dir)).toMatch(/\.env\.dev no está/);
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.env*\n");
    expect(gitignoreWarns(".env.dev", dir)).toBeNull();
  });
});
