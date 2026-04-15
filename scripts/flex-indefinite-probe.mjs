#!/usr/bin/env node
// Probe: validate that sum-of-preferred-main-sizes + gaps matches the
// observed container main size, for ALL flex containers in the failing
// corpus cases. Preferred is computed from the AUTHOR-specified inline
// style (pre-flex), not getComputedStyle (which returns the laid-out value
// and would make the check circular).
import { chromium } from "playwright";
import fs from "fs";

function render(spec) {
  const style = Object.entries(spec.style || {}).map(([k, v]) => `${k}:${v}`).join(";");
  const children = (spec.children || []).map(render).join("");
  const text = spec.text || "";
  return `<div style="${style}">${text}${children}</div>`;
}

const FAILURES = [
  "fuzz-1775741691214.json",
  "fuzz-1775735809440.json",
  "fuzz-1775735872317.json",
  "fuzz-1775744683143.json",
  "fuzz-1775751793006.json",
  "fuzz-1775773559391.json",
];

const browser = await chromium.launch();
const page = await browser.newPage();

for (const file of FAILURES) {
  const corpus = JSON.parse(fs.readFileSync(new URL(`../test/fuzz-corpus/${file}`, import.meta.url), "utf-8"));
  await page.setContent(`<!doctype html><html><body>${render(corpus.spec)}</body></html>`);

  const result = await page.evaluate(() => {
    function flexMainAxis(el) {
      const cs = getComputedStyle(el);
      const dir = cs.flexDirection;
      const wm = cs.writingMode;
      const vertical = wm === "vertical-lr" || wm === "vertical-rl";
      const row = !dir.startsWith("column");
      if (row) return vertical ? "height" : "width";
      return vertical ? "width" : "height";
    }

    function parsePx(s) {
      const m = /^(-?[\d.]+)px$/.exec(s);
      return m ? parseFloat(m[1]) : null;
    }

    function outerPreferred(item, axis, containerMainContentPx) {
      // Use AUTHOR style (from the corpus-generated inline style), not computed style.
      const inlineAxis = item.style[axis] || ""; // inline style value, as author wrote it
      const cs = getComputedStyle(item);
      const box = cs.boxSizing;
      const padStart = parseFloat(cs[axis === "width" ? "paddingLeft" : "paddingTop"]) || 0;
      const padEnd = parseFloat(cs[axis === "width" ? "paddingRight" : "paddingBottom"]) || 0;
      const bordStart = parseFloat(cs[axis === "width" ? "borderLeftWidth" : "borderTopWidth"]) || 0;
      const bordEnd = parseFloat(cs[axis === "width" ? "borderRightWidth" : "borderBottomWidth"]) || 0;
      const pb = padStart + padEnd + bordStart + bordEnd;
      const marginStart = parseFloat(cs[axis === "width" ? "marginLeft" : "marginTop"]) || 0;
      const marginEnd = parseFloat(cs[axis === "width" ? "marginRight" : "marginBottom"]) || 0;
      const margin = marginStart + marginEnd;

      // Resolve inline
      let inner;
      let basis = "missing";
      if (inlineAxis === "" || inlineAxis === "auto") {
        // Measure max-content
        const clone = item.cloneNode(true);
        clone.style.cssText += `;position:absolute!important;visibility:hidden!important;${axis}:max-content!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;flex:none!important`;
        (item.parentElement || document.body).appendChild(clone);
        inner = clone.getBoundingClientRect()[axis];
        clone.remove();
        basis = "max-content";
      } else if (/%$/.test(inlineAxis)) {
        const pct = parseFloat(inlineAxis) / 100;
        if (containerMainContentPx != null && isFinite(containerMainContentPx)) {
          const raw = pct * containerMainContentPx;
          inner = (box === "border-box") ? raw : raw + pb;
          basis = `${pct*100}% of ${containerMainContentPx}`;
        } else {
          inner = 0;
          basis = "% of indefinite → 0";
        }
      } else {
        const px = parsePx(inlineAxis);
        if (px !== null) {
          inner = (box === "border-box") ? px : px + pb;
          basis = `${inlineAxis} specified`;
        } else {
          // Could be min-content/max-content keywords or calc() — measure
          const clone = item.cloneNode(true);
          clone.style.cssText += `;position:absolute!important;visibility:hidden!important;${axis}:${inlineAxis}!important;flex:none!important`;
          (item.parentElement || document.body).appendChild(clone);
          inner = clone.getBoundingClientRect()[axis];
          clone.remove();
          basis = `keyword: ${inlineAxis}`;
        }
      }
      return { inner, margin, outer: inner + margin, basis };
    }

    const results = [];
    const flexContainers = Array.from(document.querySelectorAll("*")).filter(el => {
      const cs = getComputedStyle(el);
      return cs.display === "flex" || cs.display === "inline-flex";
    });

    for (const c of flexContainers) {
      const cs = getComputedStyle(c);
      const mainAxis = flexMainAxis(c);
      const cssDir = cs.flexDirection;
      // For flex: gap along main axis = column-gap if row direction, row-gap if column
      const mainGap = cssDir.startsWith("column")
        ? (parseFloat(cs.rowGap) || 0)
        : (parseFloat(cs.columnGap) || 0);

      const inlineMain = c.style[mainAxis] || "";
      const parentCS = c.parentElement ? getComputedStyle(c.parentElement) : null;
      const parentDef = parentCS && c.parentElement ? (parentCS[mainAxis] !== "auto") : false;
      const mainDefinite =
        (inlineMain !== "" && inlineMain !== "auto" && !inlineMain.includes("%"));

      const items = Array.from(c.children).filter(ch => {
        const ccs = getComputedStyle(ch);
        return ccs.display !== "none" && ccs.position !== "absolute" && ccs.position !== "fixed";
      });
      if (items.length === 0) continue;

      // If the container's main axis is definite, we pass its content size to items
      // for percentage resolution. If indefinite, pass null.
      let containerContentForItems = null;
      if (mainDefinite) {
        const contBorderBox = c.getBoundingClientRect()[mainAxis];
        const contPadStart = parseFloat(cs[mainAxis === "width" ? "paddingLeft" : "paddingTop"]) || 0;
        const contPadEnd = parseFloat(cs[mainAxis === "width" ? "paddingRight" : "paddingBottom"]) || 0;
        const contBordStart = parseFloat(cs[mainAxis === "width" ? "borderLeftWidth" : "borderTopWidth"]) || 0;
        const contBordEnd = parseFloat(cs[mainAxis === "width" ? "borderRightWidth" : "borderBottomWidth"]) || 0;
        containerContentForItems = contBorderBox - contPadStart - contPadEnd - contBordStart - contBordEnd;
      }

      const contribs = items.map(it => {
        const p = outerPreferred(it, mainAxis, containerContentForItems);
        const actual = it.getBoundingClientRect()[mainAxis];
        return { preferred: p, actualMain: actual };
      });
      const sumPreferred = contribs.reduce((s, x) => s + x.preferred.outer, 0);
      const totalGap = mainGap * Math.max(0, items.length - 1);
      const predicted = sumPreferred + totalGap;
      const actualContainer = c.getBoundingClientRect()[mainAxis];

      results.push({
        tag: c.tagName + (c.id ? `#${c.id}` : ""),
        mainAxis, cssDir, inlineMain, mainDefinite,
        actualContainer, predicted, diff: actualContainer - predicted,
        sumPreferred, totalGap, nItems: items.length,
        items: contribs.map(c => ({ pref: c.preferred.outer.toFixed(2), actual: c.actualMain.toFixed(2), basis: c.preferred.basis })),
      });
    }
    return results;
  });

  console.log(`\n=== ${file} ===`);
  for (const r of result) {
    const defStr = r.mainDefinite ? "DEFINITE" : "INDEFINITE";
    console.log(`  ${r.tag} (${r.cssDir}, main=${r.mainAxis}, style=${JSON.stringify(r.inlineMain)}, ${defStr})`);
    console.log(`    actual = ${r.actualContainer.toFixed(2)}, predicted = ${r.predicted.toFixed(2)}, diff = ${r.diff.toFixed(2)}  [sumPref=${r.sumPreferred.toFixed(2)}, gaps=${r.totalGap}, n=${r.nItems}]`);
    for (const it of r.items) {
      console.log(`    • pref=${it.pref} actual=${it.actual}  (${it.basis})`);
    }
  }
}
await browser.close();
