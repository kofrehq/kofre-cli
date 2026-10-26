import { parse } from "dotenv";
import { describe, expect, it } from "vitest";
import { kofreHeader, readKofreHeader, serializeEnv } from "../src/envfile";
import { alternativeFor, diffEnv, inspectTarget } from "../src/pull-target";

const remote = { API_KEY: "abcd", DB_PASSWORD: "hola123" };
const body = serializeEnv(remote);
const ours = kofreHeader("test/proyecto", "p1", "dev", body) + body;

describe("pull no pisa archivos ajenos", () => {
  it("la cabecera se lee de vuelta con su huella y dotenv la ignora", () => {
    expect(readKofreHeader(ours)).toEqual({ projectId: "p1", slug: "dev", hash: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(parse(ours)).toEqual(remote);
    expect(readKofreHeader("API_KEY=1\n")).toBeNull();
  });

  it("un valor nuevo en Kofre no es un cambio local: solo cuenta lo editado a mano", () => {
    expect(inspectTarget(null, "p1", "dev", remote)).toEqual({ kind: "missing" });
    expect(inspectTarget(ours, "p1", "dev", remote)).toEqual({ kind: "ours", edited: false, changed: [] });
    // Alguien actualizó API_KEY en Kofre y el archivo sigue intacto: se actualiza sin preguntar.
    expect(inspectTarget(ours, "p1", "dev", { ...remote, API_KEY: "otro" })).toEqual({ kind: "ours", edited: false, changed: ["API_KEY"] });
    expect(inspectTarget(ours, "p1", "dev", { ...remote, NUEVA: "x" })).toEqual({ kind: "ours", edited: false, changed: [] });
    // Editado a mano: sí se pregunta, y se dice qué difiere.
    expect(inspectTarget(`${ours}EXTRA=1\n`, "p1", "dev", remote)).toEqual({ kind: "ours", edited: true, changed: ["EXTRA"] });
    expect(inspectTarget(ours.replace("hola123", "cambiado"), "p1", "dev", remote)).toMatchObject({ edited: true, changed: ["DB_PASSWORD"] });
    // Los finales de línea de Windows no cuentan como edición.
    expect(inspectTarget(ours.replace(/\n/g, "\r\n"), "p1", "dev", remote)).toMatchObject({ edited: false });
  });

  it("los archivos de antes de la huella se comparan con Kofre", () => {
    const legacy = `# kofre: test/proyecto/dev (p1) · generado el 21/10/26, 11:24. Cambia los valores en Kofre o con kofre push.\n${body}`;
    expect(inspectTarget(legacy, "p1", "dev", remote)).toEqual({ kind: "ours", edited: false, changed: [] });
    expect(inspectTarget(legacy, "p1", "dev", { ...remote, API_KEY: "otro" })).toMatchObject({ edited: true });
  });

  it("archivos ajenos o de otro proyecto o ambiente", () => {
    expect(inspectTarget("MIO=1\n", "p1", "dev", remote).kind).toBe("foreign");
    expect(inspectTarget(ours, "p1", "prod", remote).kind).toBe("foreign");
    expect(inspectTarget(ours, "p2", "dev", remote).kind).toBe("foreign");
  });

  it("el resumen de lo que trae pull nombra variables, nunca valores", () => {
    expect(diffEnv(remote, remote)).toEqual([]);
    const lines = diffEnv({ API_KEY: "abcd", VIEJA: "1" }, { API_KEY: "secreto-nuevo", DB_PASSWORD: "hola123" });
    expect(lines).toEqual(["~ API_KEY   (valor nuevo)", "+ DB_PASSWORD   (nueva)", "- VIEJA   (ya no está en Kofre)"]);
    expect(lines.join(" ")).not.toMatch(/secreto-nuevo|hola123|abcd/);
  });

  it("el archivo alternativo nunca es el mismo", () => {
    expect(alternativeFor(".env", "dev")).toBe(".env.dev");
    expect(alternativeFor(".env.dev", "dev")).toBe(".env.dev.kofre");
    expect(alternativeFor("config.env", "prod")).toBe("config.env.kofre");
  });
});
