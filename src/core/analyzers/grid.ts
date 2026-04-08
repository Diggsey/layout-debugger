/**
 * Grid layout analyzer.
 */
import type { Axis, SizeFns, NodeBuilder } from "../dag";

export function gridItem(
  fns: SizeFns, nb: NodeBuilder, axis: Axis, depth: number,
): void {
  const parent = nb.proxy.getParent();

  if (parent.getExplicitSize(axis)) {
    nb.input("container", fns.computeSize(parent.element, axis, depth - 1));
  }

  const trackProp = axis === "width" ? "grid-column" as const : "grid-row" as const;
  nb.css(trackProp);

  nb.describe(`Grid item \u2014 ${axis} determined by the grid track it occupies`)
    .calc(fns.borderBoxCalc(nb.proxy, axis));
}
