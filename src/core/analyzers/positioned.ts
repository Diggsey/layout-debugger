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
import { ref, prop, sub, add } from "../dag";
import type { LayoutContext } from "../types";
import { isAuto } from "../utils";

/**
 * Size of an absolutely/fixed positioned element.
 */
export function positioned(
  fns: SizeFns, b: DagBuilder, el: Element, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const s = getComputedStyle(el);

  const startProp = axis === "width" ? "left" : "top";
  const endProp = axis === "width" ? "right" : "bottom";
  const startVal = s.getPropertyValue(startProp);
  const endVal = s.getPropertyValue(endProp);

  if (!isAuto(startVal) && !isAuto(endVal)) {
    const cbNode = fns.computeSize(ctx.containingBlock, axis, depth - 1);
    // For abs positioning, the CB is the PADDING box (border-box - borders).
    // Create a padding-box node for the CB.
    const cb = ctx.containingBlock;
    const cbBorderProps = axis === "width"
      ? ["border-left-width", "border-right-width"] as const
      : ["border-top-width", "border-bottom-width"] as const;
    const cbPaddingBox = fns.make("content-area", cb, axis,
      "Containing block padding box (for positioned descendants)",
      sub(ref(cbNode), add(...cbBorderProps.map(p => prop(cb, p)))),
      { borderBox: cbNode });

    // border-box = CB_padding_box - left - right - marginLeft - marginRight
    const [mStartName, mEndName] = axis === "width"
      ? ["margin-left", "margin-right"] : ["margin-top", "margin-bottom"];
    const spacing = add(
      prop(el, startProp), prop(el, endProp),
      prop(el, mStartName), prop(el, mEndName),
    );
    const calc = sub(ref(cbPaddingBox), spacing);
    return fns.make("positioned-offset", el, axis,
      `Absolutely positioned \u2014 ${axis} derived from opposing offsets`,
      calc,
      { containingBlock: cbNode },
      { position: s.position });
  }

  const contentNode = fns.contentSize(el, axis, depth);
  return fns.make("positioned-shrink-to-fit", el, axis,
    `Absolutely positioned \u2014 ${axis} shrinks to fit content`,
    ref(contentNode),
    { content: contentNode },
    { position: s.position });
}
