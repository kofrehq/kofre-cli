import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig([
  {
    entry: { kofre: "src/main.ts" },
    format: ["cjs"],
    target: "node20",
    platform: "node",
    // Sin esto tsup deja require("sea"), que no existe: node:sea solo se carga con el prefijo.
    removeNodeProtocol: false,
    // Un solo archivo sin dependencias: lo que npm publica y lo que Node SEA empaqueta.
    noExternal: [/.*/],
    minify: false,
    sourcemap: false,
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
    define: { __KOFRE_VERSION__: JSON.stringify(pkg.version) },
  },
  {
    // `kofre ui` (Ink) va aparte y en ESM: yoga-layout usa top-level await, que CommonJS no admite.
    // kofre.js lo carga con import() solo cuando se pide, así el resto de comandos no paga su peso.
    entry: { ui: "src/ui/index.tsx" },
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    target: "node22",
    platform: "node",
    removeNodeProtocol: false,
    noExternal: [/.*/],
    splitting: false,
    minify: false,
    sourcemap: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // import.meta.url es data: dentro del ejecutable SEA; createRequire solo lo usan los builtins de las dependencias CJS.
    banner: { js: "import { createRequire as __kofreRequire } from 'node:module'; const require = __kofreRequire(process.execPath);" },
    esbuildOptions(options) {
      options.jsx = "automatic";
      // Ink solo lo carga con DEV=true (React DevTools): no se distribuye.
      options.alias = { "react-devtools-core": "./src/ui/empty.ts" };
    },
  },
]);
