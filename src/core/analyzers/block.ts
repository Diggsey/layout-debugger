/**
 * Block layout analyzer.
 *
 * Spec references:
 * - CSS2 §10.3.3  Block-level, non-replaced elements in normal flow
 * - CSS2 §8.1     Box model content area
 */
import type { Axis } from "../types";
import type { NodeBuilder } from "../node-builder";
import { ref, add, sub, cmax } from "../calc";
import { containerContentArea } from "../box-model";

/**
 * Block-fill: auto-width block fills containing block content area minus margins.
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

  nb.describe(`Block element \u2014 ${axis} fills the available space in its parent`)
    .calc(cmax(
      add(...pbProps.map(p => nb.prop(p))),
      sub(ref(contentAreaNode), add(nb.prop(mStartName), nb.prop(mEndName))),
    ))
    .input("containingBlockContent", contentAreaNode);
}
