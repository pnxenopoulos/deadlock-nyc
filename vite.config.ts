import { readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const cargoLock = readFileSync(
  path.resolve(__dirname, "wasm/Cargo.lock"),
  "utf8",
);
const boonVersion = cargoLock.match(
  /\[\[package\]\]\s+name = "boon-deadlock"\s+version = "([^"]+)"/,
)?.[1];

if (!boonVersion) {
  throw new Error("boon-deadlock version not found in wasm/Cargo.lock");
}

export default defineConfig({
  // Relative asset paths so the build works both at the GitHub Pages project
  // URL (username.github.io/deadlock-nyc/) and at the apex custom domain
  // (deadlock.nyc/) — neither needs a hardcoded base. Safe here because the app
  // is a single page with no client-side routing.
  base: "./",
  // The parse worker is a module worker (`new Worker(..., { type: "module" })`)
  // that code-splits the wasm-pack glue via dynamic import. Vite's default
  // worker format is IIFE, which can't code-split — emit ES instead.
  worker: { format: "es" },
  plugins: [react(), tailwindcss()],
  define: {
    __BOON_VERSION__: JSON.stringify(boonVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // wasm-pack --target web emits .wasm next to the JS glue; Vite serves it as-is.
  assetsInclude: ["**/*.wasm"],
});
