#!/usr/bin/env node
// Probe: why is the flex-basis 293 and not max-content 496?
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

// Reproduce fuzz-416 spec simplified
const html = `<!doctype html><html><body>
<div id="flex" style="display:flex;flex-direction:row;width:769px;overflow:hidden;box-sizing:content-box;align-items:center">
  <div id="target" style="height:69%;margin:9px;box-sizing:border-box;min-height:calc(41% - 19px);overflow:hidden;float:right;aspect-ratio:3 / 3">
    <div style="width:52px;height:91px;box-sizing:border-box;min-height:38%;max-height:min(240px, 197px)"></div>
    <div style="width:113px;height:56px;border:1px solid black;box-sizing:border-box;max-width:452px;min-height:94px;max-height:484px">Hello Hello</div>
    <div style="display:block;width:267px;overflow:hidden;padding:13px">
      <div style="width:35px;height:101px;margin:4px;max-width:201px;min-height:18px;max-height:79px;min-width:18px">Content</div>
      <div style="width:311px;height:92px;min-width:47px;max-width:139px;min-height:35px;max-height:228px"></div>
      <div style="width:110px;height:177px;padding-top:9px;min-width:63px;max-width:278px;min-height:56px;max-height:229px;margin-right:2px"></div>
      <div style="width:261px;height:86px;padding:13px;border:2px solid black;min-width:52px;max-width:238px;min-height:29px;max-height:171px;margin-bottom:9px;margin-left:1px"></div>
    </div>
  </div>
  <div style="width:142px;height:53px;padding:10px;align-self:baseline"></div>
</div>
</body></html>`;

await page.setContent(html);
const info = await page.evaluate(() => {
  const target = document.getElementById("target");
  const r = target.getBoundingClientRect();
  return {
    targetWidth: r.width,
    targetHeight: r.height,
    css: getComputedStyle(target).width,
  };
});
console.log("Target:", info);

// Now measure what happens if we clone with flex-basis-content style:
const probe1 = await page.evaluate(() => {
  const target = document.getElementById("target");
  const clone = target.cloneNode(true);
  const rules = [
    "position: absolute !important",
    "visibility: hidden !important",
    "pointer-events: none !important",
    "width: auto !important",
    "align-self: flex-start !important",
    "flex: none !important",
    "min-width: 0 !important",
    "max-width: none !important",
  ];
  clone.style.cssText += "; " + rules.join("; ");
  target.parentElement.appendChild(clone);
  const w = clone.getBoundingClientRect().width;
  clone.remove();
  return w;
});
console.log("Clone width (width:auto + height:69%):", probe1);

// Try without percentage height (just let AR work against nothing definite)
const probe2 = await page.evaluate(() => {
  const target = document.getElementById("target");
  const clone = target.cloneNode(true);
  const rules = [
    "position: absolute !important",
    "visibility: hidden !important",
    "pointer-events: none !important",
    "width: auto !important",
    "height: auto !important",
    "align-self: flex-start !important",
    "flex: none !important",
    "min-width: 0 !important",
    "min-height: 0 !important",
    "max-width: none !important",
    "max-height: none !important",
  ];
  clone.style.cssText += "; " + rules.join("; ");
  target.parentElement.appendChild(clone);
  const w = clone.getBoundingClientRect().width;
  const h = clone.getBoundingClientRect().height;
  clone.remove();
  return { w, h };
});
console.log("Clone width (width:auto, height:auto, AR preserved):", probe2);

// Try without AR — max-content without AR
const probe3 = await page.evaluate(() => {
  const target = document.getElementById("target");
  const clone = target.cloneNode(true);
  const rules = [
    "position: absolute !important",
    "visibility: hidden !important",
    "pointer-events: none !important",
    "width: auto !important",
    "height: auto !important",
    "aspect-ratio: auto !important",
    "align-self: flex-start !important",
    "flex: none !important",
    "min-width: 0 !important",
    "min-height: 0 !important",
    "max-width: none !important",
    "max-height: none !important",
  ];
  clone.style.cssText += "; " + rules.join("; ");
  target.parentElement.appendChild(clone);
  const w = clone.getBoundingClientRect().width;
  const h = clone.getBoundingClientRect().height;
  clone.remove();
  return { w, h };
});
console.log("Clone width (no AR):", probe3);

await browser.close();
