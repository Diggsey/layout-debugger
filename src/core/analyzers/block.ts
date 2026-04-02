/**
 * Block layout analyzer.
 *
 * Spec references:
 * - CSS2 §10.3.3  Block-level, non-replaced elements in normal flow
 * - CSS2 §8.1     Box model content area
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import { evaluate, ref, val, sub, cmax } from "../dag";
import type { LayoutContext } from "../types";
import { px, round } from "../utils";

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

  const s = getComputedStyle(el);
  const cbNode = fns.computeSize(ctx.containingBlock, axis, depth - 1);
  const contentAreaNode = containerContentArea(fns, b, ctx.containingBlock, axis, cbNode);

  const mStartProp = axis === "width" ? "margin-left" : "margin-top";
  const mEndProp = axis === "width" ? "margin-right" : "margin-bottom";
  const mStart = px(s.getPropertyValue(mStartProp));
  const mEnd = px(s.getPropertyValue(mEndProp));

  const pb = axis === "width"
    ? px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth)
    : px(s.paddingTop) + px(s.paddingBottom) + px(s.borderTopWidth) + px(s.borderBottomWidth);

  // Floor by padding+border — CSS can't render negative content
  const calc = cmax(
    val(pb, "padding+border"),
    sub(ref(contentAreaNode), val(mStart + mEnd, "margins")),
  );

  return b.finish({ kind: "block-fill", element: el, axis,
    result: round(evaluate(calc)),
    description: `Block element \u2014 ${axis} fills the available space in its parent`,
    calc,
    inputs: { containingBlockContent: contentAreaNode },
    cssProperties: { [axis]: "auto", [mStartProp]: s.getPropertyValue(mStartProp), [mEndProp]: s.getPropertyValue(mEndProp) } });
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

  const cs = getComputedStyle(container);
  const padBorderStart = axis === "width"
    ? px(cs.paddingLeft) + px(cs.borderLeftWidth)
    : px(cs.paddingTop) + px(cs.borderTopWidth);
  const padBorderEnd = axis === "width"
    ? px(cs.paddingRight) + px(cs.borderRightWidth)
    : px(cs.paddingBottom) + px(cs.borderBottomWidth);
  const total = padBorderStart + padBorderEnd;

  const calc = sub(ref(borderBoxNode), val(total, "padding+border"));

  return b.finish({ kind: "content-area", element: container, axis,
    result: round(evaluate(calc)),
    description: `Usable space inside element after subtracting padding and border`,
    calc,
    inputs: { borderBox: borderBoxNode },
    cssProperties: {} });
}
