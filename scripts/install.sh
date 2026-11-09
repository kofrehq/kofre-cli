#!/bin/sh
# Instala la última release de kofre en Linux o macOS: descarga el binario, verifica el SHA-256 y lo deja en el PATH.
#   curl -fsSL https://raw.githubusercontent.com/kofrehq/kofre-releases/main/install.sh | sh
# Variables: KOFRE_VERSION (por defecto la última), KOFRE_INSTALL_DIR (por defecto /usr/local/bin o ~/.local/bin).
set -eu

REPO="${KOFRE_RELEASE_REPO:-kofrehq/kofre-releases}"
os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) echo "Sistema no soportado: $os. Usa npm install -g @kofre/cli" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Arquitectura no soportada: $arch. Usa npm install -g @kofre/cli" >&2; exit 1 ;;
esac
if [ "$os" = "linux" ] && [ "$arch" = "arm64" ]; then
  echo "No hay binario para linux/arm64 todavía. Usa npm install -g @kofre/cli" >&2
  exit 1
fi
# El binario enlaza con glibc: en musl (Alpine) no arranca y solo diría "not found".
if [ "$os" = "linux" ] && ldd --version 2>&1 | grep -qi musl; then
  echo "No hay binario para Linux con musl (Alpine). Usa npm install -g @kofre/cli" >&2
  exit 1
fi

asset="kofre-$os-$arch"
if [ -n "${KOFRE_VERSION:-}" ]; then
  tag="v${KOFRE_VERSION#v}"
else
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
  [ -n "$tag" ] || { echo "No se pudo resolver la última versión" >&2; exit 1; }
fi
base="https://github.com/$REPO/releases/download/$tag"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Descargando kofre $tag ($os/$arch)…"
curl -fsSL "$base/$asset" -o "$tmp/kofre"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

# Con cosign instalado se comprueba la firma Sigstore de SHA256SUMS: solo vale si la emitió el workflow de release de Kofre.
if command -v cosign >/dev/null 2>&1; then
  curl -fsSL "$base/SHA256SUMS.sigstore.json" -o "$tmp/SHA256SUMS.sigstore.json"
  cosign verify-blob --bundle "$tmp/SHA256SUMS.sigstore.json" \
    --certificate-identity-regexp '^https://github\.com/(kofrehq|Edavi11)/kofre/\.github/workflows/release\.yml@refs/tags/v' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$tmp/SHA256SUMS" >/dev/null 2>&1 || { echo "La firma de SHA256SUMS no es válida; instalación abortada" >&2; exit 1; }
  echo "Firma Sigstore verificada."
else
  echo "Aviso: sin cosign no se verifica la firma, solo el SHA-256. Instala cosign para comprobar el origen del binario."
fi

expected=$(grep " \*\{0,1\}$asset\$" "$tmp/SHA256SUMS" | awk '{print $1}')
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/kofre" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/kofre" | awk '{print $1}')
fi
[ "$expected" = "$actual" ] || { echo "El SHA-256 no coincide; instalación abortada" >&2; exit 1; }
chmod +x "$tmp/kofre"

dir="${KOFRE_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"
mv "$tmp/kofre" "$dir/kofre"
echo "Instalado en $dir/kofre"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Añade $dir a tu PATH para usar kofre desde cualquier carpeta." ;;
esac
"$dir/kofre" --version
