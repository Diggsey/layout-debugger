#!/usr/bin/env node
// Probe: how does min-width:66% resolve on a flex item in an inline-flex
// container with no explicit width?
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

await page.setContent(`<!doctype html><html><body>
<div style="height:47%;padding:14px;border:4px solid black;margin:3px;box-sizing:border-box;min-width:85px;max-width:62%;display:inline-flex;overflow:hidden;gap:11px;justify-content:space-around">
  <div id="c1" style="width:22px;height:55px;min-width:78px;min-height:68%"></div>
  <div id="c2" style="width:53px;height:67px;padding:2px;margin:6px;min-width:66%;max-width:278px">Flex Grid Hello</div>
  <div id="c3" style="width:126px;height:22px;border:4px solid black;box-sizing:border-box;min-width:51px;flex-shrink:1;overflow:scroll;aspect-ratio:2;contain:strict"></div>
  <div id="c4" style="width:33px;height:37px;box-sizing:border-box;min-width:32px">Grid Test Overflow Layout Flex</div>
</div>
</body></html>`);

const info = await page.evaluate(() => {
  const get = (id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  };
  return {
    parent: document.querySelector("[style*='inline-flex']").getBoundingClientRect().width,
    c1: get("c1"), c2: get("c2"), c3: get("c3"), c4: get("c4"),
  };
});
console.log(info);

await browser.close();
