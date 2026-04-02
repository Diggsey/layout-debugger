/**
 * DAG builder — orchestrates layout computation for any element.
 *
 * Entry point: buildDag(el) → DagResult with width and height root nodes.
 *
 * The builder dispatches to per-display-mode analyzers in src/core/analyzers/.
 * Each analyzer receives a SizeFns callback interface so it can recurse
 * into this module without circular imports.
 *
 * Spec references (cross-cutting):
 * - CSS2 §10.2   Content width — the 'width' property
 *   https://www.w3.org/TR/CSS2/visudet.html#the-width-property
 * - CSS2 §10.5   Content height — the 'height' property
 *   https://www.w3.org/TR/CSS2/visudet.html#the-height-property
 * - CSS2 §10.4   Minimum and maximum widths: 'min-width' and 'max-width'
 *   https://www.w3.org/TR/CSS2/visudet.html#min-max-widths
 * - CSS2 §10.7   Minimum and maximum heights: 'min-height' and 'max-height'
 *   https://www.w3.org/TR/CSS2/visudet.html#min-max-heights
 * - CSS Sizing 3 §4  Intrinsic Size Determination
 *   https://www.w3.org/TR/css-sizing-3/#intrinsic
 */
import type { LayoutNode, DagResult, Axis, NodeKind, SizeFns } from "./dag";
import { DagBuilder } from "./dag";
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
    width: computeSize(b, el, "width", 15),
    height: computeSize(b, el, "height", 15),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function make(
  b: DagBuilder, kind: NodeKind, el: Element, axis: Axis,
  result: number, inputs: LayoutNode["inputs"], literals: LayoutNode["literals"],
  expr: string, cssProperties: LayoutNode["cssProperties"] = {},
): LayoutNode {
  const existing = b.get(kind, el, axis);
  if (existing) return existing;
  return b.finish({ kind, element: el, axis, result, inputs, literals, expr, cssProperties });
}

function measured(b: DagBuilder, el: Element, axis: Axis, kind: NodeKind): LayoutNode {
  const existing = b.get(kind, el, axis);
  if (existing) return existing;
  const rect = el.getBoundingClientRect();
  const size = round(axis === "width" ? rect.width : rect.height);
  return b.finish({ kind, element: el, axis, result: size, inputs: {}, literals: {}, expr: `${size}px`, cssProperties: {} });
}

// ---------------------------------------------------------------------------
// Determine the node kind for an element+axis (pure, no recursion)
// ---------------------------------------------------------------------------

/**
 * Classify how an element's size on a given axis is determined.
 *
 * This is a pure function (no recursion, no side effects) that reads
 * computed styles and returns a NodeKind. The ordering of checks mirrors
 * the CSS cascade of sizing rules:
 *   1. display: none / contents (CSS Display 3 §2.7, §2.8)
 *   2. flex main axis (CSS Flexbox §9 — always governs, even with explicit size)
 *   3. aspect-ratio (CSS Sizing 4 §5.1)
 *   4. explicit size — fixed length or percentage (CSS2 §10.2)
 *   5. intrinsic keyword — min-content, max-content, fit-content (CSS Sizing 3 §4)
 *   6. layout-mode dispatch — flex cross, grid, positioned, block, inline
 */
function determineKind(el: Element, axis: Axis): NodeKind {
  if (el === document.documentElement) return "viewport";

  const s = getComputedStyle(el);
  if (s.display === "none") return "display-none";
  if (s.display === "contents") return "display-contents";

  // CSS Flexbox §9: flex items on the main axis are ALWAYS sized by the
  // flex algorithm — explicit width/height feeds into flex-basis resolution
  // but doesn't determine the final size. Must check before explicit/percentage.
  const parent = el.parentElement;
  if (parent && s.position !== "absolute" && s.position !== "fixed") {
    const parentDisplay = getComputedStyle(parent).display;
    if (parentDisplay === "flex" || parentDisplay === "inline-flex") {
      const direction = getComputedStyle(parent).flexDirection;
      if (axis === flexMainAxisProp(direction)) return "flex-item-main";
    }
  }

  // CSS Sizing 4 §5.1: aspect-ratio transfers size from one axis to the other
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

  // CSS2 §10.2/10.5: explicit width/height property
  const explicit = getExplicitSize(el, axis);
  if (explicit) return explicit.kind === "percentage" ? "percentage" : "explicit";

  // CSS Sizing 3 §4: intrinsic sizing keywords
  const intrinsic = getSpecifiedIntrinsicKeyword(el, axis);
  if (intrinsic) return "intrinsic";

  const ctx = identifyContext(el);

  // CSS Flexbox §9.4: flex item cross-axis sizing
  if (ctx.mode === "flex") {
    return determineFlexCrossKind(el, axis, ctx);
  }
  // CSS Grid §11.1: grid item sizing
  if (ctx.mode === "grid") return "grid-item";
  // CSS2 §10.3.7/10.6.4: positioned element sizing
  if (ctx.mode === "positioned") {
    const startProp = axis === "width" ? "left" : "top";
    const endProp = axis === "width" ? "right" : "bottom";
    return !isAuto(s.getPropertyValue(startProp)) && !isAuto(s.getPropertyValue(endProp))
      ? "positioned-offset" : "positioned-shrink-to-fit";
  }
  if (ctx.mode === "table-cell") return "table-cell";
  if (ctx.mode === "inline-block" || ctx.mode === "inline") return "content-kind" as NodeKind;

  // CSS2 §10.3.3: block-level auto width fills containing block
  const isFloat = ctx.float !== "none";
  const fillsAvailable = axis === ctx.inlineAxis && !isFloat;
  return fillsAvailable ? "block-fill" : "content-kind" as NodeKind;
}

