/**
 * Aspect ratio analyzer.
 *
 * Spec references:
 * - CSS Sizing 4 §5.1  Aspect Ratio
 * - CSS Sizing 4 §5.1.1  Resolving Aspect Ratios
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import type { CalcExpr } from "../dag";
import { ref, mul, div } from "../dag";
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

  const num = parseFloat(match[1]);
  const den = match[2] ? parseFloat(match[2]) : 1;

  const otherAxis: Axis = axis === "width" ? "height" : "width";
  const thisExplicit = getExplicitSize(el, axis);
  const otherExplicit = getExplicitSize(el, otherAxis);
  if (thisExplicit || !otherExplicit) return null;

  const otherNode = fns.computeSize(el, otherAxis, depth);

  // Express the ratio as a division of the parsed components from the aspect-ratio property.
  // For width: result = height × (num / den). For height: result = width × (den / num).
  const ratioCalc: CalcExpr = axis === "width"
    ? div({ op: "property", name: "aspect-ratio", value: num }, { op: "property", name: "aspect-ratio", value: den })
    : div({ op: "property", name: "aspect-ratio", value: den }, { op: "property", name: "aspect-ratio", value: num });

  const calc = mul(ref(otherNode), ratioCalc);

  return fns.make("aspect-ratio", el, axis,
    `${axis} derived from the other axis via aspect-ratio`,
    calc,
    { otherAxis: otherNode });
}
