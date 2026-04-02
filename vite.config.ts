import { defineConfig } from "vite";
import { resolve } from "path";

const root = import.meta.dirname;

// Default config builds the bookmarklet IIFE bundle
export default defineConfig({
  build: {
    lib: {
      entry: resolve(root, "src/bookmarklet/index.ts"),
      formats: ["iife"],
      name: "LayoutDebugger",
      fileName: () => "layout-debugger.js",
    },
    outDir: "dist",
    emptyOutDir: false,
    minify: true,
    target: ["chrome90", "firefox90", "safari15"],
  },
  esbuild: {
    charset: "ascii",
  },
});
