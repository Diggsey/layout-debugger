/**
 * DAG builder — orchestrates layout computation for any element.
 *
 * Entry point: buildDag(el) → DagResult with width and height root nodes.
 *
 * Each node's result is derived from its CalcExpr tree via evaluate().
 * The analyzers build CalcExprs instead of doing arithmetic directly,
 * ensuring computation and presentation can never diverge.
 *
 * Spec references (cross-cutting):
 * - CSS2 §10.2   Content width — the 'width' property
 * - CSS2 §10.5   Content height — the 'height' property
 * - CSS2 §10.4   Minimum and maximum widths
 * - CSS2 §10.7   Minimum and maximum heights
 * - CSS Sizing 3 §4  Intrinsic Size Determination
 */
import type { LayoutNode, DagResult, Axis, NodeKind, SizeFns, CalcExpr } from "./dag";
import { DagBuilder, evaluate, ref, val, add, cmax, cmin } from "./dag";
import { identifyContext } from "./context";
import { getExplicitSize } from "./sizing";
import { getSpecifiedIntrinsicKeyword } from "./analyzers/properties";
import { blockFill, containerContentArea } from "./analyzers/block";
import { flexItemMain, flexItemCross, determineFlexCrossKind } from "./analyzers/flex";
import { gridItem } from "./analyzers/grid";
import { positioned } from "./analyzers/positioned";
import { aspectRatio } from "./analyzers/aspect-ratio";
import {
  px,
  round,
  flexMainAxisProp,
  measureIntrinsicSize,
  isAuto,
} from "./utils";

