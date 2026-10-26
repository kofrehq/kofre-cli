import { parseEnvFile } from "./envfile";

/*
 * `kofre import`: lee lo que exportan otras herramientas y lo deja como { NOMBRE: valor } para `writeSecrets`.
 *   - .env (dotenv)
 *   - JSON plano { "KEY": "valor" }            → doppler secrets download --no-file --format json
 *   - JSON { "KEY": { "computed": "valor" } }  → doppler secrets --json
 *   - JSON [ { "key": "KEY", "value": "valor" } ] → infisical export --format=json
 */
export function parseImport(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return parseEnvFile(text);
  const parsed = JSON.parse(trimmed) as unknown;
  const out: Record<string, string> = {};
  if (Array.isArray(parsed)) {
    for (const item of parsed as { key?: string; secretKey?: string; value?: string; secretValue?: string }[]) {
      const key = item.key ?? item.secretKey;
      const value = item.value ?? item.secretValue;
      if (typeof key === "string" && typeof value === "string") out[key] = value;
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const value = typeof raw === "string" ? raw : raw && typeof raw === "object" ? ((raw as { computed?: unknown; raw?: unknown; value?: unknown }).computed ?? (raw as { raw?: unknown }).raw ?? (raw as { value?: unknown }).value) : null;
      if (typeof value === "string") out[key] = value;
    }
  }
  // Mismas reglas de nombre y tamaño que un .env: así un export raro no entra sin validar.
  return parseEnvFile(Object.entries(out).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n"));
}
