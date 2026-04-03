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
import { ref, prop, sub, add, cmax } from "../dag";
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
    const cb = ctx.containingBlock;
    const cbBorderProps = axis === "width"
      ? ["border-left-width", "border-right-width"] as const
      : ["border-top-width", "border-bottom-width"] as const;

    const cbNb = fns.begin("content-area", cb, axis);
    const cbPaddingBox = cbNb
      ? cbNb.describe("Containing block padding box (for positioned descendants)")
        .calc(sub(ref(cbNode), add(...cbBorderProps.map(p => prop(cb, p)))))
        .input("borderBox", cbNode)
        .finish()
      : b.get("content-area", cb, axis)!;

    // border-box = max(padding+border, CB_padding_box - left - right - margins)
    const nb = fns.begin("positioned-offset", el, axis);
    if (!nb) return b.get("positioned-offset", el, axis)!;

    nb.css("position", "Taken out of normal flow — sized by offsets");
    const [mStartName, mEndName] = axis === "width"
      ? ["margin-left", "margin-right"] : ["margin-top", "margin-bottom"];
    const pbProps = axis === "width"
      ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
      : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
    const spacing = add(
      nb.prop(startProp), nb.prop(endProp),
      nb.prop(mStartName), nb.prop(mEndName),
    );
    return nb
      .describe(`Absolutely positioned \u2014 ${axis} derived from opposing offsets`)
      .calc(cmax(add(...pbProps.map(p => nb.prop(p))), sub(ref(cbPaddingBox), spacing)))
      .input("containingBlock", cbNode)
      .finish();
  }

  const nb = fns.begin("positioned-shrink-to-fit", el, axis);
  if (!nb) return b.get("positioned-shrink-to-fit", el, axis)!;

  nb.css("position", "Taken out of normal flow — sized by content");
  const contentNode = fns.contentSize(el, axis, depth);
  return nb
    .describe(`Absolutely positioned \u2014 ${axis} shrinks to fit content`)
    .calc(ref(contentNode))
    .input("content", contentNode)
    .finish();
}
