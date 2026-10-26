import { describe, expect, it } from "vitest";
import { isPatchedNode } from "../src/node-version";

describe("versión de Node", () => {
  it("acepta las versiones parcheadas y posteriores", () => {
    for (const v of ["v22.23.4", "22.24.0", "v24.22.1", "v24.23.0", "v26.12.1", "v27.0.0"]) expect(isPatchedNode(v), v).toBe(true);
  });

  it("rechaza las vulnerables y las líneas EOL", () => {
    for (const v of ["v22.23.3", "v22.9.9", "v24.11.0", "v26.12.0", "v20.19.0", "v23.11.0", "v25.9.0"]) expect(isPatchedNode(v), v).toBe(false);
  });
});
