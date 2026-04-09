/**
 * Shared box model helpers: border-box calculation and container content area.
 */
import type { Axis, NodeKind, LayoutNode, CalcExpr } from "./types";
import type { NodeBuilder } from "./node-builder";
import { ElementProxy } from "./element-proxy";
import { prop, add, ref, sub } from "./calc";

/** Build a CalcExpr for an element's border-box size from its CSS properties. */
export function borderBoxCalc(proxy: ElementProxy, axis: Axis): CalcExpr {
  if (proxy.readProperty("box-sizing") === "border-box") {
    return prop(proxy, axis);
  }
  if (axis === "width") {
    return add(prop(proxy, "width"), prop(proxy, "padding-left"), prop(proxy, "padding-right"),
      prop(proxy, "border-left-width"), prop(proxy, "border-right-width"));
  }
  return add(prop(proxy, "height"), prop(proxy, "padding-top"), prop(proxy, "padding-bottom"),
    prop(proxy, "border-top-width"), prop(proxy, "border-bottom-width"));
}

/** Content area of a container: border-box minus padding and border. */
export function containerContentArea(
  nb: NodeBuilder, container: Element, axis: Axis,
  borderBoxNode: LayoutNode,
): LayoutNode {
  const kind: NodeKind = `content-area:${axis}`;
  return nb.create(kind, container, (cnb) => {
    cnb.setMode("content-area");
    const pbProps = axis === "width"
      ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
      : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;

    cnb.describe("Usable space inside element after subtracting padding and border")
      .calc(sub(ref(borderBoxNode), add(...pbProps.map(p => cnb.prop(p)))))
      .input("borderBox", borderBoxNode);
  });
}
