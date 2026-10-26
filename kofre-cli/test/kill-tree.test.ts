import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DETACH_FOR_TREE_KILL, killTree } from "../src/kill-tree";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("detener un comando", () => {
  it("mata también a los nietos, como el servidor que lanza `kofre run -- pnpm dev`", async () => {
    // El hijo lanza un nieto que no termina nunca y avisa de su pid.
    const script = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(g.pid);
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script], { detached: DETACH_FOR_TREE_KILL, stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = await new Promise<number>((resolve) => child.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
    expect(alive(grandchild)).toBe(true);

    const closed = new Promise((resolve) => child.once("close", resolve));
    killTree(child);
    await closed;
    for (let i = 0; i < 20 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(grandchild)).toBe(false);
  });
});
