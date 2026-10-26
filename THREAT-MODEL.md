# Modelo de amenazas de Kofre

Kofre guarda variables de entorno cifradas por proyecto y ambiente. Este documento dice qué protege, contra quién, y qué no. El formato exacto está en [`kofre-crypto/src/index.ts`](kofre-crypto/src/index.ts) y sus vectores fijos en `kofre-crypto/test/crypto.test.ts`.

## Qué protege

**Lo que el servidor nunca recibe:** la contraseña maestra, las claves derivadas de ella, la clave privada en claro, la clave de recuperación y el valor de cualquier secreto. Todo eso existe solo en el cliente (CLI o navegador).

**Lo que el servidor guarda:** email, salt, parámetros de Argon2id, un hash (`scrypt`) del verificador de login, la clave pública X25519, la clave privada envuelta, la clave de recuperación envuelta, nombres de proyectos, ambientes y variables, y los valores cifrados.

## Claves

```
master      = Argon2id(contraseña, salt, kdfParams)          19 MiB, 2 iteraciones por defecto
authKey     = HKDF-SHA256(master, salt, "kofre-auth-v1")     → authVerifier = SHA-256(authKey); el servidor guarda scrypt(authVerifier)
wrapKey     = HKDF-SHA256(master, salt, "kofre-wrap-v1")     → envuelve la clave privada X25519
envKey      = 32 bytes aleatorios por ambiente               → sellada (X25519 + HKDF + XChaCha20-Poly1305) a la clave pública de cada miembro
secreto     = XChaCha20-Poly1305(envKey, nonce 24 bytes, AAD = proyecto|ambiente|nombre|versión)
```

Los datos asociados ligan cada valor cifrado a su proyecto, ambiente, nombre y versión: un servidor que intercambie blobs entre variables, ambientes o versiones produce un error de autenticación, no un valor equivocado.

## Adversarios

| Adversario | Qué consigue | Qué no consigue |
|------------|--------------|-----------------|
| **Fuga de la base de datos** | Emails, nombres de variables, texto cifrado. | Iniciar sesión (el verificador está hasheado con scrypt) ni leer valores. Puede intentar fuerza bruta offline contra la contraseña maestra: por eso Argon2id con 19 MiB y la recomendación de contraseñas largas. |
| **Servidor Kofre comprometido o malicioso** | Negar servicio, borrar datos, ver quién accede a qué y cuándo, entregar una clave pública falsa al compartir un proyecto. | Leer valores existentes. Contra la clave pública falsa, la CLI y el panel muestran la huella (`fingerprint`) del miembro nuevo para verificarla por otro canal. |
| **Red (MITM)** | Nada: TLS, y aun sin él no viaja nada en claro que sirva para descifrar. | |
| **Robo del portátil con sesión abierta** | Lo que la sesión pueda leer mientras la clave siga en el llavero (`KOFRE_VAULT_TTL_MIN`, 12 h por defecto) o en memoria del navegador (15 min sin actividad). | Nada después de revocar el dispositivo desde otro equipo: el token deja de valer en el acto. |
| **Miembro expulsado** | Conserva los valores que ya vio. | Nuevos valores: al quitarlo se genera otra `envKey`, se recifra todo con versión +1 y se sella solo para quienes quedan. Kofre avisa qué valores pudo ver para que se roten en el proveedor. |
| **Token de servicio filtrado** | Leer los ambientes a los que se acotó, hasta que se revoque o caduque. | Escribir, ni leer otros proyectos. |
| **Agente de IA en el repositorio** | Leer un `.env` si existe. | Con `kofre guard` + `kofre mcp`, el agente ejecuta comandos con las variables inyectadas y recibe la salida con los valores tachados; nunca pide ni ve valores. |

## Qué no protege

- Una contraseña maestra débil. Argon2id encarece la fuerza bruta; no la impide.
- La máquina del usuario: malware con acceso a la memoria o al llavero lee lo mismo que el usuario.
- El código que el usuario ejecuta con `kofre run`: recibe los valores en su entorno, como debe.
- Los servicios a los que se copian valores con `kofre sync` (Vercel, Fly, GitHub): a partir de ahí aplican sus propias garantías.
- Metadatos: el servidor conoce nombres de variables, tamaños aproximados y patrones de acceso.

## Recuperación

La clave de recuperación (32 bytes, base32 en 13 grupos) envuelve la clave privada. El servidor guarda un verificador derivado con HKDF para autorizar el flujo, sin poder abrir el sobre. Usarla rota la clave y revoca las sesiones.

## Segundo factor

TOTP (RFC 6238) con códigos de respaldo de un solo uso. Protege el acceso a los blobs cifrados; no sustituye a la contraseña maestra ni forma parte del cifrado.

## Reportar un problema

Ver [SECURITY.md](SECURITY.md).