export function buildDag(el: Element): DagResult {
  const b = new DagBuilder();
  return {
    element: el,
    width: computeSize(b, el, "width", 100),
    height: computeSize(b, el, "height", 100),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function make(
  b: DagBuilder, kind: NodeKind, el: Element, axis: Axis,
  description: string, calc: CalcExpr,
  inputs: LayoutNode["inputs"],
  cssProperties: LayoutNode["cssProperties"] = {},
): LayoutNode {
  const existing = b.get(kind, el, axis);
  if (existing) return existing;
  return b.finish({ kind, element: el, axis, result: round(evaluate(calc)), description, calc, inputs, cssProperties });
}

function measured(b: DagBuilder, el: Element, axis: Axis, kind: NodeKind): LayoutNode {
  const existing = b.get(kind, el, axis);
  if (existing) return existing;
  const rect = el.getBoundingClientRect();
  const size = round(axis === "width" ? rect.width : rect.height);
  const desc = kind === "terminal" ? "Measured size (depth limit)" : `${kind} size`;
  return b.finish({ kind, element: el, axis, result: size, description: desc, calc: val(size), inputs: {}, cssProperties: {} });
}

// ---------------------------------------------------------------------------
// Determine the node kind for an element+axis (pure, no recursion)
// ---------------------------------------------------------------------------

/**
 * Classify how an element's size on a given axis is determined.
 *
 *   1. display: none / contents
 *   2. flex main axis (always governs, even with explicit size)
 *   3. aspect-ratio
 *   4. explicit size — fixed length or percentage
 *   5. intrinsic keyword
 *   6. layout-mode dispatch — flex cross, grid, positioned, block, inline
 */
function determineKind(el: Element, axis: Axis): NodeKind {
  if (el === document.documentElement) return "viewport";

  const s = getComputedStyle(el);
  if (s.display === "none") return "display-none";
  if (s.display === "contents") return "display-contents";

  const parent = el.parentElement;
  if (parent && s.position !== "absolute" && s.position !== "fixed") {
    const parentDisplay = getComputedStyle(parent).display;
    if (parentDisplay === "flex" || parentDisplay === "inline-flex") {
      const direction = getComputedStyle(parent).flexDirection;
      if (axis === flexMainAxisProp(direction)) return "flex-item-main";
    }
  }

  const ar = s.aspectRatio;
  if (ar && ar !== "auto") {
    const match = ar.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
    if (match) {
      const explicit = getExplicitSize(el, axis);
      const otherAxis: Axis = axis === "width" ? "height" : "width";
      const otherExplicit = getExplicitSize(el, otherAxis);
      if (!explicit && otherExplicit) return "aspect-ratio";
    }
  }

  const explicit = getExplicitSize(el, axis);
  if (explicit) return explicit.kind === "percentage" ? "percentage" : "explicit";

  const intrinsic = getSpecifiedIntrinsicKeyword(el, axis);
  if (intrinsic) return "intrinsic";

  const ctx = identifyContext(el);

  if (ctx.mode === "flex") {
    return determineFlexCrossKind(el, axis, ctx);
  }
  if (ctx.mode === "grid") return "grid-item";
  if (ctx.mode === "positioned") {
    const startProp = axis === "width" ? "left" : "top";
    const endProp = axis === "width" ? "right" : "bottom";
    return !isAuto(s.getPropertyValue(startProp)) && !isAuto(s.getPropertyValue(endProp))
      ? "positioned-offset" : "positioned-shrink-to-fit";
  }
  if (ctx.mode === "table-cell") return "table-cell";
  if (ctx.mode === "inline-block" || ctx.mode === "inline") return "content-kind" as NodeKind;

  const isFloat = ctx.float !== "none";
  const fillsAvailable = axis === ctx.inlineAxis && !isFloat;
  return fillsAvailable ? "block-fill" : "content-kind" as NodeKind;
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

function computeSize(b: DagBuilder, el: Element, axis: Axis, depth: number): LayoutNode {
  if (depth <= 0) return measured(b, el, axis, "terminal");

  const kind = determineKind(el, axis);

  const cached = b.get(kind, el, axis);
  if (cached) return cached;

  if (kind === ("content-kind" as NodeKind)) {
    const s = getComputedStyle(el);
    const isFlex = s.display === "flex" || s.display === "inline-flex";
    const isFlexMain = isFlex && axis === flexMainAxisProp(s.flexDirection);
    const actualKind: NodeKind = (isFlex && !isFlexMain) ? "content-max" : "content-sum";
    const cachedContent = b.get(actualKind, el, axis);
    if (cachedContent) return cachedContent;
    if (b.isBuilding(actualKind, el, axis)) return measured(b, el, axis, "terminal");
    return contentSize(b, el, axis, depth);
  }

  if (b.isBuilding(kind, el, axis)) return measured(b, el, axis, "terminal");

  const fns = buildSizeFns(b);
  const ctx = () => identifyContext(el);

  switch (kind) {
    case "viewport": return measured(b, el, axis, "viewport");
    case "display-none":
      return make(b, "display-none", el, axis,
        "Element is hidden (display: none)", val(0),
        {}, { display: "none" });
    case "display-contents":
      return make(b, "display-contents", el, axis,
        "Element has no box (display: contents)", val(0),
        {}, { display: "contents" });
    case "aspect-ratio": {
      const node = aspectRatio(fns, b, el, axis, ctx(), depth);
      return node ? maybeClamp(b, el, axis, node) : measured(b, el, axis, "terminal");
    }
    case "percentage": {
      const c = ctx();
      const info = getExplicitSize(el, axis)!;
      const rect = el.getBoundingClientRect();
      const size = round(axis === "width" ? rect.width : rect.height);
      const cbNode = computeSize(b, c.containingBlock, axis, depth - 1);
      const node = make(b, "percentage", el, axis,
        `${axis} is a percentage of the containing block`,
        val(size, `${(info as any).specifiedValue} of ${cbNode.result}px`),
        { containingBlock: cbNode },
        { [axis]: (info as any).specifiedValue, "box-sizing": getComputedStyle(el).boxSizing });
      return maybeClamp(b, el, axis, node);
    }
    case "explicit": {
      const s = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const size = round(axis === "width" ? rect.width : rect.height);
      const node = make(b, "explicit", el, axis,
        `${axis} is set explicitly in CSS`,
        val(size, s.getPropertyValue(axis)),
        {}, { [axis]: s.getPropertyValue(axis), "box-sizing": s.boxSizing });
      return maybeClamp(b, el, axis, node);
    }
    case "intrinsic": {
      const rect = el.getBoundingClientRect();
      const size = round(axis === "width" ? rect.width : rect.height);
      const kw = getSpecifiedIntrinsicKeyword(el, axis)!;
      return make(b, "intrinsic", el, axis,
        `${axis} uses an intrinsic sizing keyword`,
        val(size, kw),
        {}, { [axis]: kw });
    }
    case "flex-item-main":
      return maybeClamp(b, el, axis, flexItemMain(fns, b, el, axis, ctx(), depth));
    case "flex-cross-stretch":
    case "flex-cross-content":
      return maybeClamp(b, el, axis, flexItemCross(fns, b, el, axis, ctx(), depth));
    case "grid-item":
      return maybeClamp(b, el, axis, gridItem(fns, b, el, axis, ctx(), depth));
    case "positioned-offset":
    case "positioned-shrink-to-fit":
      return maybeClamp(b, el, axis, positioned(fns, b, el, axis, ctx(), depth));
    case "table-cell": return measured(b, el, axis, "table-cell");
    case "block-fill":
      return maybeClamp(b, el, axis, blockFill(fns, b, el, axis, ctx(), depth));
    default: return measured(b, el, axis, "terminal");
  }
}

/** Build the SizeFns callback interface for a given DagBuilder. */
function buildSizeFns(b: DagBuilder): SizeFns {
  const fns: SizeFns = {
    computeSize: (el, axis, depth) => computeSize(b, el, axis, depth),
    computeIntrinsicSize: (el, axis, depth) => computeIntrinsicSize(b, el, axis, depth),
    contentSize: (el, axis, depth, intrinsic) => contentSize(b, el, axis, depth, intrinsic),
    containerContentArea: (container, axis, borderBoxNode) =>
      containerContentArea(fns, b, container, axis, borderBoxNode),
    make: (kind, el, axis, description, calc, inputs, cssProperties) =>
      make(b, kind, el, axis, description, calc, inputs, cssProperties),
    measured: (el, axis, kind) => measured(b, el, axis, kind),
  };
  return fns;
}

// ---------------------------------------------------------------------------
// Intrinsic (content-based) size
// ---------------------------------------------------------------------------

function computeIntrinsicSize(
  b: DagBuilder, el: Element, axis: Axis, depth: number,
): LayoutNode {
  if (depth <= 0) return measured(b, el, axis, "terminal");

  const existing = b.get("intrinsic-content", el, axis);
  if (existing) return existing;
  if (b.isBuilding("intrinsic-content", el, axis)) return measured(b, el, axis, "terminal");

  const explicit = getExplicitSize(el, axis);
  if (explicit) {
    return computeSize(b, el, axis, depth);
  }

  const s = getComputedStyle(el);
  const contentNode = contentSize(b, el, axis, depth, true);

  return make(b, "intrinsic-content", el, axis,
    `Intrinsic ${axis} from content (display: ${s.display})`,
    ref(contentNode),
    { content: contentNode },
    { display: s.display, [axis]: "auto" });
}

// ---------------------------------------------------------------------------
// Clamping (min/max constraints)
// ---------------------------------------------------------------------------

function maybeClamp(b: DagBuilder, el: Element, axis: Axis, input: LayoutNode): LayoutNode {
  const s = getComputedStyle(el);
  const minProp = axis === "width" ? "min-width" : "min-height";
  const maxProp = axis === "width" ? "max-width" : "max-height";
  const minVal = s.getPropertyValue(minProp);
  const maxVal = s.getPropertyValue(maxProp);

  const padBorder = s.boxSizing !== "border-box"
    ? (axis === "width"
      ? px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth)
      : px(s.paddingTop) + px(s.paddingBottom) + px(s.borderTopWidth) + px(s.borderBottomWidth))
    : 0;

  const minPx = minVal === "auto" || minVal === "0px" ? 0 : px(minVal) + padBorder;
  const maxPx = maxVal === "none" ? Infinity : px(maxVal) + padBorder;

  if (input.result >= minPx && (maxPx === Infinity || input.result <= maxPx)) return input;

  // Build the clamp CalcExpr
  let calc: CalcExpr;
  if (maxPx !== Infinity && input.result > maxPx) {
    calc = cmin(val(maxPx, maxProp), ref(input));
  } else {
    calc = cmax(val(minPx, minProp), ref(input));
  }

  return make(b, "clamped", el, axis,
    "Constrained by min/max",
    calc, { input },
    { [minProp]: minVal, [maxProp]: maxVal });
}

// ---------------------------------------------------------------------------
// Content size (shared by block, inline, flex cross, intrinsic)
// ---------------------------------------------------------------------------

function contentSize(
  b: DagBuilder, el: Element, axis: Axis, depth: number, intrinsic = false,
): LayoutNode {
  const s = getComputedStyle(el);
  const display = s.display;
  const size = intrinsic
    ? round(measureIntrinsicSize(el, axis))
    : round(axis === "width" ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);

  const isFlex = display === "flex" || display === "inline-flex";
  const isFlexMain = isFlex && axis === flexMainAxisProp(s.flexDirection);
  const mode: "sum" | "max" = isFlex && !isFlexMain ? "max" : "sum";
  const kind: NodeKind = mode === "sum" ? "content-sum" : "content-max";

  const existing = b.get(kind, el, axis);
  if (existing) return existing;
  b.begin(kind, el, axis);

  const isFlexCross = isFlex && !isFlexMain;

  const childNodes: LayoutNode[] = [];
  let i = 0;
  for (const child of Array.from(el.children)) {
    const cs = getComputedStyle(child);
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    if (cs.display === "none" || cs.display === "contents") continue;
    if (depth > 1) {
      const useIntrinsic = isFlexCross || intrinsic;
      const childNode = useIntrinsic
        ? computeIntrinsicSize(b, child, axis, depth - 1)
        : computeSize(b, child, axis, depth - 1);
      childNodes.push(childNode);
    }
    i++;
  }

  const gap = px(axis === "width" ? s.columnGap : s.rowGap);
  const totalGap = gap * Math.max(0, i - 1);

  // Build inputs map
  const inputs: LayoutNode["inputs"] = {};
  childNodes.forEach((n, idx) => { inputs[`child${idx}`] = n; });

  // Build CalcExpr
  let calc: CalcExpr;
  if (childNodes.length === 0) {
    // No child nodes (leaf or depth limit) — use measured size
    calc = val(size);
  } else {
    const childRefs = childNodes.map(n => ref(n));
    if (mode === "sum") {
      const args = [...childRefs];
      if (totalGap > 0) args.push(val(totalGap, "gaps"));
      calc = add(...args);
    } else {
      calc = cmax(...childRefs);
    }
  }

  const hasChildren = childNodes.length > 0;
  let description: string;
  if (mode === "sum") {
    description = hasChildren
      ? `${axis} is determined by stacking its children`
      : `${axis} is determined by its text/inline content`;
  } else {
    description = hasChildren
      ? `${axis} is determined by its tallest/widest child`
      : `${axis} is determined by its content`;
  }

  // For content nodes, the CalcExpr may not exactly match the measured size
  // (e.g. text content, margin collapsing). Use the measured size as result
  // but keep the CalcExpr for the explanation.
  return b.finish({ kind, element: el, axis, result: size,
    description, calc, inputs,
    cssProperties: { [axis]: "auto", overflow: s.overflow } });
}
