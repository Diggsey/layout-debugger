#!/usr/bin/env node
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

await page.setContent(`<!doctype html><html><body>
<div id="container" style="display:flex;flex-direction:column;height:584px;overflow:hidden;padding-bottom:2px;border:1px solid black;box-sizing:border-box;writing-mode:vertical-rl">
  <div id="target" style="overflow:hidden;aspect-ratio:3 / 4;height:218px;flex-grow:4;min-width:69%">
    <div style="width:92px;height:68px;border:4px solid black"></div>
  </div>
  <div style="width:144px;height:86px;min-width:67px;flex-basis:32px"></div>
  <div style="width:23px;height:58px;padding-top:15px;padding-right:10px;padding-bottom:13px;min-width:56px;max-width:357px;max-height:285px"></div>
</div>
</body></html>`);

const info = await page.evaluate(() => {
  const container = document.getElementById("container");
  const target = document.getElementById("target");
  const cr = container.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const cs = getComputedStyle(container);
  const ts = getComputedStyle(target);
  return {
    container: { w: cr.width, h: cr.height, css_w: cs.width, css_h: cs.height },
    target: { w: tr.width, h: tr.height, css_w: ts.width, css_h: ts.height, css_min_w: ts.minWidth },
  };
});
console.log(info);

await browser.close();
