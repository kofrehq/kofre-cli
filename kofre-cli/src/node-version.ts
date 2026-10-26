// Mínimo parcheado de cada línea con soporte (avisos de Node del 21 de octubre de 2026, CVE-2026-111497 y otros).
// Las líneas que no están aquí (20, 23, 25) son EOL y no recibieron el parche.
// ponytail: hay que tocar esta tabla en cada aviso de seguridad de Node; las líneas mayores que 26 se dan por buenas.
const PATCHED: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };

export function isPatchedNode(version: string): boolean {
  const [major, minor, patch] = version.replace(/^v/, "").split(".").map(Number);
  if (major > 26) return true;
  const min = PATCHED[major];
  if (!min) return false;
  return minor > min[0] || (minor === min[0] && patch >= min[1]);
}
