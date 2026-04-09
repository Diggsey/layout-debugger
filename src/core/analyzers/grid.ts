/**
 * Grid layout analyzer.
 */
import type { Axis, NodeBuilder } from "../dag";

export function gridItem(
  nb: NodeBuilder, axis: Axis,
): void {
  const parent = nb.proxy.getLayoutParent();

  if (parent.getExplicitSize(axis)) {
    nb.input("container", nb.computeSize(parent.element, axis));
  }

  const trackProp = axis === "width" ? "grid-column" as const : "grid-row" as const;
  nb.css(trackProp);

  nb.describe(`Grid item \u2014 ${axis} determined by the grid track it occupies`)
    .calc(nb.borderBoxCalc(nb.proxy, axis));
}
