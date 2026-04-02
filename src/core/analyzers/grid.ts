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
import { val } from "../dag";
import type { LayoutContext } from "../types";
import { getExplicitSize } from "../sizing";
import { px, round, parseTrackList } from "../utils";

/**
 * Grid item sizing: measured from the DOM (track sizes determined by browser).
 */
export function gridItem(
  fns: SizeFns, b: DagBuilder, el: Element, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const existing = b.get("grid-item", el, axis);
  if (existing) return existing;

  const containerStyle = getComputedStyle(ctx.parent);
  const elStyle = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const size = round(axis === "width" ? rect.width : rect.height);

  // Only compute the container's size on this axis if it has an explicit
  // size. For auto-sized containers, the container depends on its grid
  // items — computing it would create a cycle. The grid item's own size
  // comes from getBoundingClientRect, not from the container node.
  const containerExplicit = getExplicitSize(ctx.parent, axis);
  const containerNode = containerExplicit
    ? fns.computeSize(ctx.parent, axis, depth - 1)
    : null;

  const inputs: LayoutNode["inputs"] = {};
  if (containerNode) inputs.container = containerNode;

  const tracksProp = axis === "width" ? "gridTemplateColumns" : "gridTemplateRows";
  const resolved = (containerStyle as any)[tracksProp] || "";
  const tracks = parseTrackList(resolved);
  const gapPropName = axis === "width" ? "columnGap" : "rowGap";
  const gapVal = px((containerStyle as any)[gapPropName]);

  const startProp = axis === "width" ? "gridColumnStart" : "gridRowStart";
  const endProp = axis === "width" ? "gridColumnEnd" : "gridRowEnd";
  const start = parseInt((elStyle as any)[startProp], 10);
  const end = parseInt((elStyle as any)[endProp], 10);

  let label: string;
  if (!isNaN(start) && !isNaN(end) && tracks.length > 0) {
    const spanned = tracks.slice(start - 1, end - 1);
    const numGaps = Math.max(0, spanned.length - 1);
    label = spanned.map((t) => `${round(t)}px`).join(" + ") +
      (numGaps > 0 ? ` + ${round(gapVal * numGaps)}px gaps` : "");
  } else {
    label = "auto-placed";
  }

  return fns.make("grid-item", el, axis,
    `Grid item \u2014 ${axis} determined by the grid track it occupies`,
    val(size, label),
    inputs,
    { [`grid-${axis === "width" ? "column" : "row"}`]: `${start} / ${end}`, [gapPropName]: `${gapVal}px` });
}
