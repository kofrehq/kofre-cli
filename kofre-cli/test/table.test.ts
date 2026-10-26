import { describe, expect, it } from "vitest";
import { formatTable } from "../src/table";

describe("tablas de la CLI", () => {
  const rows = [
    ["cmvhndjwh0022", "test_project"],
    ["abc", "otro"],
  ];

  it("en una terminal añade cabecera y alinea columnas", () => {
    expect(formatTable(["ID", "NOMBRE"], rows, true)).toEqual([
      "ID             NOMBRE",
      "cmvhndjwh0022  test_project",
      "abc            otro",
    ]);
  });

  it("en una tubería deja TSV sin cabecera para scripts", () => {
    expect(formatTable(["ID", "NOMBRE"], rows, false)).toEqual(["cmvhndjwh0022\ttest_project", "abc\totro"]);
  });
});
