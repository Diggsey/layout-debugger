/**
 * Aspect ratio analyzer.
 *
 * Spec references:
 * - CSS Sizing 4 §5.1  Aspect Ratio
 * - CSS Sizing 4 §5.1.1  Resolving Aspect Ratios
 */
import type { Axis, CalcExpr, SizeFns, NodeBuilder } from "../dag";
import { ref, prop, mul, div, add, sub } from "../dag";
import type { LayoutContext } from "../types";
import { getExplicitSize } from "../sizing";

/**
 * Populate the node builder for aspect-ratio sizing.
 * Derives one axis from the other via aspect-ratio.
 */
export function aspectRatio(
  fns: SizeFns, nb: NodeBuilder, axis: Axis,
  ctx: LayoutContext, depth: number,
): void {
  const el = nb.element;
  const s = getComputedStyle(el);
  const ar = s.aspectRatio;
  if (!ar || ar === "auto") {
    nb.describe("Measured size").calc(fns.borderBoxCalc(el, axis));
    return;
  }

  const match = ar.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
  if (!match) {
    nb.describe("Measured size").calc(fns.borderBoxCalc(el, axis));
    return;
  }

  const otherAxis: Axis = axis === "width" ? "height" : "width";
  const thisExplicit = getExplicitSize(el, axis);
  const otherExplicit = getExplicitSize(el, otherAxis);
  if (thisExplicit || !otherExplicit) {
    nb.describe("Measured size").calc(fns.borderBoxCalc(el, axis));
    return;
  }

  const otherNode = fns.computeSize(el, otherAxis, depth);

  const ratioProp = nb.prop("aspect-ratio");
  const isBorderBox = s.boxSizing === "border-box";
  let calc: CalcExpr;

  if (isBorderBox) {
    calc = axis === "width"
      ? mul(ref(otherNode), ratioProp)
      : div(ref(otherNode), ratioProp);
  } else {
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

  // Use browser's measured result for edge cases (scrollbars, overflow, etc.)
  const rect = el.getBoundingClientRect();
  const measured = axis === "width" ? rect.width : rect.height;
  nb.overrideResult(Math.round(measured * 100) / 100);
}
