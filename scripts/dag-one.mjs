#!/usr/bin/env node
// Run a fuzz corpus case through the current dist build and dump the DAG.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..", "dist", "layout-debugger.js");

function render(spec, isTarget) {
  const style = Object.entries(spec.style || {}).map(([k, v]) => `${k}:${v}`).join(";");
  const children = (spec.children || []).map(render).join("");
  const text = spec.text || "";
  const attrs = spec.target ? ' data-testid="target"' : "";
  return `<div style="${style}"${attrs}>${text}${children}</div>`;
}

const file = process.argv[2] || "fuzz-1420.json";
const corpus = JSON.parse(fs.readFileSync(`test/fuzz-corpus/${file}`, "utf-8"));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<!doctype html><html><body>${render(corpus.spec)}</body></html>`);
await page.addScriptTag({ path: DIST });
await page.waitForFunction(() => !!(window.LayoutDebugger?.buildDag));

const dag = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="target"]');
  if (!el) return null;
  const LD = window.LayoutDebugger;
  const dag = LD.buildDag(el);
  // Serialize dag structurally
  const serialized = LD.serializeDag(dag);
  return serialized;
});
await browser.close();

// Print all nodes in DAG
const nodes = dag.nodes;
const filter = process.argv[3] || "";
for (const [id, n] of Object.entries(nodes)) {
  if (!filter || (n.kind?.includes(filter) || n.elementPath?.includes(filter))) {
    console.log(id, "|", n.kind, "|", n.result, "|", n.description);
    console.log("     expr:", JSON.stringify(n.expr || "").slice(0, 150));
    if (n.inputs && Object.keys(n.inputs).length > 0) {
      console.log("     inputs:", JSON.stringify(n.inputs));
    }
  }
}
