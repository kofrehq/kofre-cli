import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { KdfParams } from "@kofre/crypto";
import { ApiError, api, apiUrl, clearSession, readSession, revokeSession, writeSession } from "./config";
import { openInBrowser } from "./browser";
import { promptLine } from "./prompt";

type CliStart = { requestId: string; expiresIn: number };

type CliSession = {
  token: string;
  user: {
    email: string;
    salt: string;
    kdfParams: KdfParams;
    publicKey: string;
    wrappedPrivateKey: string;
  };
};

const PASTE_ATTEMPTS = 3;

/** Unos pocos intentos por si se pega mal; la API invalida la solicitud tras 5 fallos. */
async function exchangeCode(requestId: string, codeVerifier: string): Promise<CliSession> {
  for (let attempt = 1; ; attempt += 1) {
    const code = (await promptLine("Código")).trim();
    if (!code) throw new Error("No se pegó ningún código. Ejecuta `kofre login` de nuevo.");
    try {
      return await api<CliSession>("/auth/cli/exchange", {
        method: "POST",
        body: JSON.stringify({ requestId, code, codeVerifier }),
      });
    } catch (error) {
      const rejected = error instanceof ApiError && (error.status === 401 || error.status === 400);
      if (!rejected) throw error;
      if (attempt >= PASTE_ATTEMPTS) throw new Error("Código incorrecto o caducado. Ejecuta `kofre login` de nuevo.");
      console.error("Código incorrecto. Cópialo de nuevo desde la web.");
    }
  }
}

function webUrl(): string {
  return process.env.KOFRE_WEB_URL ?? "https://kofre-web.vercel.app";
}

/**
 * La web muestra un código de un solo uso a quien ya inició sesión y esta terminal lo canjea con el verificador PKCE,
 * que nunca sale de aquí. Un enlace reenviado por otra persona no le sirve: necesitaría el código y el verificador.
 */
export async function loginWithBrowser(): Promise<void> {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const start = await api<CliStart>("/auth/cli/start", {
    method: "POST",
    body: JSON.stringify({ codeChallenge, deviceName: hostname().slice(0, 64) }),
  });
  const connectUrl = `${webUrl()}/cli/connect?request=${encodeURIComponent(start.requestId)}`;

  console.log("Abre este enlace, autoriza la terminal y pega aquí el código que te muestre la web:");
  console.log(connectUrl);
  openInBrowser(connectUrl);

  const session = await exchangeCode(start.requestId, codeVerifier);
  // Volver a iniciar sesión no deja la anterior viva en el servidor.
  const previous = readSession();
  if (previous) await revokeSession(previous.token);
  clearSession();
  writeSession({
    apiUrl: apiUrl(),
    token: session.token,
    email: session.user.email,
    salt: session.user.salt,
    kdfParams: session.user.kdfParams,
    wrappedPrivateKey: session.user.wrappedPrivateKey,
    publicKey: session.user.publicKey,
  });
  console.log(`Sesión guardada como ${session.user.email}.`);
  console.log("La primera operación con secretos pedirá tu contraseña maestra.");
}
