/**
 * Aspect ratio analyzer.
 *
 * Derives one axis from the other when aspect-ratio is set and only
 * one axis has a definite size.
 *
 * Spec references:
 * - CSS Sizing 4 §5.1  Aspect Ratio
 *   https://www.w3.org/TR/css-sizing-4/#aspect-ratio
 *   "If an element has a preferred aspect ratio and one axis is definite,
 *   the other is computed from the definite size and the ratio."
 *
 * - CSS Sizing 4 §5.1.1  Resolving Aspect Ratios
 *   https://www.w3.org/TR/css-sizing-4/#aspect-ratio-minimum
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import type { LayoutContext } from "../types";
import { getExplicitSize } from "../sizing";
import { round } from "../utils";

/**
 * Compute one axis from the other via aspect-ratio.
 *
 * Returns null if aspect-ratio doesn't apply (both axes definite,
 * neither definite, or no valid ratio).
 *
 * CSS Sizing 4 §5.1: transferred size = other axis × ratio
 * For width:  result = height × (num / den)
 * For height: result = width × (den / num) = width × (1 / ratio)
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

  const num = parseFloat(match[1]);
  const den = match[2] ? parseFloat(match[2]) : 1;
  const ratio = num / den;

  const otherAxis: Axis = axis === "width" ? "height" : "width";
  const thisExplicit = getExplicitSize(el, axis);
  const otherExplicit = getExplicitSize(el, otherAxis);
  if (thisExplicit || !otherExplicit) return null;

  const otherNode = fns.computeSize(el, otherAxis, depth);
  const effectiveRatio = axis === "width" ? ratio : 1 / ratio;
  const result = round(otherNode.result * effectiveRatio);

  return fns.make("aspect-ratio", el, axis, result,
    { otherAxis: otherNode }, { ratio: effectiveRatio },
    `${otherNode.result}px \u00d7 ${round(effectiveRatio)} = ${result}px`,
    { "aspect-ratio": ar });
}
