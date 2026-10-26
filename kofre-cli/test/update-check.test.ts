import { describe, expect, it } from "vitest";
import { isNewer } from "../src/update-check";

describe("aviso de actualización", () => {
  it("compara versiones numéricamente, no como texto", () => {
    expect(isNewer("0.2.1", "0.2.0")).toBe(true);
    expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.0")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  });
});
