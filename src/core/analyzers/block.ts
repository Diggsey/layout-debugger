/**
 * Block layout analyzer.
 *
 * Spec references:
 * - CSS2 §10.3.3  Block-level, non-replaced elements in normal flow
 * - CSS2 §8.1     Box model content area
 */
import type { Axis, LayoutNode, NodeKind, NodeBuilder } from "../dag";
import { ref, add, sub, cmax } from "../dag";

/**
 * Block-fill: auto-width block fills containing block content area minus margins.
 */
export function blockFill(
  nb: NodeBuilder, axis: Axis,
): void {
  const cb = nb.proxy.getContainingBlock();
  const cbNode = nb.computeSize(cb.element, axis);
  const contentAreaNode = containerContentArea(nb, cb.element, axis, cbNode);

  const [mStartName, mEndName] = axis === "width"
    ? ["margin-left", "margin-right"] as const : ["margin-top", "margin-bottom"] as const;
  const pbProps = axis === "width"
    ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
    : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;

  nb.describe(`Block element \u2014 ${axis} fills the available space in its parent`)
    .calc(cmax(
      add(...pbProps.map(p => nb.prop(p))),
      sub(ref(contentAreaNode), add(nb.prop(mStartName), nb.prop(mEndName))),
    ))
    .input("containingBlockContent", contentAreaNode);
}

/**
 * Content area of a container: border-box minus padding and border.
 */
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
