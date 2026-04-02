/**
 * Block layout analyzer.
 *
 * Spec references:
 * - CSS2 §10.3.3  Block-level, non-replaced elements in normal flow
 * - CSS2 §8.1     Box model content area
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import { evaluate, collectProperties, ref, prop, add, sub, cmax } from "../dag";
import type { LayoutContext } from "../types";
import { round } from "../utils";

/**
 * Block-fill: auto-width block fills containing block content area minus margins.
 */
export function blockFill(
  fns: SizeFns, b: DagBuilder, el: Element, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const existing = b.get("block-fill", el, axis);
  if (existing) return existing;
  b.begin("block-fill", el, axis);

  const cbNode = fns.computeSize(ctx.containingBlock, axis, depth - 1);
  const contentAreaNode = containerContentArea(fns, b, ctx.containingBlock, axis, cbNode);

  const [mStartName, mEndName] = axis === "width"
    ? ["margin-left", "margin-right"] : ["margin-top", "margin-bottom"];
  const pbProps = axis === "width"
    ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
    : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;

  // Floor by padding+border — CSS can't render negative content
  const calc = cmax(
    add(...pbProps.map(p => prop(el, p))),
    sub(ref(contentAreaNode), add(prop(el, mStartName), prop(el, mEndName))),
  );

  return b.finish({ kind: "block-fill", element: el, axis,
    result: round(evaluate(calc)),
    description: `Block element \u2014 ${axis} fills the available space in its parent`,
    calc,
    inputs: { containingBlockContent: contentAreaNode },
    cssProperties: { [axis]: "auto", ...collectProperties(calc) } });
}

/**
 * Content area of a container: border-box minus padding and border.
 */
export function containerContentArea(
  fns: SizeFns, b: DagBuilder, container: Element, axis: Axis,
  borderBoxNode: LayoutNode,
): LayoutNode {
  const existing = b.get("content-area", container, axis);
  if (existing) return existing;

  const pbProps = axis === "width"
    ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
    : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;

  const calc = sub(ref(borderBoxNode), add(...pbProps.map(p => prop(container, p))));

  return b.finish({ kind: "content-area", element: container, axis,
    result: round(evaluate(calc)),
    description: `Usable space inside element after subtracting padding and border`,
    calc,
    inputs: { borderBox: borderBoxNode },
    cssProperties: {} });
}
