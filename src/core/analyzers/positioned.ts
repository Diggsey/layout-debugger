/**
 * Positioned layout analyzer.
 *
 * Implements sizing for absolutely and fixed positioned elements.
 *
 * Spec references:
 * - CSS2 §10.3.7  Absolutely positioned, non-replaced elements
 *   https://www.w3.org/TR/CSS2/visudet.html#abs-non-replaced-width
 *   "left + margin-left + border-left + padding-left + width + padding-right
 *   + border-right + margin-right + right = width of containing block"
 *
 * - CSS2 §10.3.8  Absolutely positioned, replaced elements
 *   https://www.w3.org/TR/CSS2/visudet.html#abs-replaced-width
 *
 * - CSS2 §10.6.4  Absolutely positioned, non-replaced elements (height)
 *   https://www.w3.org/TR/CSS2/visudet.html#abs-non-replaced-height
 *
 * - CSS Sizing 3 §4.6  Shrink-to-fit
 *   https://www.w3.org/TR/css-sizing-3/#shrink-to-fit
 *   When width is auto and no opposing offsets, use shrink-to-fit algorithm.
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import type { LayoutContext } from "../types";
import { px, round, isAuto } from "../utils";

/**
 * Size of an absolutely/fixed positioned element.
 *
 * Two cases:
 * - Opposing offsets (e.g. left + right both set):
 *   CSS2 §10.3.7: width = CB − left − right − margin − padding − border
 * - Otherwise:
 *   CSS Sizing 3 §4.6: width shrinks to fit content
 */
export function positioned(
  fns: SizeFns, b: DagBuilder, el: Element, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const s = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const size = round(axis === "width" ? rect.width : rect.height);

  const startProp = axis === "width" ? "left" : "top";
  const endProp = axis === "width" ? "right" : "bottom";
  const startVal = s.getPropertyValue(startProp);
  const endVal = s.getPropertyValue(endProp);

  if (!isAuto(startVal) && !isAuto(endVal)) {
    // §10.3.7: size derived from containing block minus offsets
    const cbNode = fns.computeSize(ctx.containingBlock, axis, depth - 1);
    return fns.make("positioned-offset", el, axis, size,
      { containingBlock: cbNode },
      { [startProp]: px(startVal), [endProp]: px(endVal) },
      `${cbNode.result}px \u2212 ${px(startVal)}px (${startProp}) \u2212 ${px(endVal)}px (${endProp}) \u2212 spacing = ${size}px`,
      { position: s.position, [startProp]: startVal, [endProp]: endVal });
  }

  // Shrink-to-fit: size from content
  const contentNode = fns.contentSize(el, axis, depth);
  return fns.make("positioned-shrink-to-fit", el, axis, size,
    { content: contentNode }, {},
    `shrink-to-fit \u2192 ${size}px`, { position: s.position });
}
