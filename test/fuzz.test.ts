import { test, expect } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { generateSpec } from "./fuzz/generate";
import { runOracle, type OracleError } from "./fuzz/oracle";
import type { LayoutSpec } from "./fuzz/format";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.resolve(__dirname, "fuzz-corpus");

const FUZZ_N = Number(process.env.FUZZ_N) || 50;
const FUZZ_SEED = Number(process.env.FUZZ_SEED) || Date.now();

test.describe("fuzz", () => {
  test("random layouts", async ({ page }) => {
    const failures: { seed: number; spec: LayoutSpec; errors: OracleError[] }[] = [];

    for (let i = 0; i < FUZZ_N; i++) {
      const seed = FUZZ_SEED + i;
      const spec = generateSpec(seed);
      const result = await runOracle(page, spec);

      if (!result.ok) {
        failures.push({ seed, spec, errors: result.errors });

        const filename = `fuzz-${seed}.json`;
        fs.writeFileSync(
          path.resolve(CORPUS_DIR, filename),
          JSON.stringify({
            seed,
            spec,
            errors: result.errors,
            dag: result.dag,
            measurements: result.measurements,
          }, null, 2),
        );
      }
    }

    if (failures.length > 0) {
      const summary = failures
        .map((f) => {
          const e = f.errors[0];
          if (e.message) return `  seed=${f.seed}: ${e.kind} ${e.elementPath} ${e.axis}: ${e.message}`;
          return `  seed=${f.seed}: ${e.kind} ${e.elementPath} ${e.axis}: DAG=${e.dagResult} actual=${e.actual} delta=${e.delta}`;
        })
        .join("\n");
      expect(
        failures.length,
        `${failures.length}/${FUZZ_N} fuzz failures (seed=${FUZZ_SEED}):\n${summary}`,
      ).toBe(0);
    }
  });
});
