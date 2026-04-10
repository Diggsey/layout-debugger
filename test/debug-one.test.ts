import { test } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { runOracle } from "./fuzz/oracle";
import type { LayoutSpec } from "./fuzz/format";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.resolve(__dirname, "fuzz-corpus");

const TARGET_FILE = process.env.FUZZ_FILE ?? "fuzz-1775772116174.json";

test(`debug: ${TARGET_FILE}`, async ({ page }) => {
  const data = JSON.parse(
    fs.readFileSync(path.resolve(CORPUS_DIR, TARGET_FILE), "utf-8"),
  );
  const spec: LayoutSpec = data.spec;
  const result = await runOracle(page, spec);
  console.log("=== ERRORS ===");
  console.log(JSON.stringify(result.errors, null, 2));
  console.log("\n=== LIVE DAG ===");
  console.log(JSON.stringify(result.dag, null, 2));
  console.log("\n=== MEASUREMENTS ===");
  console.log(JSON.stringify(result.measurements, null, 2));
});
