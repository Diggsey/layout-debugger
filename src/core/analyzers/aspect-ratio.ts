/**
 * Aspect ratio analyzer.
 *
 * Spec references:
 * - CSS Sizing 4 §5.1  Aspect Ratio
 * - CSS Sizing 4 §5.1.1  Resolving Aspect Ratios
 */
import type { Axis, CalcExpr, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import { ref, prop, mul, div, add, sub } from "../dag";
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

  const nb = fns.begin("aspect-ratio", el, axis);
  if (!nb) return b.get("aspect-ratio", el, axis)!;

  const otherNode = fns.computeSize(el, otherAxis, depth);

  // Per CSS Sizing 4 §5.1.1: for border-box, the ratio applies to the border box
  // directly. For content-box, it applies to the content box (need to adjust for padding/border).
  const ratioProp = nb.prop("aspect-ratio");
  const isBorderBox = s.boxSizing === "border-box";
  let calc: CalcExpr;

  if (isBorderBox) {
    // Ratio applies to border-box directly
    calc = axis === "width"
      ? mul(ref(otherNode), ratioProp)
      : div(ref(otherNode), ratioProp);
  } else {
    // Ratio applies to content-box — subtract other axis pb, apply ratio, add this axis pb
    const otherPb = otherAxis === "width"
      ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
      : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
    const thisPb = axis === "width"
      ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
      : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
    const otherContent = sub(ref(otherNode), add(...otherPb.map(p => prop(el, p))));
    const thisContent = axis === "width"
      ? mul(otherContent, ratioProp)
      : div(otherContent, ratioProp);
    calc = add(thisContent, ...thisPb.map(p => nb.prop(p)));
  }

  nb.describe(`${axis} derived from the other axis via aspect-ratio`)
    .calc(calc)
    .input("otherAxis", otherNode);

  // For non-replaced elements, content can override the aspect-ratio result
  // (scrollbars, overflow: visible with tall content, etc.).
  // Use the browser's measured result to handle edge cases.
  const rect = el.getBoundingClientRect();
  const measured = axis === "width" ? rect.width : rect.height;
  return nb.finishWithResult(Math.round(measured * 100) / 100);
}
