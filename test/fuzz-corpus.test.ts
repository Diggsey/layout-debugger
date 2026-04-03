import { test, expect } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { runOracle } from "./fuzz/oracle";
import type { LayoutSpec } from "./fuzz/format";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.resolve(__dirname, "fuzz-corpus");

const files = fs.existsSync(CORPUS_DIR)
  ? fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json"))
  : [];

for (const file of files) {
  test(`fuzz corpus: ${file}`, async ({ page }) => {
    const data = JSON.parse(
      fs.readFileSync(path.resolve(CORPUS_DIR, file), "utf-8"),
    );
    const spec: LayoutSpec = data.spec;
    const result = await runOracle(page, spec);
    const errorSummary = result.errors.map(
      (e) => `${e.nodeId}: ${e.kind} ${e.elementPath} ${e.axis}: DAG=${e.dagResult} actual=${e.actual} delta=${e.delta}`,
    ).join("\n");
    expect(result.errors, `Regression in ${file}:\n${errorSummary}`).toEqual([]);
  });
}
