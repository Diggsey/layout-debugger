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
import { DagBuilder, NodeBuilder, ref, constant, prop, add, cmax, cmin } from "./dag";
import { PX } from "./units";
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

/**
 * One-shot node creation via NodeBuilder. Returns existing if cached.
 * All CSS props in the CalcExpr are auto-collected by DagBuilder.finish().
 */
function make(b: DagBuilder, kind: NodeKind, el: Element, axis: Axis,
  description: string, calc: CalcExpr, inputs: LayoutNode["inputs"],
): NodeBuilder | undefined {
  const existing = b.get(kind, el, axis);
  if (existing) return undefined;
  return b.begin(kind, el, axis).describe(description).calc(calc).inputs(inputs);
}

function measured(b: DagBuilder, el: Element, axis: Axis, kind: NodeKind, description?: string): LayoutNode {
  const existing = b.get(kind, el, axis);
  if (existing) return existing;
  const desc = description ?? `Size of the browser ${kind === "viewport" ? "viewport" : kind}`;
  return b.begin(kind, el, axis).describe(desc).calc(borderBoxCalc(el, axis)).finish();
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
  let isGridItem = false;
  if (parent && s.position !== "absolute" && s.position !== "fixed") {
    const parentDisplay = getComputedStyle(parent).display;
    if (parentDisplay === "flex" || parentDisplay === "inline-flex") {
      const ps = getComputedStyle(parent);
      const direction = ps.flexDirection;
      if (axis === flexMainAxisProp(direction)) {
        // Single-line flex: use our flex algorithm
        if (ps.flexWrap === "nowrap") return "flex-item-main";
        // Multi-line flex (wrap): not implemented, fall through to explicit/content sizing
      }
    }
    if (parentDisplay === "grid" || parentDisplay === "inline-grid") {
      isGridItem = true;
    }
  }

  // Skip aspect-ratio for grid items (the grid algorithm governs their size).
  // Flex items CAN use aspect-ratio for their basis when flex-basis: auto.
  const ar = s.aspectRatio;
  if (!isGridItem && ar && ar !== "auto") {
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
    if (b.isBuilding(actualKind, el, axis)) {
      // Cycle: a child is trying to fill a parent whose content size depends
      // on this child. Fall back to intrinsic (content-based) sizing which
      // avoids the block-fill/stretch path that caused the cycle.
      return computeIntrinsicSize(b, el, axis, depth);
    }
    return contentSize(b, el, axis, depth);
  }

  if (b.isBuilding(kind, el, axis)) {
    // Same: cycle detected — use intrinsic size instead of terminal
    return computeIntrinsicSize(b, el, axis, depth);
  }

  const fns = buildSizeFns(b);
  const ctx = () => identifyContext(el);

  switch (kind) {
    case "viewport": return measured(b, el, axis, "viewport");
    case "display-none": {
      const nb = make(b, "display-none", el, axis,
        "Element is hidden (display: none)", constant(0, PX), {});
      if (!nb) return b.get("display-none", el, axis)!;
      nb.setCss("display", "none", "Element is hidden and has no size");
      return nb.finish();
    }
    case "display-contents": {
      const nb = make(b, "display-contents", el, axis,
        "Element has no box (display: contents)", constant(0, PX), {});
      if (!nb) return b.get("display-contents", el, axis)!;
      nb.setCss("display", "contents", "Element has no box — children participate in parent layout");
      return nb.finish();
    }
    case "aspect-ratio": {
      const node = aspectRatio(fns, b, el, axis, ctx(), depth);
      return node ? maybeClamp(b, el, axis, node) : measured(b, el, axis, "terminal");
    }
    case "percentage": {
      const c = ctx();
      const cbNode = computeSize(b, c.containingBlock, axis, depth - 1);
      const nb = make(b, "percentage", el, axis,
        `${axis} is a percentage of the containing block`,
        borderBoxCalc(el, axis), { containingBlock: cbNode });
      if (!nb) return b.get("percentage", el, axis)!;
      nb.css("box-sizing", "Determines whether padding/border are included");
      return maybeClamp(b, el, axis, nb.finish());
    }
    case "explicit": {
      const nb = make(b, "explicit", el, axis,
        `${axis} is set explicitly in CSS`,
        borderBoxCalc(el, axis), {});
      if (!nb) return b.get("explicit", el, axis)!;
      nb.css("box-sizing", "Determines whether padding/border are included");
      return maybeClamp(b, el, axis, nb.finish());
    }
    case "intrinsic": {
      const nb = make(b, "intrinsic", el, axis,
        `${axis} uses an intrinsic sizing keyword`,
        borderBoxCalc(el, axis), {});
      if (!nb) return b.get("intrinsic", el, axis)!;
      return nb.finish();
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
    measured: (el, axis, kind) => measured(b, el, axis, kind),
    begin: (kind, el, axis) => {
      const existing = b.get(kind, el, axis);
      if (existing) return undefined;
      return b.begin(kind, el, axis);
    },
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
    const nb = make(b, "intrinsic-content", el, axis,
      `Intrinsic ${axis}: set explicitly in CSS`,
      borderBoxCalc(el, axis), {});
    return nb ? nb.finish() : b.get("intrinsic-content", el, axis)!;
  }

  // If aspect-ratio can derive this axis from an explicit other axis, compute it.
  const arStyle = getComputedStyle(el);
  const arVal = arStyle.aspectRatio;
  if (arVal && arVal !== "auto" && arStyle.overflow !== "scroll" && arStyle.overflow !== "auto") {
    const otherAxis: Axis = axis === "width" ? "height" : "width";
    const otherExplicit = getExplicitSize(el, otherAxis);
    if (otherExplicit) {
      // Compute the other axis border-box, then derive this axis via ratio
      const otherBB = computeIntrinsicSize(b, el, otherAxis, depth);
      const arMatch = arVal.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
      if (arMatch) {
        const ratioW = parseFloat(arMatch[1]);
        const ratioH = arMatch[2] ? parseFloat(arMatch[2]) : 1;
        const ratio = ratioW / ratioH; // width / height
        const isBorderBox = arStyle.boxSizing === "border-box";

        let result: number;
        if (isBorderBox) {
          result = axis === "width" ? otherBB.result * ratio : otherBB.result / ratio;
        } else {
          // content-box: need to subtract other pb, apply ratio, add this pb
          const otherPbNames = otherAxis === "width"
            ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
            : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
          const thisPbNames = axis === "width"
            ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
            : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
          const otherPb = otherPbNames.reduce((s, p) => s + (parseFloat(arStyle.getPropertyValue(p)) || 0), 0);
          const thisPb = thisPbNames.reduce((s, p) => s + (parseFloat(arStyle.getPropertyValue(p)) || 0), 0);
          const otherContent = otherBB.result - otherPb;
          const thisContent = axis === "width" ? otherContent * ratio : otherContent / ratio;
          result = thisContent + thisPb;
        }
        const nb = make(b, "intrinsic-content", el, axis,
          `Intrinsic ${axis}: derived from aspect-ratio`,
          borderBoxCalc(el, axis), { otherAxis: otherBB });
        if (nb) return nb.finishWithResult(round(result));
        return b.get("intrinsic-content", el, axis)!;
      }
    }
  }

  const contentNode = contentSize(b, el, axis, depth, true);

  const nb = make(b, "intrinsic-content", el, axis,
    `Intrinsic ${axis} from content`,
    ref(contentNode), { content: contentNode });
  if (!nb) return b.get("intrinsic-content", el, axis)!;
  nb.css("display", "Determines how children are laid out");
  nb.setCss(axis, "auto", "Not set explicitly — sized by content");
  return nb.finish();
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

  const nb = make(b, "clamped", el, axis, "Constrained by min/max", calc, { input });
  if (!nb) return b.get("clamped", el, axis)!;
  nb.css("box-sizing", "Determines how min/max constraints are interpreted");
  if (maxPx !== Infinity && input.result > maxPx) {
    nb.setCss(maxPropName, maxVal);
  } else {
    nb.setCss(minPropName, minVal);
  }
  return nb.finish();
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
  const nb = b.begin(kind, el, axis);

  // Record contextual CSS properties
  nb.setCss(axis, "auto", "Not set explicitly — sized by content");
  nb.css("overflow", "Affects minimum size calculation");

  const isFlexCross = isFlex && !isFlexMain;
  const isGrid = display === "grid" || display === "inline-grid";
  const useIntrinsic = isFlexCross || isGrid || intrinsic;

  const childNodes: LayoutNode[] = [];
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
  }

  const gap = nb.cssPx(axis === "width" ? "column-gap" : "row-gap");

  childNodes.forEach((n, idx) => { nb.input(`child${idx}`, n); });

  // Build CalcExpr: children + gaps + padding + border = border-box size
  let calc: CalcExpr;
  const gapPropName = axis === "width" ? "column-gap" : "row-gap";
  if (childNodes.length === 0) {
    calc = borderBoxCalc(el, axis);
  } else {
    const childRefs = childNodes.map(n => ref(n));
    const pbProps = axis === "width"
      ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
      : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
    const pbTerms: CalcExpr[] = pbProps
      .filter(p => nb.cssPx(p) > 0)
      .map(p => nb.prop(p));

    if (mode === "sum") {
      const args: CalcExpr[] = [childRefs[0]];
      for (let j = 1; j < childRefs.length; j++) {
        if (gap > 0) args.push(nb.prop(gapPropName));
        args.push(childRefs[j]);
      }
      args.push(...pbTerms);
      calc = add(...args);
    } else {
      if (pbTerms.length > 0) {
        calc = add(cmax(...childRefs), ...pbTerms);
      } else {
        calc = cmax(...childRefs);
      }
    }
  }

  const hasChildren = childNodes.length > 0;
  if (mode === "sum") {
    nb.describe(hasChildren
      ? `${axis} is determined by stacking its children`
      : `${axis} is determined by its text/inline content`);
  } else {
    nb.describe(hasChildren
      ? `${axis} is determined by its tallest/widest child`
      : `${axis} is determined by its content`);
  }

  return nb.calc(calc).finishWithResult(size);
}
