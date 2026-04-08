/**
 * Block layout analyzer.
 *
 * Spec references:
 * - CSS2 §10.3.3  Block-level, non-replaced elements in normal flow
 * - CSS2 §8.1     Box model content area
 */
import type { Axis, LayoutNode, SizeFns, NodeBuilder } from "../dag";
import { ref, add, sub, cmax } from "../dag";
import type { LayoutContext } from "../types";

/**
 * Block-fill: auto-width block fills containing block content area minus margins.
 */
export function blockFill(
  fns: SizeFns, nb: NodeBuilder, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const el = nb.element;
  nb.setKind("block-fill");

  const cbNode = fns.computeSize(ctx.containingBlock, axis, depth - 1);
  const contentAreaNode = containerContentArea(fns, ctx.containingBlock, axis, cbNode);

  const [mStartName, mEndName] = axis === "width"
    ? ["margin-left", "margin-right"] : ["margin-top", "margin-bottom"];
  const pbProps = axis === "width"
    ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
    : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;

  // Floor by padding+border — CSS can't render negative content
  return nb
    .setCss(axis, "auto")
    .describe(`Block element \u2014 ${axis} fills the available space in its parent`)
    .calc(cmax(
      add(...pbProps.map(p => nb.prop(p))),
      sub(ref(contentAreaNode), add(nb.prop(mStartName), nb.prop(mEndName))),
    ))
    .input("containingBlockContent", contentAreaNode)
    .finish();
}

/**
 * Content area of a container: border-box minus padding and border.
 */
export function containerContentArea(
  fns: SizeFns, container: Element, axis: Axis, borderBoxNode: LayoutNode,
): LayoutNode {
  const nb = fns.begin("content-area", container, axis);
  if (!nb) return fns.get("content-area", container, axis)!;

  const pbProps = axis === "width"
    ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
    : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;

  return nb
    .describe("Usable space inside element after subtracting padding and border")
    .calc(sub(ref(borderBoxNode), add(...pbProps.map(p => nb.prop(p)))))
    .input("borderBox", borderBoxNode)
    .finish();
}
