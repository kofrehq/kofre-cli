# Kofre CLI y @kofre/crypto

Código abierto del cliente de [Kofre](https://kofre.io): la CLI (`@kofre/cli`) y la biblioteca de cifrado (`@kofre/crypto`). Es el código que corre en tu máquina y el que decide que el servidor nunca vea tus secretos; está aquí para que puedas leerlo y comprobarlo.

- `kofre-cli/`: la CLI publicada en npm como `@kofre/cli` y como binarios en [kofre-releases](https://github.com/kofrehq/kofre-releases).
- `kofre-crypto/`: Argon2id, HKDF, XChaCha20-Poly1305 y X25519 sobre `@noble/*` y `hash-wasm`. Los vectores fijos de `test/crypto.test.ts` son el contrato del formato.
- [THREAT-MODEL.md](THREAT-MODEL.md): qué protege Kofre, qué no, y qué puede hacer un servidor malicioso.
- [SECURITY.md](SECURITY.md): cómo reportar una vulnerabilidad.

Este repositorio se genera desde el monorepo privado en cada release; los pull requests se revisan y se portan a mano. La API y el panel web no son públicos.

```bash
pnpm install
pnpm -r test
pnpm --filter @kofre/cli build   # dist/kofre.js
```

Licencia MIT.
