#!/usr/bin/env node
// Probe: measure intrinsic height of the "interesting" items in the two
// fuzz cases we're analyzing, to see if Chrome's intrinsic measurement
// for a grid/flex item includes its explicit min-height.
import { chromium } from "playwright";
import fs from "fs";

function render(spec) {
  const style = Object.entries(spec.style || {}).map(([k, v]) => `${k}:${v}`).join(";");
  const children = (spec.children || []).map(render).join("");
  const text = spec.text || "";
  return `<div style="${style}">${text}${children}</div>`;
}

const browser = await chromium.launch();
const page = await browser.newPage();

for (const file of ["fuzz-1775140810276.json", "fuzz-1775741738868.json"]) {
  const corpus = JSON.parse(fs.readFileSync(`test/fuzz-corpus/${file}`, "utf-8"));
  await page.setContent(`<!doctype html><html><body>${render(corpus.spec)}</body></html>`);

  console.log(`\n========== ${file} ==========`);
  const info = await page.evaluate(() => {
    function allFlexItems() {
      const out = [];
      for (const el of document.querySelectorAll("*")) {
        const parent = el.parentElement;
        if (!parent) continue;
        const pcs = getComputedStyle(parent);
        if (pcs.display !== "flex" && pcs.display !== "inline-flex") continue;
        out.push(el);
      }
      return out;
    }

    function measureIntrinsic(el, axis) {
      // Clone with max-content sizing to measure the intrinsic along axis.
      // Respect the element's min-* to see if browser applies it.
      const clone = el.cloneNode(true);
      clone.style.cssText += `;position:absolute!important;visibility:hidden!important;${axis}:max-content!important;flex:none!important`;
      (el.parentElement || document.body).appendChild(clone);
      const v = clone.getBoundingClientRect()[axis];
      clone.remove();
      return v;
    }
    function measureMinContent(el, axis) {
      const clone = el.cloneNode(true);
      const minProp = axis === "width" ? "min-width" : "min-height";
      clone.style.cssText += `;position:absolute!important;visibility:hidden!important;${axis}:min-content!important;${minProp}:0!important;flex:none!important`;
      (el.parentElement || document.body).appendChild(clone);
      const v = clone.getBoundingClientRect()[axis];
      clone.remove();
      return v;
    }

    function measureIntrinsicNoMin(el, axis) {
      // Same as above, but override min to 0 to isolate pure content-size.
      const clone = el.cloneNode(true);
      const minProp = axis === "width" ? "min-width" : "min-height";
      clone.style.cssText += `;position:absolute!important;visibility:hidden!important;${axis}:max-content!important;${minProp}:0!important;flex:none!important`;
      (el.parentElement || document.body).appendChild(clone);
      const v = clone.getBoundingClientRect()[axis];
      clone.remove();
      return v;
    }

    const results = [];
    for (const el of allFlexItems()) {
      const cs = getComputedStyle(el);
      const minH = el.style.minHeight || "";
      const minW = el.style.minWidth || "";
      const h = el.style.height || "";
      const w = el.style.width || "";
      const fb = cs.flexBasis;
      // Is this an interesting item?
      if (!minH && !minW) continue;
      results.push({
        tag: el.tagName,
        display: cs.display,
        inlineH: h, inlineW: w, minH, minW, fb,
        computedH: el.getBoundingClientRect().height,
        computedW: el.getBoundingClientRect().width,
        intrinsicH: measureIntrinsic(el, "height"),
        intrinsicW: measureIntrinsic(el, "width"),
        intrinsicHNoMin: measureIntrinsicNoMin(el, "height"),
        intrinsicWNoMin: measureIntrinsicNoMin(el, "width"),
        minContentH: measureMinContent(el, "height"),
        minContentW: measureMinContent(el, "width"),
      });
    }
    return results;
  });

  for (const r of info) {
    console.log(JSON.stringify(r, null, 2));
  }
}
await browser.close();
