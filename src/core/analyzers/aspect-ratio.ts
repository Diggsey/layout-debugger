/**
 * Aspect ratio analyzer.
 *
 * Spec references:
 * - CSS Sizing 4 §5.1  Aspect Ratio
 * - CSS Sizing 4 §5.1.1  Resolving Aspect Ratios
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import { ref, prop, mul, div } from "../dag";
import type { LayoutContext } from "../types";
import { getExplicitSize } from "../sizing";

/**
 * Compute one axis from the other via aspect-ratio.
 * Returns null if aspect-ratio doesn't apply.
 */
export function aspectRatio(
  fns: SizeFns, b: DagBuilder, el: Element, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode | null {
  const s = getComputedStyle(el);
  const ar = s.aspectRatio;
  if (!ar || ar === "auto") return null;

  const match = ar.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
  if (!match) return null;

  const otherAxis: Axis = axis === "width" ? "height" : "width";
  const thisExplicit = getExplicitSize(el, axis);
  const otherExplicit = getExplicitSize(el, otherAxis);
  if (thisExplicit || !otherExplicit) return null;

  const otherNode = fns.computeSize(el, otherAxis, depth);

  // prop(el, "aspect-ratio") parses "16 / 9" → 1.777 (the width/height ratio).
  // For width: result = height × ratio. For height: result = width / ratio.
  const ratioProp = prop(el, "aspect-ratio");
  const calc = axis === "width"
    ? mul(ref(otherNode), ratioProp)
    : div(ref(otherNode), ratioProp);

  return fns.make("aspect-ratio", el, axis,
    `${axis} derived from the other axis via aspect-ratio`,
    calc,
    { otherAxis: otherNode });
}
