#!/usr/bin/env node
// Probe: for each failing fuzz corpus, measure every flex container's items
// and compare against what the freeze/redistribute algorithm should produce.
import { chromium } from "playwright";
import fs from "fs";

function render(spec) {
  const style = Object.entries(spec.style || {}).map(([k, v]) => `${k}:${v}`).join(";");
  const children = (spec.children || []).map(render).join("");
  const text = spec.text || "";
  return `<div style="${style}">${text}${children}</div>`;
}

const FAILURES = [
  "fuzz-1775750779087.json",
  "fuzz-1775750779123.json",
  "fuzz-1775735809317.json",
];

const browser = await chromium.launch();
const page = await browser.newPage();

for (const file of FAILURES) {
  const corpus = JSON.parse(fs.readFileSync(new URL(`../test/fuzz-corpus/${file}`, import.meta.url), "utf-8"));
  await page.setContent(`<!doctype html><html><body>${render(corpus.spec)}</body></html>`);

  const result = await page.evaluate(() => {
    function flexMain(el) {
      const cs = getComputedStyle(el);
      const dir = cs.flexDirection;
      const wm = cs.writingMode;
      const vertical = wm === "vertical-lr" || wm === "vertical-rl";
      const row = !dir.startsWith("column");
      if (row) return vertical ? "height" : "width";
      return vertical ? "width" : "height";
    }
    function sum(vals) { return vals.reduce((a, b) => a + b, 0); }
    function pb(el, axis) {
      const cs = getComputedStyle(el);
      const s = axis === "width" ? ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"]
                                 : ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"];
      return sum(s.map(k => parseFloat(cs[k]) || 0));
    }

    const flexContainers = Array.from(document.querySelectorAll("*")).filter(el => {
      const cs = getComputedStyle(el);
      return cs.display === "flex" || cs.display === "inline-flex";
    });

    const results = [];
    for (const c of flexContainers) {
      const cs = getComputedStyle(c);
      const axis = flexMain(c);
      const dir = cs.flexDirection;
      const mainGap = dir.startsWith("column") ? (parseFloat(cs.rowGap) || 0) : (parseFloat(cs.columnGap) || 0);
      const items = [];
      const collect = (parent) => {
        for (const ch of parent.children) {
          const ics = getComputedStyle(ch);
          if (ics.display === "none" || ics.position === "absolute" || ics.position === "fixed") continue;
          if (ics.display === "contents") { collect(ch); continue; }
          items.push(ch);
        }
      };
      collect(c);
      if (items.length === 0) continue;
      const contBorderBox = c.getBoundingClientRect()[axis];
      const contPB = pb(c, axis);
      const contentMain = contBorderBox - contPB;

      const itemInfo = items.map(it => {
        const ics = getComputedStyle(it);
        const fbRaw = it.style[`flex-basis`] || it.style.flexBasis || "";
        const fbComp = ics.flexBasis;
        const size = it.getBoundingClientRect()[axis];
        const mainProp = axis === "width" ? it.style.width : it.style.height;
        const minProp = axis === "width" ? it.style.minWidth : it.style.minHeight;
        const maxProp = axis === "width" ? it.style.maxWidth : it.style.maxHeight;
        const ibp = pb(it, axis);
        return {
          tag: it.tagName, mainInline: mainProp || "", minInline: minProp || "",
          maxInline: maxProp || "", fbRaw, fbComp,
          grow: parseFloat(ics.flexGrow) || 0,
          shrink: parseFloat(ics.flexShrink),
          size, pb: ibp, bs: ics.boxSizing,
        };
      });
      const sumSize = sum(itemInfo.map(i => i.size));
      const totalGap = mainGap * Math.max(0, items.length - 1);
      results.push({
        tag: c.tagName, axis, dir, contBorderBox, contPB, contentMain,
        mainGap, totalGap, nItems: items.length,
        sumSize, sumPlusGap: sumSize + totalGap,
        items: itemInfo,
      });
    }
    return results;
  });

  console.log(`\n========== ${file} ==========`);
  for (const r of result) {
    console.log(`  container <${r.tag.toLowerCase()}>: dir=${r.dir} axis=${r.axis} content=${r.contentMain} gap=${r.mainGap}x${r.nItems-1}=${r.totalGap}`);
    console.log(`    sum(items)=${r.sumSize.toFixed(2)} +gap=${r.sumPlusGap.toFixed(2)}`);
    for (const it of r.items) {
      console.log(`    • size=${it.size.toFixed(2)} [main=${it.mainInline} min=${it.minInline} fb=${it.fbRaw}(${it.fbComp}) g=${it.grow} s=${it.shrink} pb=${it.pb}]`);
    }
  }
}
await browser.close();
