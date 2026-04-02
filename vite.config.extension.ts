import { defineConfig } from "vite";
import { resolve } from "path";
import { cpSync, readFileSync, writeFileSync } from "fs";

const root = import.meta.dirname;
const extDir = resolve(root, "src/extension");
const outDir = resolve(root, "dist/extension");

export default defineConfig({
  root: extDir,
  base: "",
  build: {
    outDir,
    emptyOutDir: true,
    minify: true,
    target: ["chrome90", "firefox90"],
    rollupOptions: {
      input: {
        devtools: "devtools.html",
        panel: "panel.html",
        "content-script": "content-script.ts",
        engine: "engine.ts",
      },
      output: {
        entryFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
  esbuild: {
    charset: "ascii",
  },
  plugins: [
    {
      name: "copy-manifest",
      closeBundle() {
        cpSync(resolve(extDir, "manifest.json"), resolve(outDir, "manifest.json"));
        const manifest = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf-8"));
        // Patch .ts references to .js in the output manifest
        for (const cs of manifest.content_scripts ?? []) {
          cs.js = cs.js.map((f: string) => f.replace(/\.ts$/, ".js"));
        }
        for (const war of manifest.web_accessible_resources ?? []) {
          war.resources = war.resources.map((f: string) => f.replace(/\.ts$/, ".js"));
        }
        writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
      },
    },
  ],
});
