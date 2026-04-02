/**
 * Block layout analyzer.
 *
 * Implements sizing for block-level elements in normal flow.
 *
 * Spec references:
 * - CSS2 §10.3.3  Block-level, non-replaced elements in normal flow
 *   https://www.w3.org/TR/CSS2/visudet.html#blockwidth
 *   "If 'width' is 'auto', … width = containing block width − margins − border − padding"
 *
 * - CSS2 §8.3.1  Collapsing margins (noted but not yet modelled)
 *   https://www.w3.org/TR/CSS2/box.html#collapsing-margins
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import type { LayoutContext } from "../types";
import { px, round } from "../utils";

/**
 * Block-fill: auto-width block element fills the containing block's
 * content area minus its own margins.
 *
 * CSS2 §10.3.3: "margin-left + border-left-width + padding-left + width
 * + padding-right + border-right-width + margin-right = width of containing block"
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
  const result = round(contentAreaNode.result - mStart - mEnd);

  return b.finish({ kind: "block-fill", element: el, axis, result,
    inputs: { containingBlockContent: contentAreaNode },
    literals: { marginStart: mStart, marginEnd: mEnd },
    expr: `${contentAreaNode.result}px \u2212 ${round(mStart + mEnd)}px margins = ${result}px`,
    cssProperties: { [axis]: "auto", [mStartProp]: s.getPropertyValue(mStartProp), [mEndProp]: s.getPropertyValue(mEndProp) } });
}

/**
 * Content area of a container: border-box minus padding and border.
 *
 * CSS2 §8.1: The content edge surrounds the content area, whose size
 * depends on the element's width/height minus padding and border.
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
  const result = round(borderBoxNode.result - total);

  return b.finish({ kind: "content-area", element: container, axis, result,
    inputs: { borderBox: borderBoxNode },
    literals: { paddingBorder: round(total) },
    expr: `${borderBoxNode.result}px \u2212 ${round(total)}px padding+border = ${result}px`,
    cssProperties: {} });
}
