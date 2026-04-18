#!/usr/bin/env node
// Does align-items on container affect abs-pos? Also how is "normal" treated?
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

const tpl = (alignItems, alignSelf) => `<div style="position:relative;height:410px;width:500px;display:flex;padding:7px;${alignItems ? `align-items:${alignItems};` : ""}">
  <div id="t" style="position:absolute;top:8px;bottom:10px;left:12px;right:14px;${alignSelf ? `align-self:${alignSelf};` : ""}">Hi</div>
</div>`;

const cases = [
  { name: "no align-items, no align-self (default)", ai: null, as: null },
  { name: "align-items:flex-start", ai: "flex-start", as: null },
  { name: "align-items:stretch", ai: "stretch", as: null },
  { name: "align-items:flex-start + self:auto", ai: "flex-start", as: "auto" },
  { name: "align-items:flex-start + self:stretch", ai: "flex-start", as: "stretch" },
  { name: "align-items:flex-end + self:auto", ai: "flex-end", as: "auto" },
  { name: "align-items:normal", ai: "normal", as: null },
];

for (const c of cases) {
  await page.setContent(`<!doctype html><html><body>${tpl(c.ai, c.as)}</body></html>`);
  const info = await page.evaluate(() => {
    const t = document.getElementById("t");
    const r = t.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  console.log(c.name.padEnd(45), JSON.stringify(info));
}
await browser.close();
