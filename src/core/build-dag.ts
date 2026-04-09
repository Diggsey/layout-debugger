/**
 * DAG builder — orchestrates layout computation for any element.
 *
 * Entry point: buildDag(el) → DagResult with width and height root nodes.
 */
import type { LayoutNode, DagResult, Axis, NodeKind, NodeMode, CalcExpr } from "./dag";
import { DagBuilder, NodeBuilder, ElementProxy, ref, constant, prop, add, cmax } from "./dag";
import { PX } from "./units";
import { blockFill } from "./analyzers/block";
export { containerContentArea } from "./analyzers/block";
import { flexItemMain, flexItemCross } from "./analyzers/flex";
import { gridItem } from "./analyzers/grid";
import { positioned } from "./analyzers/positioned";
import { aspectRatio } from "./analyzers/aspect-ratio";
import {
  round,
  flexMainAxisProp,
  measureIntrinsicSize,
  measureElementSize,
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

function measuredNode(b: DagBuilder, el: Element, axis: Axis, depth: number, mode: NodeMode, description?: string): LayoutNode {
  const kind: NodeKind = `measured:${axis}`;
  const desc = description ?? `Size of the browser ${mode === "viewport" ? "viewport" : mode}`;
  return b.create(kind, el, depth, (nb) => {
    nb.setMode(mode).describe(desc).calc(borderBoxCalc(nb.proxy, axis));
  });
}

// ---------------------------------------------------------------------------
// Determine the calculation mode for an element+axis
// ---------------------------------------------------------------------------

/**
 * Walk up through display:contents ancestors to find the real layout parent.
 * Returns a proxy that records reads with "parent." prefix, even if the
 * layout parent is a grandparent (when intermediate ancestors have display:contents).
 */
function findLayoutParent(proxy: ElementProxy): { proxy: ElementProxy; display: string } | null {
  // Start with the immediate parent proxy (shares records with the node's proxy)
  let pp = proxy.getParent();
  let display = pp.readProperty("display");
  while (display === "contents" && pp.element.parentElement && pp.element !== document.documentElement) {
    // The real layout parent is further up — but keep using "parent." prefix
    pp = pp.getParent();
    display = pp.readProperty("display");
  }
  if (display === "contents") return null;
  return { proxy: pp, display };
}

function determineMode(proxy: ElementProxy, axis: Axis): NodeMode {
  const el = proxy.element;
  if (el === document.documentElement) return "viewport";

  const display = proxy.readProperty("display");
  if (display === "none") return "display-none";
  if (display === "contents") return "display-contents";

  const position = proxy.readProperty("position");
  const parent = el.parentElement;
  // Find the real layout parent (walks through display:contents ancestors)
  const lp = (parent && position !== "absolute" && position !== "fixed")
    ? findLayoutParent(proxy) : null;
  const lpDisplay = lp?.display;
  let isGridItem = false;
  if (lp) {
    if (lpDisplay === "flex" || lpDisplay === "inline-flex") {
      const direction = lp.proxy.readProperty("flex-direction");
      const wrap = lp.proxy.readProperty("flex-wrap");
      const wm = lp.proxy.readProperty("writing-mode");
      if (wrap !== "nowrap") return "terminal"; // Multi-line flex: not yet modeled
      if (axis === flexMainAxisProp(direction, wm)) return "flex-item-main";
    }
    if (lpDisplay === "grid" || lpDisplay === "inline-grid") {
      isGridItem = true;
    }
  }

  // Aspect-ratio: derive one axis from the other
  const ar = proxy.readProperty("aspect-ratio");
  if (!isGridItem && ar && ar !== "auto") {
    const match = ar.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
    if (match) {
      const explicit = proxy.getExplicitSize(axis);
      const otherAxis: Axis = axis === "width" ? "height" : "width";
      const otherExplicit = proxy.getExplicitSize(otherAxis);
      if (!explicit && otherExplicit) return "aspect-ratio";
    }
  }

  const explicit = proxy.getExplicitSize(axis);
  if (explicit) return explicit.kind === "percentage" ? "percentage" : "explicit";

  const intrinsic = proxy.getIntrinsicKeyword(axis);
  if (intrinsic) return "intrinsic-keyword";

  // Flex cross axis (wrapped flex returned "terminal" above, so this is single-line only)
  if (lp) {
    if (lpDisplay === "flex" || lpDisplay === "inline-flex") {
      // This is the cross axis (main axis was handled above)
      const alignSelf = proxy.readProperty("align-self");
      const alignItems = lp.proxy.readProperty("align-items");
      const effectiveAlign = (alignSelf === "auto" || alignSelf === "normal") ? alignItems : alignSelf;
      return (effectiveAlign === "stretch" || effectiveAlign === "normal")
        ? "flex-cross-stretch" : "flex-cross-content";
    }
    if (lpDisplay === "grid" || lpDisplay === "inline-grid") return "grid-item";
  }

  if (position === "absolute" || position === "fixed") {
    const startProp = axis === "width" ? "left" : "top";
    const endProp = axis === "width" ? "right" : "bottom";
    return !isAuto(proxy.readProperty(startProp)) && !isAuto(proxy.readProperty(endProp))
      ? "positioned-offset" : "positioned-shrink-to-fit";
  }

  if (display === "table-cell") return "table-cell";

  const cssFloat = proxy.readProperty("float");
  const writingMode = proxy.readProperty("writing-mode");
  const parentWm = lp ? lp.proxy.readProperty("writing-mode") : "horizontal-tb";
  const isFloat = cssFloat !== "none";
  const isInline = display.startsWith("inline");
  if (isInline || isFloat) return "content-driven";

  // Orthogonal flows (child writing-mode differs from parent) have complex auto-sizing
  // rules per CSS Writing Modes §10.1 — content-driven for both axes is the safe fallback.
  const isVertical = (wm: string) => wm === "vertical-rl" || wm === "vertical-lr";
  if (isVertical(writingMode) !== isVertical(parentWm)) return "content-driven";

  // Same writing-mode family: inline axis fills, block axis is content-driven.
  const inlineAxis = isVertical(parentWm) ? "height" : "width";
  return axis === inlineAxis ? "block-fill" : "content-driven";
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

export function computeSize(b: DagBuilder, el: Element, axis: Axis, depth: number): LayoutNode {
  if (depth <= 0) return measuredNode(b, el, axis, depth, "terminal", "Measured size (computation depth limit reached)");

  const kind: NodeKind = `size:${axis}`;

  return b.create(kind, el, depth, (nb) => {
    const mode = determineMode(nb.proxy, axis);
    nb.setMode(mode);

    switch (mode) {
      case "viewport":
        nb.describe("Size of the browser viewport")
          .calc(borderBoxCalc(nb.proxy, axis));
        break;
      case "display-none":
        nb.describe("Element is hidden (display: none)")
          .calc(constant(0, PX));
        break;
      case "display-contents":
        nb.describe("Element has no box (display: contents)")
          .calc(constant(0, PX));
        break;
      case "aspect-ratio":
        aspectRatio(nb, axis);
        break;
      case "percentage": {
        const cb = nb.proxy.getContainingBlock();
        const cbNode = nb.computeSize(cb.element, axis);
        nb.css("box-sizing");
        nb.describe(`${axis} is a percentage of the containing block`)
          .calc(borderBoxCalc(nb.proxy, axis))
          .input("containingBlock", cbNode);
        break;
      }
      case "explicit":
        nb.css("box-sizing");
        nb.describe(`${axis} is set explicitly in CSS`)
          .calc(borderBoxCalc(nb.proxy, axis));
        break;
      case "intrinsic-keyword":
        nb.describe(`${axis} uses an intrinsic sizing keyword`)
          .calc(borderBoxCalc(nb.proxy, axis));
        break;
      case "flex-item-main":
        flexItemMain(nb, axis);
        break;
      case "flex-cross-stretch":
      case "flex-cross-content":
        flexItemCross(nb, axis);
        break;
      case "grid-item":
        gridItem(nb, axis);
        break;
      case "positioned-offset":
      case "positioned-shrink-to-fit":
        positioned(nb, axis);
        break;
      case "table-cell":
        nb.describe("Table cell — sized by browser table algorithm")
          .calc(borderBoxCalc(nb.proxy, axis));
        break;
      case "block-fill":
        blockFill(nb, axis);
        break;
      case "content-driven":
        contentSize(nb, axis);
        break;
      default:
        nb.describe("Measured size")
          .calc(borderBoxCalc(nb.proxy, axis));
        break;
    }

    nb.maybeClamp(axis);
  });
}

// ---------------------------------------------------------------------------
// Intrinsic (content-based) size
// ---------------------------------------------------------------------------

export function computeIntrinsicSize(
  b: DagBuilder, el: Element, axis: Axis, depth: number,
): LayoutNode {
  if (depth <= 0) return measuredNode(b, el, axis, depth, "terminal", "Measured size (computation depth limit reached)");

  const kind: NodeKind = `intrinsic:${axis}`;

  if (b.isBuilding(kind, el)) {
    return measuredNode(b, el, axis, depth, "terminal", "Measured size (circular dependency)");
  }

  return b.create(kind, el, depth, (nb) => {
    nb.setMode("intrinsic-content");

    // If the element has an explicit size, that IS the intrinsic size.
    if (nb.proxy.getExplicitSize(axis)) {
      nb.describe(`Intrinsic ${axis}: set explicitly in CSS`)
        .calc(borderBoxCalc(nb.proxy, axis));
      return;
    }

    // If aspect-ratio can derive this axis from an explicit other axis, compute it.
    const arVal = nb.css("aspect-ratio");
    const overflow = nb.css("overflow");
    if (arVal && arVal !== "auto" && overflow !== "scroll" && overflow !== "auto") {
      const otherAxis: Axis = axis === "width" ? "height" : "width";
      if (nb.proxy.getExplicitSize(otherAxis)) {
        const otherBB = nb.computeIntrinsicSize(el, otherAxis, depth);
        const arMatch = arVal.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
        if (arMatch) {
          const ratioW = parseFloat(arMatch[1]);
          const ratioH = arMatch[2] ? parseFloat(arMatch[2]) : 1;
          const ratio = ratioW / ratioH;
          const isBorderBox = nb.css("box-sizing") === "border-box";

          let result: number;
          if (isBorderBox) {
            result = axis === "width" ? otherBB.result * ratio : otherBB.result / ratio;
          } else {
            const otherPbNames = otherAxis === "width"
              ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
              : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
            const thisPbNames = axis === "width"
              ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
              : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
            const otherPb = otherPbNames.reduce((s, p) => s + nb.cssPx(p), 0);
            const thisPb = thisPbNames.reduce((s, p) => s + nb.cssPx(p), 0);
            const otherContent = otherBB.result - otherPb;
            const thisContent = axis === "width" ? otherContent * ratio : otherContent / ratio;
            result = thisContent + thisPb;
          }
          nb.describe(`Intrinsic ${axis}: derived from aspect-ratio`)
            .calc(borderBoxCalc(nb.proxy, axis))
            .input("otherAxis", otherBB)
            .overrideResult(round(result));
          return;
        }
      }
    }

    // Create a content sub-node for the intrinsic measurement.
    const contentNode = b.create(`content:${axis}`, el, depth, (cnb) => {
      contentSize(cnb, axis, true);
    });

    nb.css("display");
    nb.describe(`Intrinsic ${axis} from content`)
      .calc(ref(contentNode))
      .input("content", contentNode);
  });
}

// ---------------------------------------------------------------------------
// Content size (shared by block, inline, flex cross, intrinsic)
// ---------------------------------------------------------------------------

function contentSize(
  nb: NodeBuilder, axis: Axis, intrinsic = false,
): void {
  const el = nb.element;
  const display = nb.css("display");
  const size = intrinsic
    ? round(measureIntrinsicSize(el, axis))
    : round(measureElementSize(el, axis));

  const isFlex = display === "flex" || display === "inline-flex";
  const wm = nb.css("writing-mode");
  const flexDir = isFlex ? nb.css("flex-direction") : null;
  const isFlexMain = isFlex && axis === flexMainAxisProp(flexDir!, wm);
  const mode: "content-sum" | "content-max" = isFlex && !isFlexMain ? "content-max" : "content-sum";

  nb.setMode(mode);
  nb.css("overflow");

  // Content-driven sizing: children are measured intrinsically to avoid
  // cycles (a child can't fill a parent whose size depends on that child).
  // Per CSS2 §10.6.3 / CSS Sizing §4.1.
  const children = nb.proxy.getChildren();
  const childNodes: LayoutNode[] = [];
  for (const child of children) {
    if (nb.depth > 1) {
      childNodes.push(nb.computeIntrinsicSize(child.element, axis));
    }
  }

  // Gap: for flex, use direction-based gap; for block/grid, use axis-based gap
  const gapPropName = isFlex
    ? (flexDir!.startsWith("column") ? "row-gap" as const : "column-gap" as const)
    : (axis === "width" ? "column-gap" as const : "row-gap" as const);
  const gap = nb.cssPx(gapPropName);

  childNodes.forEach((n, idx) => { nb.input(`child${idx}`, n); });

  let calc: CalcExpr;
  if (childNodes.length === 0) {
    calc = borderBoxCalc(nb.proxy, axis);
  } else {
    const childRefs = childNodes.map(n => ref(n));
    const pbProps = axis === "width"
      ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
      : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
    const pbTerms: CalcExpr[] = pbProps
      .filter(p => nb.cssPx(p) > 0)
      .map(p => nb.prop(p));

    if (mode === "content-sum") {
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
  if (mode === "content-sum") {
    nb.describe(hasChildren
      ? `${axis} is determined by stacking its children`
      : `${axis} is determined by its text/inline content`);
  } else {
    nb.describe(hasChildren
      ? `${axis} is determined by its tallest/widest child`
      : `${axis} is determined by its content`);
  }

  nb.calc(calc).overrideResult(size);
}
