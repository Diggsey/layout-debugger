/**
 * DAG builder — orchestrates layout computation for any element.
 *
 * Entry point: buildDag(el) → DagResult with width and height root nodes.
 */
import type { LayoutNode, DagResult, Axis, NodeKind, NodeMode, SizeFns, CalcExpr } from "./dag";
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

function measuredNode(b: DagBuilder, el: Element, axis: Axis, mode: NodeMode, description?: string): LayoutNode {
  const kind: NodeKind = `measured:${axis}`;
  const desc = description ?? `Size of the browser ${mode === "viewport" ? "viewport" : mode}`;
  return b.create(kind, el, (nb) => {
    nb.setMode(mode).describe(desc).calc(borderBoxCalc(el, axis));
  });
}

// ---------------------------------------------------------------------------
// Determine the calculation mode for an element+axis
// ---------------------------------------------------------------------------

function determineMode(proxy: { readProperty(name: string): string; getParent(): { readProperty(name: string): string } }, el: Element, axis: Axis): NodeMode {
  if (el === document.documentElement) return "viewport";

  const display = proxy.readProperty("display");
  if (display === "none") return "display-none";
  if (display === "contents") return "display-contents";

  const s = getComputedStyle(el);
  const parent = el.parentElement;
  let isGridItem = false;
  if (parent && s.position !== "absolute" && s.position !== "fixed") {
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

  const ar = s.aspectRatio;
  if (!isGridItem && ar && ar !== "auto") {
    const match = ar.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
    if (match) {
      const explicit = getExplicitSize(el, axis);
      const otherAxis: Axis = axis === "width" ? "height" : "width";
      const otherExplicit = getExplicitSize(el, otherAxis);
      if (!explicit && otherExplicit) {
        proxy.readProperty("aspect-ratio");
        return "aspect-ratio";
      }
    }
  }

  const explicit = getExplicitSize(el, axis);
  if (explicit) return explicit.kind === "percentage" ? "percentage" : "explicit";

  const intrinsic = getSpecifiedIntrinsicKeyword(el, axis);
  if (intrinsic) return "intrinsic-keyword";

  const ctx = identifyContext(el);

  if (ctx.mode === "flex") {
    return determineFlexCrossKind(el, axis, ctx);
  }
  if (ctx.mode === "grid") return "grid-item";
  if (ctx.mode === "positioned") {
    proxy.readProperty("position");
    const startProp = axis === "width" ? "left" : "top";
    const endProp = axis === "width" ? "right" : "bottom";
    return !isAuto(s.getPropertyValue(startProp)) && !isAuto(s.getPropertyValue(endProp))
      ? "positioned-offset" : "positioned-shrink-to-fit";
  }
  if (ctx.mode === "table-cell") return "table-cell";
  if (ctx.mode === "inline-block" || ctx.mode === "inline") return "content-driven";

  const isFloat = ctx.float !== "none";
  const fillsAvailable = axis === ctx.inlineAxis && !isFloat;
  return fillsAvailable ? "block-fill" : "content-driven";
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

function computeSize(b: DagBuilder, el: Element, axis: Axis, depth: number): LayoutNode {
  if (depth <= 0) return measuredNode(b, el, axis, "terminal", "Measured size (computation depth limit reached)");

  const kind: NodeKind = `size:${axis}`;

  return b.create(kind, el, (nb) => {
    const mode = determineMode(nb.proxy, el, axis);
    nb.setMode(mode);

    const fns = buildSizeFns(b, axis);
    const ctx = () => identifyContext(el);

    switch (mode) {
      case "viewport":
        nb.describe("Size of the browser viewport")
          .calc(borderBoxCalc(el, axis));
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
        aspectRatio(fns, nb, axis, ctx(), depth);
        break;
      case "percentage": {
        const c = ctx();
        const cbNode = computeSize(b, c.containingBlock, axis, depth - 1);
        nb.css("box-sizing");
        nb.describe(`${axis} is a percentage of the containing block`)
          .calc(borderBoxCalc(el, axis))
          .input("containingBlock", cbNode);
        break;
      }
      case "explicit":
        nb.css("box-sizing");
        nb.describe(`${axis} is set explicitly in CSS`)
          .calc(borderBoxCalc(el, axis));
        break;
      case "intrinsic-keyword":
        nb.describe(`${axis} uses an intrinsic sizing keyword`)
          .calc(borderBoxCalc(el, axis));
        break;
      case "flex-item-main":
        flexItemMain(fns, nb, axis, ctx(), depth);
        break;
      case "flex-cross-stretch":
      case "flex-cross-content":
        flexItemCross(fns, nb, axis, ctx(), depth);
        break;
      case "grid-item":
        gridItem(fns, nb, axis, ctx(), depth);
        break;
      case "positioned-offset":
      case "positioned-shrink-to-fit":
        positioned(fns, nb, axis, ctx(), depth);
        break;
      case "table-cell":
        nb.describe("Table cell — sized by browser table algorithm")
          .calc(borderBoxCalc(el, axis));
        break;
      case "block-fill":
        blockFill(fns, nb, axis, ctx(), depth);
        break;
      case "content-driven":
        contentSize(b, nb, el, axis, depth);
        break;
      default:
        nb.describe("Measured size")
          .calc(borderBoxCalc(el, axis));
        break;
    }

    nb.maybeClamp(axis);
  });
}

/** Build the SizeFns callback interface for a given DagBuilder. */
function buildSizeFns(b: DagBuilder, defaultAxis: Axis): SizeFns {
  const fns: SizeFns = {
    computeSize: (el, axis, depth) => computeSize(b, el, axis, depth),
    computeIntrinsicSize: (el, axis, depth) => computeIntrinsicSize(b, el, axis, depth),
    contentSize: (el, axis, depth, intrinsic) => {
      // Intrinsic content sizing goes through computeIntrinsicSize which
      // checks explicit size/aspect-ratio first, then falls back to content.
      if (intrinsic) return computeIntrinsicSize(b, el, axis, depth);
      const s = getComputedStyle(el);
      const d = s.display;
      const isFlex = d === "flex" || d === "inline-flex";
      const isFlexCross = isFlex && axis !== flexMainAxisProp(s.flexDirection);
      const base = isFlexCross ? "content-max" : "content-sum";
      return b.create(`${base}:${axis}`, el, (nb) => contentSize(b, nb, el, axis, depth));
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
    const explicit = getExplicitSize(el, axis);
    if (explicit) {
      nb.describe(`Intrinsic ${axis}: set explicitly in CSS`)
        .calc(borderBoxCalc(el, axis));
      return;
    }

    // If aspect-ratio can derive this axis from an explicit other axis, compute it.
    const arStyle = getComputedStyle(el);
    const arVal = arStyle.aspectRatio;
    if (arVal && arVal !== "auto" && arStyle.overflow !== "scroll" && arStyle.overflow !== "auto") {
      const otherAxis: Axis = axis === "width" ? "height" : "width";
      const otherExplicit = getExplicitSize(el, otherAxis);
      if (otherExplicit) {
        const otherBB = computeIntrinsicSize(b, el, otherAxis, depth);
        const arMatch = arVal.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
        if (arMatch) {
          const ratioW = parseFloat(arMatch[1]);
          const ratioH = arMatch[2] ? parseFloat(arMatch[2]) : 1;
          const ratio = ratioW / ratioH;
          const isBorderBox = arStyle.boxSizing === "border-box";

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
            const otherPb = otherPbNames.reduce((s, p) => s + (parseFloat(arStyle.getPropertyValue(p)) || 0), 0);
            const thisPb = thisPbNames.reduce((s, p) => s + (parseFloat(arStyle.getPropertyValue(p)) || 0), 0);
            const otherContent = otherBB.result - otherPb;
            const thisContent = axis === "width" ? otherContent * ratio : otherContent / ratio;
            result = thisContent + thisPb;
          }
          nb.describe(`Intrinsic ${axis}: derived from aspect-ratio`)
            .calc(borderBoxCalc(el, axis))
            .input("otherAxis", otherBB)
            .overrideResult(round(result));
          return;
        }
      }
    }

    // Create a content sub-node for the intrinsic measurement.
    // Can't use fns.contentSize(intrinsic=true) because it recurses back here.
    const s2 = getComputedStyle(el);
    const d2 = s2.display;
    const isFlex2 = d2 === "flex" || d2 === "inline-flex";
    const isFlexCross2 = isFlex2 && axis !== flexMainAxisProp(s2.flexDirection);
    const base = isFlexCross2 ? "content-max" : "content-sum";
    const contentNode = b.create(`${base}:${axis}`, el, (cnb) => {
      contentSize(b, cnb, el, axis, depth, true);
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
  b: DagBuilder, nb: NodeBuilder, el: Element, axis: Axis, depth: number, intrinsic = false,
): void {
  const s = getComputedStyle(el);
  const display = s.display;
  const size = intrinsic
    ? round(measureIntrinsicSize(el, axis))
    : round(axis === "width" ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);

  const isFlex = display === "flex" || display === "inline-flex";
  const isFlexMain = isFlex && axis === flexMainAxisProp(s.flexDirection);
  const mode: "content-sum" | "content-max" = isFlex && !isFlexMain ? "content-max" : "content-sum";

  nb.setMode(mode);
  nb.css("overflow");

  // Content-driven sizing: children are measured intrinsically to avoid
  // cycles (a child can't fill a parent whose size depends on that child).
  // Per CSS2 §10.6.3 / CSS Sizing §4.1.
  const fns = buildSizeFns(b, axis);
  const childNodes: LayoutNode[] = [];
  for (const child of Array.from(el.children)) {
    const cs = getComputedStyle(child);
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    if (cs.display === "none" || cs.display === "contents") continue;
    if (depth > 1) {
      childNodes.push(computeIntrinsicSize(b, child, axis, depth - 1));
    }
  }

  const gap = nb.cssPx(axis === "width" ? "column-gap" : "row-gap");

  childNodes.forEach((n, idx) => { nb.input(`child${idx}`, n); });

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
