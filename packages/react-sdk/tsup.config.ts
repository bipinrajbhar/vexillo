import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    outExtension({ format }) {
      return { js: format === "esm" ? ".mjs" : ".cjs" };
    },
    external: ["react", "react-dom"],
  },
  {
    // Legacy .js CJS output for webpack 4 and bundlers that don't handle .cjs
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    dts: false,
    clean: false,
    outExtension() {
      return { js: ".js" };
    },
    external: ["react", "react-dom"],
  },
]);
