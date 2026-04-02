/**
 * Grid layout analyzer.
 *
 * Spec references:
 * - CSS Grid §11.1  Grid Item Sizing
 * - CSS Grid §7.2.1 Track Sizing Algorithm
 * - CSS Grid §8.3   Track Sizing Properties
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import type { LayoutContext } from "../types";
import { getExplicitSize } from "../sizing";

/**
 * Grid item sizing: measured from the DOM (track sizes determined by browser).
 */
export function gridItem(
  fns: SizeFns, b: DagBuilder, el: Element, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const existing = b.get("grid-item", el, axis);
  if (existing) return existing;

  const elStyle = getComputedStyle(el);

  const containerExplicit = getExplicitSize(ctx.parent, axis);
  const containerNode = containerExplicit
    ? fns.computeSize(ctx.parent, axis, depth - 1)
    : null;

  const inputs: LayoutNode["inputs"] = {};
  if (containerNode) inputs.container = containerNode;

  const startProp = axis === "width" ? "gridColumnStart" : "gridRowStart";
  const endProp = axis === "width" ? "gridColumnEnd" : "gridRowEnd";
  const start = parseInt((elStyle as any)[startProp], 10);
  const end = parseInt((elStyle as any)[endProp], 10);

  // Grid item size comes from the resolved track sizes (browser-computed).
  const calc = fns.borderBoxCalc(el, axis);

  return fns.make("grid-item", el, axis,
    `Grid item \u2014 ${axis} determined by the grid track it occupies`,
    calc, inputs,
    { [`grid-${axis === "width" ? "column" : "row"}`]: `${start} / ${end}` });
}
