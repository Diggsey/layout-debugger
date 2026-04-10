#!/usr/bin/env node
// Analyze Playwright fuzz-corpus test failures from a JSON report.
// Usage: node scripts/analyze-failures.mjs [path-to-results.json] [--kind=flex-item-main] [--axis=width] [--show=5]

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const jsonPath = args.find(a => !a.startsWith("--")) || "./test-results-tmp.json";
const getFlag = (name) => {
  const a = args.find(a => a.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : null;
};

const kindFilter = getFlag("kind");
const axisFilter = getFlag("axis");
const showCount = parseInt(getFlag("show") || "0", 10);
const fileFilter = getFlag("file");

if (!fs.existsSync(jsonPath)) {
  console.error(`File not found: ${jsonPath}`);
  console.error(`Run: npx playwright test --project default --reporter=json > test-results-tmp.json`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const failures = [];

function walk(s) {
  if (s.suites) s.suites.forEach(walk);
  if (s.specs) s.specs.forEach(spec => {
    spec.tests.forEach(t => {
      if (t.results.some(r => r.status === "failed")) {
        const errRaw = t.results[0].error?.message || "";
        const err = errRaw.replace(/\x1b\[[0-9;]*m/g, "");
        const match = err.match(/[wh]\d+: (\S+) (.*?) (width|height): DAG=([\d.-]+) actual=([\d.-]+) delta=([\d.-]+)/);
        failures.push({
          title: spec.title,
          err,
          kind: match?.[1],
          elementPath: match?.[2],
          axis: match?.[3],
          dag: match ? parseFloat(match[4]) : null,
          actual: match ? parseFloat(match[5]) : null,
          delta: match ? parseFloat(match[6]) : null,
        });
      }
    });
  });
}
report.suites.forEach(walk);

let filtered = failures;
if (kindFilter) filtered = filtered.filter(f => f.kind === kindFilter);
if (axisFilter) filtered = filtered.filter(f => f.axis === axisFilter);
if (fileFilter) filtered = filtered.filter(f => f.title.includes(fileFilter));

const sortMode = getFlag("sort");
if (sortMode === "delta-desc") filtered.sort((a, b) => (b.delta || 0) - (a.delta || 0));
if (sortMode === "delta-asc") filtered.sort((a, b) => (a.delta || 0) - (b.delta || 0));

const minDelta = parseFloat(getFlag("min-delta") || "0");
const maxDelta = parseFloat(getFlag("max-delta") || "Infinity");
filtered = filtered.filter(f => (f.delta || 0) >= minDelta && (f.delta || 0) <= maxDelta);

console.log(`Total failures: ${failures.length}`);
if (kindFilter || axisFilter || fileFilter) {
  console.log(`Filtered: ${filtered.length}`);
}
console.log();

const byKind = {};
for (const f of filtered) {
  const k = (f.kind || "unknown") + ":" + (f.axis || "?");
  byKind[k] = (byKind[k] || 0) + 1;
}
console.log("By kind:axis:");
Object.entries(byKind)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${v.toString().padStart(4)} ${k}`));

// Delta distribution
const deltas = filtered.map(f => f.delta).filter(d => d != null).sort((a, b) => a - b);
if (deltas.length > 0) {
  const buckets = { "<1": 0, "1-5": 0, "5-20": 0, "20-50": 0, "50+": 0 };
  for (const d of deltas) {
    if (d < 1) buckets["<1"]++;
    else if (d < 5) buckets["1-5"]++;
    else if (d < 20) buckets["5-20"]++;
    else if (d < 50) buckets["20-50"]++;
    else buckets["50+"]++;
  }
  console.log("\nDelta distribution:");
  Object.entries(buckets).forEach(([k, v]) => console.log(`  ${v.toString().padStart(4)} ${k}px`));
  console.log(`  min=${deltas[0]} median=${deltas[Math.floor(deltas.length / 2)]} max=${deltas[deltas.length - 1]}`);
}

if (showCount > 0) {
  console.log(`\n=== Showing first ${showCount} failures ===`);
  filtered.slice(0, showCount).forEach(f => {
    console.log(`\n--- ${f.title} ---`);
    console.log(`  kind=${f.kind} axis=${f.axis} DAG=${f.dag} actual=${f.actual} delta=${f.delta}`);
    console.log(`  element=${f.elementPath}`);
  });
}

// Also surface failures where the corpus JSON contains useful context
if (showCount > 0 && filtered.length > 0) {
  console.log("\n=== Corpus file paths (for inspection) ===");
  filtered.slice(0, showCount).forEach(f => {
    const corpusFile = f.title.replace("fuzz corpus: ", "");
    const corpusPath = path.join("test", "fuzz-corpus", corpusFile);
    console.log(`  ${corpusPath}`);
  });
}
