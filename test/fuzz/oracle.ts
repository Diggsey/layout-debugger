/**
 * Fuzz oracle: verifies a LayoutSpec against the browser's actual layout.
 *
 * Uses the core serialization module to produce structured output with
 * the full DAG and browser measurements, making failures self-documenting.
 */
import type { Page } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";
import { renderSpecToHtml } from "./render";
import type { LayoutSpec } from "./format";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_PATH = path.resolve(__dirname, "..", "..", "dist", "layout-debugger.js");

export interface OracleError {
  nodeId: string;
  kind: string;
  elementPath: string;
  axis: string;
  dagResult: number;
  actual: number;
  delta: number;
}

export interface OracleResult {
  ok: boolean;
  errors: OracleError[];
  dag: Record<string, unknown> | null;
  measurements: Record<string, unknown> | null;
  crashed?: boolean;
  _message?: string;
  _stack?: string;
}

/** Render a LayoutSpec in the browser, run buildDag, and verify the result. */
export async function runOracle(page: Page, spec: LayoutSpec): Promise<OracleResult> {
  const html = renderSpecToHtml(spec);
  await page.setContent(html);
  await page.addScriptTag({ path: DIST_PATH });
  await page.waitForFunction(() => {
    const w = window as Window & { LayoutDebugger?: { buildDag: unknown } };
    return !!w.LayoutDebugger?.buildDag;
  });

  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="target"]');
    if (!el) {
      return {
        ok: false,
        errors: [{ nodeId: "", kind: "", elementPath: "", axis: "", dagResult: 0, actual: 0, delta: 0 }],
        dag: null, measurements: null, crashed: false,
      };
    }

    try {
      const w = window as Window & { LayoutDebugger: { buildDag(el: Element): unknown; verifyDag(dag: unknown): unknown } };
      const dag = w.LayoutDebugger.buildDag(el);
      return w.LayoutDebugger.verifyDag(dag);
    } catch (e: unknown) {
      const err = e instanceof Error ? e : { message: String(e), stack: undefined };
      return {
        ok: false,
        errors: [{ nodeId: "crash", kind: "crash", elementPath: "", axis: "", dagResult: 0, actual: 0, delta: 0 }],
        dag: null, measurements: null, crashed: true,
        _message: err.message, _stack: err.stack,
      };
    }
  }) as Promise<OracleResult>;
}
