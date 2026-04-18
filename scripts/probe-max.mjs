#!/usr/bin/env node
// Check getComputedStyle.maxWidth for the items in fuzz-1775750779123.
import { chromium } from "playwright";
import fs from "fs";

function render(spec) {
  const style = Object.entries(spec.style || {}).map(([k, v]) => `${k}:${v}`).join(";");
  const children = (spec.children || []).map(render).join("");
  const text = spec.text || "";
  return `<div style="${style}">${text}${children}</div>`;
}

const corpus = JSON.parse(fs.readFileSync("test/fuzz-corpus/fuzz-1775750779123.json", "utf-8"));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<!doctype html><html><body>${render(corpus.spec)}</body></html>`);

const info = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.maxWidth !== "none" || cs.minWidth !== "auto" || cs.maxHeight !== "none" || cs.minHeight !== "auto") {
      out.push({
        tag: el.tagName,
        display: cs.display,
        inlineMaxW: el.style.maxWidth || "",
        inlineMaxH: el.style.maxHeight || "",
        inlineMinW: el.style.minWidth || "",
        inlineMinH: el.style.minHeight || "",
        computedMaxW: cs.maxWidth,
        computedMaxH: cs.maxHeight,
        computedMinW: cs.minWidth,
        computedMinH: cs.minHeight,
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
      });
    }
  }
  return out;
});
await browser.close();

for (const r of info) {
  console.log(JSON.stringify(r, null, 2));
}
