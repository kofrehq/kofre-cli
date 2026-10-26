/** En una terminal: cabecera y columnas alineadas. En una tubería: TSV sin cabecera, estable para scripts. */
export function formatTable(headers: string[], rows: string[][], human: boolean): string[] {
  if (!human) return rows.map((row) => row.join("\t"));
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

// Dentro de `kofre ui` la salida va a un panel, no a una tubería: también lleva cabeceras.
export const human = Boolean(process.stdout.isTTY) || Boolean(process.env.KOFRE_UI_CHILD);

export function printTable(headers: string[], rows: string[][], empty: string) {
  if (rows.length === 0) {
    if (human) console.log(empty);
    return;
  }
  for (const line of formatTable(headers, rows, human)) console.log(line);
}

/** Fecha local legible en la terminal; ISO en tuberías. */
export function when(iso: string): string {
  if (!human) return iso;
  return new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });
}
