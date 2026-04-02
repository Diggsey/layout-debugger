/**
 * Positioned layout analyzer.
 *
 * Spec references:
 * - CSS2 §10.3.7  Absolutely positioned, non-replaced elements
 * - CSS2 §10.6.4  Absolutely positioned, non-replaced elements (height)
 * - CSS Sizing 3 §4.6  Shrink-to-fit
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import { val, ref } from "../dag";
import type { LayoutContext } from "../types";
import { px, round, isAuto } from "../utils";

/**
 * Size of an absolutely/fixed positioned element.
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
    const cbNode = fns.computeSize(ctx.containingBlock, axis, depth - 1);
    return fns.make("positioned-offset", el, axis,
      `Absolutely positioned \u2014 ${axis} derived from opposing offsets`,
      val(size, `${cbNode.result}px \u2212 ${startProp}:${px(startVal)}px \u2212 ${endProp}:${px(endVal)}px`),
      { containingBlock: cbNode },
      { position: s.position, [startProp]: startVal, [endProp]: endVal });
  }

  const contentNode = fns.contentSize(el, axis, depth);
  return fns.make("positioned-shrink-to-fit", el, axis,
    `Absolutely positioned \u2014 ${axis} shrinks to fit content`,
    ref(contentNode),
    { content: contentNode },
    { position: s.position });
}
