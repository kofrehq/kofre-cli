#!/usr/bin/env node
// Genera la fórmula de Homebrew y el manifiesto de Scoop a partir de los checksums de una release.
// Uso: node scripts/release-manifests.mjs <version> <ruta a SHA256SUMS> <dir de salida>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, sumsPath, outDir] = process.argv.slice(2);
if (!version || !sumsPath || !outDir) {
  console.error("Uso: release-manifests.mjs <version> <SHA256SUMS> <outDir>");
  process.exit(1);
}
const repo = process.env.KOFRE_RELEASE_REPO ?? "kofrehq/kofre-releases";
const base = `https://github.com/${repo}/releases/download/v${version}`;
const sums = Object.fromEntries(
  readFileSync(sumsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+\*?/))
    .map(([sha, file]) => [file, sha]),
);
const sha = (file) => {
  if (!sums[file]) throw new Error(`Falta ${file} en SHA256SUMS`);
  return sums[file];
};

const formula = `class Kofre < Formula
  desc "Secretos de proyecto cifrados en tu máquina"
  homepage "https://github.com/${repo}"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${base}/kofre-macos-arm64"
      sha256 "${sha("kofre-macos-arm64")}"
    end
    on_intel do
      url "${base}/kofre-macos-x64"
      sha256 "${sha("kofre-macos-x64")}"
    end
  end

  on_linux do
    on_intel do
      url "${base}/kofre-linux-x64"
      sha256 "${sha("kofre-linux-x64")}"
    end
  end

  def install
    binary = Dir["kofre-*"].first
    bin.install binary => "kofre"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kofre --version")
  end
end
`;

const scoop = {
  version,
  description: "Secretos de proyecto cifrados en tu máquina",
  homepage: `https://github.com/${repo}`,
  license: "MIT",
  architecture: {
    "64bit": {
      url: `${base}/kofre-windows-x64.exe#/kofre.exe`,
      hash: sha("kofre-windows-x64.exe"),
    },
  },
  bin: "kofre.exe",
  checkver: { github: `https://github.com/${repo}` },
  autoupdate: {
    architecture: { "64bit": { url: `https://github.com/${repo}/releases/download/v$version/kofre-windows-x64.exe#/kofre.exe` } },
  },
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "kofre.rb"), formula);
writeFileSync(join(outDir, "kofre.json"), `${JSON.stringify(scoop, null, 2)}\n`);
console.log(`Escritos ${join(outDir, "kofre.rb")} y ${join(outDir, "kofre.json")}`);
