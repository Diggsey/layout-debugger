/**
 * DAG builder — orchestrates layout computation for any element.
 *
 * Entry point: buildDag(el) → DagResult with width and height root nodes.
 */
import type { LayoutNode, DagResult, Axis, NodeKind, NodeMode, SizeFns, CalcExpr } from "./dag";
import { DagBuilder, NodeBuilder, ElementProxy, ref, constant, prop, add, cmax } from "./dag";
import { PX } from "./units";
import { blockFill, containerContentArea } from "./analyzers/block";
import { flexItemMain, flexItemCross } from "./analyzers/flex";
import { gridItem } from "./analyzers/grid";
import { positioned } from "./analyzers/positioned";
import { aspectRatio } from "./analyzers/aspect-ratio";
import {
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

/** Build a CalcExpr for an element's border-box size from its CSS properties. */
function borderBoxCalc(proxy: ElementProxy, axis: Axis): CalcExpr {
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

function measuredNode(b: DagBuilder, el: Element, axis: Axis, mode: NodeMode, description?: string): LayoutNode {
  const kind: NodeKind = `measured:${axis}`;
  const desc = description ?? `Size of the browser ${mode === "viewport" ? "viewport" : mode}`;
  return b.create(kind, el, (nb) => {
    nb.setMode(mode).describe(desc).calc(borderBoxCalc(nb.proxy, axis));
  });
}

// ---------------------------------------------------------------------------
// Determine the calculation mode for an element+axis
// ---------------------------------------------------------------------------

function determineMode(proxy: ElementProxy, axis: Axis): NodeMode {
  const el = proxy.element;
  if (el === document.documentElement) return "viewport";

  const display = proxy.readProperty("display");
  if (display === "none") return "display-none";
  if (display === "contents") return "display-contents";

  const position = proxy.readProperty("position");
  const parent = el.parentElement;
  let isGridItem = false;
  if (parent && position !== "absolute" && position !== "fixed") {
    const pp = proxy.getParent();
    const parentDisplay = pp.readProperty("display");
    if (parentDisplay === "flex" || parentDisplay === "inline-flex") {
      const direction = pp.readProperty("flex-direction");
      if (axis === flexMainAxisProp(direction)) {
        const wrap = pp.readProperty("flex-wrap");
        if (wrap === "nowrap") return "flex-item-main";
      }
    }
    if (parentDisplay === "grid" || parentDisplay === "inline-grid") {
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

  // Flex cross axis
  if (parent && position !== "absolute" && position !== "fixed") {
    const pp = proxy.getParent();
    const parentDisplay = pp.readProperty("display");
    if (parentDisplay === "flex" || parentDisplay === "inline-flex") {
      // This is the cross axis (main axis was handled above)
      const alignSelf = proxy.readProperty("align-self");
      const alignItems = pp.readProperty("align-items");
      const effectiveAlign = (alignSelf === "auto" || alignSelf === "normal") ? alignItems : alignSelf;
      return (effectiveAlign === "stretch" || effectiveAlign === "normal")
        ? "flex-cross-stretch" : "flex-cross-content";
    }
    if (parentDisplay === "grid" || parentDisplay === "inline-grid") return "grid-item";
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
  const inlineAxis = (writingMode === "vertical-rl" || writingMode === "vertical-lr") ? "height" : "width";
  const isFloat = cssFloat !== "none";
  const isInline = display.startsWith("inline");
  if (isInline || isFloat) return "content-driven";
  return axis === inlineAxis ? "block-fill" : "content-driven";
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

function computeSize(b: DagBuilder, el: Element, axis: Axis, depth: number): LayoutNode {
  if (depth <= 0) return measuredNode(b, el, axis, "terminal", "Measured size (computation depth limit reached)");

  const kind: NodeKind = `size:${axis}`;

  return b.create(kind, el, (nb) => {
    const mode = determineMode(nb.proxy, axis);
    nb.setMode(mode);

    const fns = buildSizeFns(b);

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
        aspectRatio(fns, nb, axis, depth);
        break;
      case "percentage": {
        const cb = nb.proxy.getContainingBlock();
        const cbNode = computeSize(b, cb.element, axis, depth - 1);
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
        flexItemMain(fns, nb, axis, depth);
        break;
      case "flex-cross-stretch":
      case "flex-cross-content":
        flexItemCross(fns, nb, axis, depth);
        break;
      case "grid-item":
        gridItem(fns, nb, axis, depth);
        break;
      case "positioned-offset":
      case "positioned-shrink-to-fit":
        positioned(fns, nb, axis, depth);
        break;
      case "table-cell":
        nb.describe("Table cell — sized by browser table algorithm")
          .calc(borderBoxCalc(nb.proxy, axis));
        break;
      case "block-fill":
        blockFill(fns, nb, axis, depth);
        break;
      case "content-driven":
        contentSize(b, nb, axis, depth);
        break;
      default:
        nb.describe("Measured size")
          .calc(borderBoxCalc(nb.proxy, axis));
        break;
    }

    nb.maybeClamp(axis);
  });
}

/** Build the SizeFns callback interface for a given DagBuilder. */
function buildSizeFns(b: DagBuilder): SizeFns {
  const fns: SizeFns = {
    computeSize: (el, axis, depth) => computeSize(b, el, axis, depth),
    computeIntrinsicSize: (el, axis, depth) => computeIntrinsicSize(b, el, axis, depth),
    contentSize: (el, axis, depth, intrinsic) => {
      if (intrinsic) return computeIntrinsicSize(b, el, axis, depth);
      // Determine content mode inside the create callback where we have a proxy
      // Try content-sum first (more common); contentSize will set the correct mode
      return b.create(`content:${axis}`, el, (nb) => contentSize(b, nb, axis, depth));
    },
    containerContentArea: (container, axis, borderBoxNode) =>
      containerContentArea(fns, container, axis, borderBoxNode),
    borderBoxCalc,
    create: (kind, element, cb) => b.create(kind, element, cb),
  };
  return fns;
}

// ---------------------------------------------------------------------------
// Intrinsic (content-based) size
// ---------------------------------------------------------------------------

function computeIntrinsicSize(
  b: DagBuilder, el: Element, axis: Axis, depth: number,
): LayoutNode {
  if (depth <= 0) return measuredNode(b, el, axis, "terminal", "Measured size (computation depth limit reached)");

  const kind: NodeKind = `intrinsic:${axis}`;

  if (b.isBuilding(kind, el)) {
    return measuredNode(b, el, axis, "terminal", "Measured size (circular dependency)");
  }

  return b.create(kind, el, (nb) => {
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
        const otherBB = computeIntrinsicSize(b, el, otherAxis, depth);
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
    // Can't use fns.contentSize(intrinsic=true) because it recurses back here.
    const contentNode = b.create(`content:${axis}`, el, (cnb) => {
      contentSize(b, cnb, axis, depth, true);
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
  b: DagBuilder, nb: NodeBuilder, axis: Axis, depth: number, intrinsic = false,
): void {
  const el = nb.element;
  const display = nb.css("display");
  const size = intrinsic
    ? round(measureIntrinsicSize(el, axis))
    : round(axis === "width" ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);

  const isFlex = display === "flex" || display === "inline-flex";
  const isFlexMain = isFlex && axis === flexMainAxisProp(nb.css("flex-direction"));
  const mode: "content-sum" | "content-max" = isFlex && !isFlexMain ? "content-max" : "content-sum";

  nb.setMode(mode);
  nb.css("overflow");

  // Content-driven sizing: children are measured intrinsically to avoid
  // cycles (a child can't fill a parent whose size depends on that child).
  // Per CSS2 §10.6.3 / CSS Sizing §4.1.
  const children = nb.proxy.getChildren();
  const childNodes: LayoutNode[] = [];
  for (const child of children) {
    if (depth > 1) {
      childNodes.push(computeIntrinsicSize(b, child.element, axis, depth - 1));
    }
  }

  const gap = nb.cssPx(axis === "width" ? "column-gap" : "row-gap");

  childNodes.forEach((n, idx) => { nb.input(`child${idx}`, n); });

  let calc: CalcExpr;
  const gapPropName = axis === "width" ? "column-gap" : "row-gap";
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
