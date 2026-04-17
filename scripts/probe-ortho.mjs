#!/usr/bin/env node
// Measure min-content width of an orthogonal flex/grid with content.
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

// For each case, measure: actual width, and min-content of an equivalent
// isolated clone (to see what Chrome's intrinsic-size algorithm returns).
const scenarios = [
  { label: "flex+text", style: "display:flex;", inner: "Box Content Grid Test" },
  { label: "flex+empty", style: "display:flex;", inner: "" },
  { label: "block+text", style: "", inner: "Box Content Grid Test" },
  { label: "grid+text", style: "display:grid;", inner: "Box Content Grid Test" },
];

await page.setContent(`<!doctype html><html><body>
  ${scenarios.map(s => `<div data-label="${s.label}" style="display:inline-block;">
    <div id="${s.label}" style="width:289px;height:322px;writing-mode:vertical-lr;border:4px solid;box-sizing:border-box;${s.style}">${s.inner}</div>
  </div>`).join("")}
</body></html>`);

for (const s of scenarios) {
  const info = await page.evaluate((label) => {
    const el = document.getElementById(label);
    function clone(rules) {
      const c = el.cloneNode(true);
      c.style.cssText += "; " + rules.join(" !important; ") + " !important";
      document.body.appendChild(c);
      const r = c.getBoundingClientRect();
      const res = { w: r.width, h: r.height };
      c.remove();
      return res;
    }
    return {
      actual: { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height },
      minContent: clone(["position:absolute","visibility:hidden","width:min-content","height:auto","min-width:0","min-height:0","max-width:none","max-height:none","flex:none"]),
      minContentAtH: clone(["position:absolute","visibility:hidden","width:min-content","height:322px","min-width:0","min-height:0","max-width:none","max-height:none","flex:none"]),
      autoAbs: clone(["position:absolute","visibility:hidden","width:auto","height:auto","min-width:0","min-height:0","max-width:none","max-height:none","flex:none"]),
    };
  }, s.label);
  console.log(s.label.padEnd(15), JSON.stringify(info));
}
await browser.close();
