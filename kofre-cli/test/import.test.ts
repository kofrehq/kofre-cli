import { describe, expect, it } from "vitest";
import { parseImport } from "../src/import";

describe("parseImport", () => {
  it("entiende .env, JSON plano, Doppler e Infisical", () => {
    expect(parseImport("A=1\nB=\"dos tres\"\n")).toEqual({ A: "1", B: "dos tres" });
    expect(parseImport('{"A":"1","B":"x\\ny"}')).toEqual({ A: "1", B: "x\ny" });
    expect(parseImport('{"A":{"computed":"1","raw":"${X}"},"B":{"raw":"2"}}')).toEqual({ A: "1", B: "2" });
    expect(parseImport('[{"key":"A","value":"1"},{"secretKey":"B","secretValue":"2"},{"key":"C"}]')).toEqual({ A: "1", B: "2" });
  });

  it("aplica las mismas reglas de nombre que un .env", () => {
    expect(() => parseImport('{"bad-name":"1"}')).toThrow(/bad-name/);
    expect(parseImport("[]")).toEqual({});
  });
});
