/**
 * Grid layout analyzer.
 *
 * Spec references:
 * - CSS Grid §11.1  Grid Item Sizing
 * - CSS Grid §7.2.1 Track Sizing Algorithm
 * - CSS Grid §8.3   Track Sizing Properties
 */
import type { Axis, LayoutNode, SizeFns, NodeBuilder } from "../dag";
import type { LayoutContext } from "../types";
import { getExplicitSize } from "../sizing";

/**
 * Grid item sizing: measured from the DOM (track sizes determined by browser).
 */
export function gridItem(
  fns: SizeFns, nb: NodeBuilder, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const el = nb.element;
  nb.setKind("grid-item");

  const containerExplicit = getExplicitSize(ctx.parent, axis);
  if (containerExplicit) {
    nb.input("container", fns.computeSize(ctx.parent, axis, depth - 1));
  }

  const trackProp = `grid-${axis === "width" ? "column" : "row"}`;
  nb.css(trackProp);

  return nb
    .describe(`Grid item \u2014 ${axis} determined by the grid track it occupies`)
    .calc(fns.borderBoxCalc(el, axis))
    .finish();
}
