/**
 * Aspect ratio analyzer.
 */
import type { Axis, CalcExpr, SizeFns, NodeBuilder } from "../dag";
import { ref, prop, mul, div, add, sub } from "../dag";

export function aspectRatio(
  fns: SizeFns, nb: NodeBuilder, axis: Axis, depth: number,
): void {
  const el = nb.element;
  const ar = nb.css("aspect-ratio");
  if (!ar || ar === "auto") {
    nb.describe("Measured size").calc(fns.borderBoxCalc(nb.proxy, axis));
    return;
  }

  const match = ar.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
  if (!match) {
    nb.describe("Measured size").calc(fns.borderBoxCalc(nb.proxy, axis));
    return;
  }

  const otherAxis: Axis = axis === "width" ? "height" : "width";
  if (nb.proxy.getExplicitSize(axis) || !nb.proxy.getExplicitSize(otherAxis)) {
    nb.describe("Measured size").calc(fns.borderBoxCalc(nb.proxy, axis));
    return;
  }

  const otherNode = fns.computeSize(el, otherAxis, depth);

  const ratioProp = nb.prop("aspect-ratio");
  const isBorderBox = nb.css("box-sizing") === "border-box";
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
    const otherContent = sub(ref(otherNode), add(...otherPb.map(p => prop(nb.proxy, p))));
    const thisContent = axis === "width"
      ? mul(otherContent, ratioProp)
      : div(otherContent, ratioProp);
    calc = add(thisContent, ...thisPb.map(p => nb.prop(p)));
  }

  nb.describe(`${axis} derived from the other axis via aspect-ratio`)
    .calc(calc)
    .input("otherAxis", otherNode);

  // Use browser-measured result for edge cases (scrollbars, overflow, etc.)
  // TODO: handle these in the calc instead of overriding
  const rect = el.getBoundingClientRect();
  const measuredVal = axis === "width" ? rect.width : rect.height;
  nb.overrideResult(Math.round(measuredVal * 100) / 100);
}
