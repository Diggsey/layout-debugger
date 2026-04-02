/**
 * Grid layout analyzer.
 *
 * Determines grid item sizes by reading the browser's resolved track sizes.
 *
 * Spec references:
 * - CSS Grid §11.1  Grid Item Sizing
 *   https://www.w3.org/TR/css-grid-1/#algo-overview
 *
 * - CSS Grid §7.2.1  Track Sizing Algorithm
 *   https://www.w3.org/TR/css-grid-1/#algo-track-sizing
 *   We don't re-implement the track sizing algorithm; instead we read
 *   the resolved gridTemplateColumns/Rows which the browser has already
 *   computed per the spec.
 *
 * - CSS Grid §8.3  Track Sizing Properties (grid-template-columns/rows)
 *   https://www.w3.org/TR/css-grid-1/#track-sizing
 *   getComputedStyle returns resolved pixel values for each track.
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import type { LayoutContext } from "../types";
import { px, round, parseTrackList } from "../utils";

/**
 * Grid item sizing: size = sum of spanned tracks + gaps between them.
 *
 * CSS Grid §11.1: A grid item's size in a given axis is determined by
 * the tracks it spans. We read the item's grid-column/row-start/end
 * and sum the resolved track sizes plus inter-track gaps.
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

  const containerNode = fns.computeSize(ctx.parent, axis, depth - 1);

  const tracksProp = axis === "width" ? "gridTemplateColumns" : "gridTemplateRows";
  const resolved = (containerStyle as any)[tracksProp] || "";
  const tracks = parseTrackList(resolved);
  const gapPropName = axis === "width" ? "columnGap" : "rowGap";
  const gapVal = px((containerStyle as any)[gapPropName]);

  const startProp = axis === "width" ? "gridColumnStart" : "gridRowStart";
  const endProp = axis === "width" ? "gridColumnEnd" : "gridRowEnd";
  const start = parseInt((elStyle as any)[startProp], 10);
  const end = parseInt((elStyle as any)[endProp], 10);

  let expr: string;
  if (!isNaN(start) && !isNaN(end) && tracks.length > 0) {
    const spanned = tracks.slice(start - 1, end - 1);
    const numGaps = Math.max(0, spanned.length - 1);
    expr = spanned.map((t) => `${round(t)}px`).join(" + ") +
      (numGaps > 0 ? ` + ${round(gapVal * numGaps)}px gaps` : "") + ` = ${size}px`;
  } else {
    expr = `auto-placed \u2192 ${size}px`;
  }

  return fns.make("grid-item", el, axis, size, { container: containerNode }, {},
    expr, { [`grid-${axis === "width" ? "column" : "row"}`]: `${start} / ${end}`, [gapPropName]: `${gapVal}px` });
}
