/**
 * Block layout analyzer.
 *
 * Spec references:
 * - CSS2 §10.3.3  Block-level, non-replaced elements in normal flow
 * - CSS2 §9.5     Floats (float avoidance for BFC elements)
 * - CSS2 §8.1     Box model content area
 */
import type { Axis, CalcExpr } from "../types";
import type { NodeBuilder } from "../node-builder";
import { ref, add, sub, cmax, propVal } from "../calc";
import { containerContentArea } from "../box-model";

/**
 * Block-fill: auto-width block fills containing block content area minus margins.
 * If the element creates a new block formatting context and has preceding
 * float siblings, its border-box cannot overlap the float's margin box
 * (CSS2 §9.5), so we subtract the float widths from the available space.
 */
export function blockFill(
  nb: NodeBuilder, axis: Axis,
): void {
  const cb = nb.proxy.getContainingBlock();
  const cbNode = nb.computeSize(cb.element, axis);
  const contentAreaNode = containerContentArea(nb, cb.element, axis, cbNode);

  const [mStartName, mEndName] = axis === "width"
    ? ["margin-left", "margin-right"] as const : ["margin-top", "margin-bottom"] as const;
  const pbProps = axis === "width"
    ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
    : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;

  // Float avoidance: only applies on the inline axis (width for horizontal-tb)
  // and only if the element establishes a new BFC.
  let floatAdjustment: CalcExpr | null = null;
  if (axis === "width" && nb.proxy.isNewBlockFormattingContext()) {
    const totalFloat = nb.proxy.sumPrecedingFloatOuterWidth();
    if (totalFloat > 0) {
      floatAdjustment = propVal("width", Math.round(totalFloat));
    }
  }

  const marginsAndFloats = floatAdjustment
    ? add(nb.prop(mStartName), nb.prop(mEndName), floatAdjustment)
    : add(nb.prop(mStartName), nb.prop(mEndName));

  nb.describe(floatAdjustment
    ? `Block element \u2014 ${axis} fills the available space in its parent (reduced by preceding floats)`
    : `Block element \u2014 ${axis} fills the available space in its parent`)
    .calc(cmax(
      add(...pbProps.map(p => nb.prop(p))),
      sub(ref(contentAreaNode), marginsAndFloats),
    ))
    .input("containingBlockContent", contentAreaNode);
}