// "content-kind" is a placeholder — the actual kind depends on the display type
// (content-sum or content-max). Resolved in computeSize.

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

/**
 * Compute the size of an element on a given axis, returning a LayoutNode.
 *
 * This is the main recursive entry point. It determines the node kind,
 * checks the cache/recursion guard, then dispatches to the appropriate
 * per-display-mode analyzer.
 */
function computeSize(b: DagBuilder, el: Element, axis: Axis, depth: number): LayoutNode {
  if (depth <= 0) return measured(b, el, axis, "terminal");

  const kind = determineKind(el, axis);

  const cached = b.get(kind, el, axis);
  if (cached) return cached;

  // Content-kind placeholder: resolve to content-sum or content-max
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
    case "display-none": return make(b, "display-none", el, axis, 0, {}, {}, "display: none → 0", { display: "none" });
    case "display-contents": return make(b, "display-contents", el, axis, 0, {}, {}, "display: contents → 0", { display: "contents" });
    case "aspect-ratio": {
      const node = aspectRatio(fns, b, el, axis, ctx(), depth);
      return node ? maybeClamp(b, el, axis, node) : measured(b, el, axis, "terminal");
    }
    case "percentage": {
      const c = ctx();
      const info = getExplicitSize(el, axis)!;
      // getExplicitSize returns content-box px; use border-box for the result
      const rect = el.getBoundingClientRect();
      const size = round(axis === "width" ? rect.width : rect.height);
      const cbNode = computeSize(b, c.containingBlock, axis, depth - 1);
      const node = make(b, "percentage", el, axis, size,
        { containingBlock: cbNode }, {},
        `${cbNode.result}px × ${(info as any).specifiedValue} = ${size}px`,
        { [axis]: (info as any).specifiedValue, "box-sizing": getComputedStyle(el).boxSizing });
      return maybeClamp(b, el, axis, node);
    }
    case "explicit": {
      const s = getComputedStyle(el);
      // getComputedStyle returns content-box px; use border-box for the result
      const rect = el.getBoundingClientRect();
      const size = round(axis === "width" ? rect.width : rect.height);
      const node = make(b, "explicit", el, axis, size, {}, {},
        `${s.getPropertyValue(axis)} → ${size}px`,
        { [axis]: s.getPropertyValue(axis), "box-sizing": s.boxSizing });
      return maybeClamp(b, el, axis, node);
    }
    case "intrinsic": {
      const rect = el.getBoundingClientRect();
      const size = round(axis === "width" ? rect.width : rect.height);
      const kw = getSpecifiedIntrinsicKeyword(el, axis)!;
      return make(b, "intrinsic", el, axis, size, {}, {}, `${kw} → ${size}px`, { [axis]: kw });
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
    make: (kind, el, axis, result, inputs, literals, expr, cssProperties) =>
      make(b, kind, el, axis, result, inputs, literals, expr, cssProperties),
    measured: (el, axis, kind) => measured(b, el, axis, kind),
  };
  return fns;
}

// ---------------------------------------------------------------------------
// Intrinsic (content-based) size
// ---------------------------------------------------------------------------

/**
 * Compute an element's intrinsic size — what it would be based purely
 * on its content, ignoring extrinsic constraints (stretch, fill, percentage).
 *
 * CSS Sizing 3 §4: Intrinsic sizes are content-based. Used by:
 * - Flex cross-axis algorithm (§9.4 step 7–8): container cross size
 *   is the max of its items' intrinsic cross sizes before stretching
 * - Shrink-to-fit calculations
 * - Any context where we need the "natural" size
 *
 * Returns an "intrinsic-content" node wrapping the content computation,
 * or falls through to explicit/computed size if the element has one
 * (an explicit size IS the intrinsic size in that case).
 */
