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
import { DagBuilder, evaluate, collectProperties, ref, constant, prop, add, cmax, cmin } from "./dag";
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
  extraCssProperties: LayoutNode["cssProperties"] = {},
): LayoutNode {
  const existing = b.get(kind, el, axis);
  if (existing) return existing;
  // Auto-collect CSS properties from property() nodes in the CalcExpr,
  // merged with any explicitly-passed descriptive properties (display, position, etc.)
  const cssProperties = { ...collectProperties(calc), ...extraCssProperties };
  return b.finish({ kind, element: el, axis, result: round(evaluate(calc)), description, calc, inputs, cssProperties });
}

function measured(b: DagBuilder, el: Element, axis: Axis, kind: NodeKind, description?: string): LayoutNode {
  const existing = b.get(kind, el, axis);
  if (existing) return existing;
  const desc = description ?? `Size of the browser ${kind === "viewport" ? "viewport" : kind}`;
  // Measured nodes read their size from the element's own CSS property
  const calc = borderBoxCalc(el, axis);
  return b.finish({ kind, element: el, axis, result: round(evaluate(calc)), description: desc, calc, inputs: {}, cssProperties: collectProperties(calc) });
}

/** Build a CalcExpr for an element's border-box size from its CSS properties. */
function borderBoxCalc(el: Element, axis: Axis): CalcExpr {
  const s = getComputedStyle(el);
  if (s.boxSizing === "border-box") {
    return prop(el, axis);
  }
  // content-box: border-box = width + padding + border
  if (axis === "width") {
    return add(prop(el, "width"), prop(el, "padding-left"), prop(el, "padding-right"),
      prop(el, "border-left-width"), prop(el, "border-right-width"));
  }
  return add(prop(el, "height"), prop(el, "padding-top"), prop(el, "padding-bottom"),
    prop(el, "border-top-width"), prop(el, "border-bottom-width"));
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
  if (depth <= 0) return measured(b, el, axis, "terminal", "Measured size (computation depth limit reached)");

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
    if (b.isBuilding(actualKind, el, axis)) return measured(b, el, axis, "terminal", "Measured size (content depends on this element\u2019s own size)");
    return contentSize(b, el, axis, depth);
  }

  if (b.isBuilding(kind, el, axis)) return measured(b, el, axis, "terminal", "Measured size (content depends on this element\u2019s own size)");

  const fns = buildSizeFns(b);
  const ctx = () => identifyContext(el);

  switch (kind) {
    case "viewport": return measured(b, el, axis, "viewport");
    case "display-none":
      return make(b, "display-none", el, axis,
        "Element is hidden (display: none)", constant(0),
        {}, { display: "none" });
    case "display-contents":
      return make(b, "display-contents", el, axis,
        "Element has no box (display: contents)", constant(0),
        {}, { display: "contents" });
    case "aspect-ratio": {
      const node = aspectRatio(fns, b, el, axis, ctx(), depth);
      return node ? maybeClamp(b, el, axis, node) : measured(b, el, axis, "terminal");
    }
    case "percentage": {
      const c = ctx();
      const cbNode = computeSize(b, c.containingBlock, axis, depth - 1);
      const node = make(b, "percentage", el, axis,
        `${axis} is a percentage of the containing block`,
        borderBoxCalc(el, axis),
        { containingBlock: cbNode });
      return maybeClamp(b, el, axis, node);
    }
    case "explicit": {
      const node = make(b, "explicit", el, axis,
        `${axis} is set explicitly in CSS`,
        borderBoxCalc(el, axis), {});
      return maybeClamp(b, el, axis, node);
    }
    case "intrinsic": {
      return make(b, "intrinsic", el, axis,
        `${axis} uses an intrinsic sizing keyword`,
        borderBoxCalc(el, axis), {});
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
    borderBoxCalc,
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
  if (depth <= 0) return measured(b, el, axis, "terminal", "Measured size (computation depth limit reached)");

  const existing = b.get("intrinsic-content", el, axis);
  if (existing) return existing;
  if (b.isBuilding("intrinsic-content", el, axis)) return measured(b, el, axis, "terminal", "Measured size (circular dependency)");

  // If the element has an explicit size, that IS the intrinsic size.
  // Return it directly — don't go through computeSize which may enter
  // the flex algorithm and cycle back to a container that's still building.
  const explicit = getExplicitSize(el, axis);
  if (explicit) {
    return make(b, "intrinsic-content", el, axis,
      `Intrinsic ${axis}: set explicitly in CSS`,
      borderBoxCalc(el, axis), {});
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

/** Build a CalcExpr for a min/max constraint value, converting to border-box if needed. */
function constraintCalc(el: Element, axis: Axis, constraintProp: string): CalcExpr {
  const s = getComputedStyle(el);
  const base = prop(el, constraintProp);
  if (s.boxSizing === "border-box") return base;
  // content-box: add padding+border to convert to border-box
  if (axis === "width") {
    return add(base, prop(el, "padding-left"), prop(el, "padding-right"),
      prop(el, "border-left-width"), prop(el, "border-right-width"));
  }
  return add(base, prop(el, "padding-top"), prop(el, "padding-bottom"),
    prop(el, "border-top-width"), prop(el, "border-bottom-width"));
}

function maybeClamp(b: DagBuilder, el: Element, axis: Axis, input: LayoutNode): LayoutNode {
  const s = getComputedStyle(el);
  const minPropName = axis === "width" ? "min-width" : "min-height";
  const maxPropName = axis === "width" ? "max-width" : "max-height";
  const minVal = s.getPropertyValue(minPropName);
  const maxVal = s.getPropertyValue(maxPropName);

  const padBorder = s.boxSizing !== "border-box"
    ? (axis === "width"
      ? px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth)
      : px(s.paddingTop) + px(s.paddingBottom) + px(s.borderTopWidth) + px(s.borderBottomWidth))
    : 0;

  const minPx = minVal === "auto" || minVal === "0px" ? 0 : px(minVal) + padBorder;
  const maxPx = maxVal === "none" ? Infinity : px(maxVal) + padBorder;

  if (input.result >= minPx && (maxPx === Infinity || input.result <= maxPx)) return input;

  let calc: CalcExpr;
  if (maxPx !== Infinity && input.result > maxPx) {
    calc = cmin(constraintCalc(el, axis, maxPropName), ref(input));
  } else {
    calc = cmax(constraintCalc(el, axis, minPropName), ref(input));
  }

  return make(b, "clamped", el, axis,
    "Constrained by min/max",
    calc, { input });
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
  const isGrid = display === "grid" || display === "inline-grid";

  // Use intrinsic sizes for children when the parent's content size
  // depends on them but they would cycle back (flex cross-axis children
  // stretch to parent, grid items size from container). Also when the
  // intrinsic flag is set (computing pre-stretch/pre-flex sizes).
  const useIntrinsic = isFlexCross || isGrid || intrinsic;

  const childNodes: LayoutNode[] = [];
  let i = 0;
  for (const child of Array.from(el.children)) {
    const cs = getComputedStyle(child);
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    if (cs.display === "none" || cs.display === "contents") continue;
    if (depth > 1) {
      const childNode = useIntrinsic
        ? computeIntrinsicSize(b, child, axis, depth - 1)
        : computeSize(b, child, axis, depth - 1);
      childNodes.push(childNode);
    }
    i++;
  }

  const gap = px(axis === "width" ? s.columnGap : s.rowGap);

  // Build inputs map
  const inputs: LayoutNode["inputs"] = {};
  childNodes.forEach((n, idx) => { inputs[`child${idx}`] = n; });

  // Build CalcExpr
  let calc: CalcExpr;
  const gapPropName = axis === "width" ? "column-gap" : "row-gap";
  if (childNodes.length === 0) {
    // No child nodes (leaf or depth limit) — use measured size from CSS property
    calc = borderBoxCalc(el, axis);
  } else {
    const childRefs = childNodes.map(n => ref(n));
    if (mode === "sum") {
      // Interleave gap property refs between children: child0 + gap + child1 + gap + child2
      const args: CalcExpr[] = [childRefs[0]];
      for (let j = 1; j < childRefs.length; j++) {
        if (gap > 0) args.push(prop(el, gapPropName));
        args.push(childRefs[j]);
      }
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