function computeIntrinsicSize(
  b: DagBuilder, el: Element, axis: Axis, depth: number,
): LayoutNode {
  if (depth <= 0) return measured(b, el, axis, "terminal");

  const existing = b.get("intrinsic-content", el, axis);
  if (existing) return existing;
  if (b.isBuilding("intrinsic-content", el, axis)) return measured(b, el, axis, "terminal");

  // If the element has an explicit size, that IS its intrinsic size
  const explicit = getExplicitSize(el, axis);
  if (explicit) {
    return computeSize(b, el, axis, depth);
  }

  // Content-based size with intrinsic=true so descendants also use
  // intrinsic sizes (preventing stretch/fill cycles)
  const s = getComputedStyle(el);
  const contentNode = contentSize(b, el, axis, depth, true);

  return make(b, "intrinsic-content", el, axis, contentNode.result,
    { content: contentNode }, {},
    `intrinsic ${axis}: ${contentNode.result}px (from content)`,
    { display: s.display, [axis]: "auto" });
}

// ---------------------------------------------------------------------------
// Clamping (min/max constraints)
// ---------------------------------------------------------------------------

/**
 * Apply min-width/max-width (or min-height/max-height) constraints.
 *
 * CSS2 §10.4 / §10.7: The used value of width/height is constrained:
 *   used = max(min, min(max, computed))
 * Returns the original node unchanged if no clamping occurs.
 */
function maybeClamp(b: DagBuilder, el: Element, axis: Axis, input: LayoutNode): LayoutNode {
  const s = getComputedStyle(el);
  const minProp = axis === "width" ? "min-width" : "min-height";
  const maxProp = axis === "width" ? "max-width" : "max-height";
  const minVal = s.getPropertyValue(minProp);
  const maxVal = s.getPropertyValue(maxProp);

  // CSS min/max values are interpreted per box-sizing. getComputedStyle
  // returns the resolved value which, for content-box, is the content
  // dimension. Convert to border-box since input.result is border-box.
  const padBorder = s.boxSizing !== "border-box"
    ? (axis === "width"
      ? px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth)
      : px(s.paddingTop) + px(s.paddingBottom) + px(s.borderTopWidth) + px(s.borderBottomWidth))
    : 0;

  const minPx = minVal === "auto" || minVal === "0px" ? 0 : px(minVal) + padBorder;
  const maxPx = maxVal === "none" ? Infinity : px(maxVal) + padBorder;

  if (input.result >= minPx && (maxPx === Infinity || input.result <= maxPx)) return input;

  const clamped = round(Math.max(minPx, Math.min(maxPx === Infinity ? Infinity : maxPx, input.result)));
  return make(b, "clamped", el, axis, clamped,
    { input }, { min: minPx, max: maxPx === Infinity ? Infinity : maxPx },
    `clamp(${minPx}, ${input.result}px, ${maxPx === Infinity ? "\u221e" : maxPx}) = ${clamped}px`,
    { [minProp]: minVal, [maxProp]: maxVal });
}

// ---------------------------------------------------------------------------
// Content size (shared by block, inline, flex cross, intrinsic)
// ---------------------------------------------------------------------------

/**
 * Compute the content-driven size of an element on a given axis.
 *
 * Determines the kind (content-sum or content-max) based on display mode:
 * - Flex container cross-axis → content-max (tallest child)
 * - Everything else → content-sum (stacked children)
 *
 * When `intrinsic` is true, all children use computeIntrinsicSize instead
 * of computeSize, preventing cycles with stretch/fill.
 *
 * CSS Sizing 3 §4.1: max-content size of a box is the size it would be
 * if all children were at their max-content sizes.
 *
 * CSS Flexbox §9.4 step 7–8: For flex cross-axis, the container's cross
 * size = max of items' hypothetical (intrinsic) cross sizes.
 */
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

  // For flex cross-axis, use intrinsic sizes to avoid the stretch/fill cycle
  // (CSS Flexbox §9.4 step 7: determine hypothetical cross size)
  const isFlexCross = isFlex && !isFlexMain;

  const childInputs: LayoutNode["inputs"] = {};
  const childVals: number[] = [];
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
      childInputs[`child${i}`] = childNode;
      childVals.push(childNode.result);
    } else {
      const cr = child.getBoundingClientRect();
      childVals.push(round(axis === "width" ? cr.width : cr.height));
    }
    i++;
  }

  const gap = px(axis === "width" ? s.columnGap : s.rowGap);
  const totalGap = gap * Math.max(0, childVals.length - 1);
  const childPart = childVals.map((v) => `${v}px`).join(mode === "sum" ? " + " : ", ");
  const gapPart = totalGap > 0 ? ` + ${totalGap}px gaps` : "";

  return b.finish({ kind, element: el, axis, result: size,
    inputs: childInputs,
    literals: { gap, totalGap },
    expr: `${mode}(${childPart})${gapPart} = ${size}px`,
    cssProperties: { [axis]: "auto", overflow: s.overflow } });
}
