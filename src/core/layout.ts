/**
 * Layout computation — orchestrates DAG construction for any element.
 *
 * Entry point: buildDag(el) → DagResult with width and height root nodes.
 * Determines the layout mode for each element+axis and dispatches to analyzers.
 */
import type { LayoutNode, DagResult, Axis, NodeKind, NodeMode, CalcExpr } from "./types";
import { DagBuilder } from "./dag-builder";
import type { NodeBuilder } from "./node-builder";
import { ElementProxy } from "./element-proxy";
import { ref, constant, add, cmax, measured, propVal, prop } from "./calc";
import { PX } from "./units";
import { borderBoxCalc } from "./box-model";
import { blockFill } from "./analyzers/block";
import { flexItemMain, flexItemCross } from "./analyzers/flex";
import { gridItem } from "./analyzers/grid";
import { positioned } from "./analyzers/positioned";
import { aspectRatio } from "./analyzers/aspect-ratio";
import { round, flexMainAxisProp, isAuto } from "./utils";
import { measureIntrinsicSize, measureElementSize } from "./measure";

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
 * Build a border-box calc using the authored px size on the dimension axis.
 * For flex items, getComputedStyle returns the post-flex size, so we can't use
 * borderBoxCalc/prop for the dimension itself. Padding and border are still
 * read from computed style (they aren't affected by flex distribution).
 */
function explicitIntrinsicCalc(nb: NodeBuilder, axis: Axis, authoredPx: number): CalcExpr {
  const boxSizing = nb.proxy.readProperty("box-sizing");
  const dim = propVal(axis, authoredPx);
  if (boxSizing === "border-box") return dim;
  const pbProps = axis === "width"
    ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
    : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
  return add(dim, ...pbProps.map(p => prop(nb.proxy, p)));
}

function measuredNode(b: DagBuilder, el: Element, axis: Axis, depth: number, mode: NodeMode, description?: string): LayoutNode {
  const kind: NodeKind = `measured:${axis}`;
  const desc = description ?? `Size of the browser ${mode === "viewport" ? "viewport" : mode}`;
  return b.create(kind, el, depth, (nb) => {
    nb.setMode(mode).describe(desc);
    if (mode === "viewport") {
      const vpSize = axis === "width" ? window.innerWidth : window.innerHeight;
      nb.calc(measured("viewport", vpSize, PX));
    } else {
      nb.calc(borderBoxCalc(nb.proxy, axis));
    }
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
  let pp = proxy.getParent();
  let display = pp.readProperty("display");
  while (display === "contents" && pp.element.parentElement && pp.element !== document.documentElement) {
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
  const lp = (parent && position !== "absolute" && position !== "fixed")
    ? findLayoutParent(proxy) : null;
  const lpDisplay = lp?.display;
  let isGridItem = false;
  if (lp) {
    if (lpDisplay === "flex" || lpDisplay === "inline-flex") {
      const direction = lp.proxy.readProperty("flex-direction");
      const wrap = lp.proxy.readProperty("flex-wrap");
      const wm = lp.proxy.readProperty("writing-mode");
      if (wrap !== "nowrap") return "terminal";
      if (axis === flexMainAxisProp(direction, wm)) return "flex-item-main";
    }
    if (lpDisplay === "grid" || lpDisplay === "inline-grid") {
      isGridItem = true;
    }
  }

  // Pure inline elements ignore width/height — always content-driven
  if (display === "inline") return "content-driven";

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

  if (lp) {
    if (lpDisplay === "flex" || lpDisplay === "inline-flex") {
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

  const isVertical = (wm: string) => wm === "vertical-rl" || wm === "vertical-lr";
  if (isVertical(writingMode) !== isVertical(parentWm)) return "content-driven";

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
      case "viewport": {
        // The initial containing block is the viewport, not html's computed
        // box. getComputedStyle(html).height returns "0px" when the document
        // content doesn't stretch html, so we must use window dimensions.
        const vpSize = axis === "width" ? window.innerWidth : window.innerHeight;
        nb.describe("Size of the browser viewport")
          .calc(measured("viewport", vpSize, PX));
        break;
      }
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
        nb.describe(`${axis} is a percentage of the containing block`)
          .calc(borderBoxCalc(nb.proxy, axis))
          .input("containingBlock", cbNode);
        break;
      }
      case "explicit":
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

    // For explicit sizes, the intrinsic (max-content) size is the authored
    // value, not the computed value. getComputedStyle returns the post-flex
    // used value for flex items, so we use the authored resolvedPx from
    // getExplicitSize. propVal is safe here because the authored value IS
    // what the calc represents (the specified CSS value).
    const explicit = nb.proxy.getExplicitSize(axis);
    if (explicit) {
      nb.describe(`Intrinsic ${axis}: set explicitly in CSS`)
        .calc(explicit.kind === "fixed"
          ? explicitIntrinsicCalc(nb, axis, explicit.resolvedPx)
          : borderBoxCalc(nb.proxy, axis));
      return;
    }

    // Aspect-ratio transfer only applies when the element has no element
    // children. For block containers with children, the intrinsic size is
    // determined by the children's content, not the aspect ratio. If the
    // content is wider than the aspect-ratio-derived size, browsers use the
    // content size.
    const arVal = nb.css("aspect-ratio");
    const overflow = nb.css("overflow");
    const hasChildren = el.children.length > 0;
    if (!hasChildren && arVal && arVal !== "auto" && overflow !== "scroll" && overflow !== "auto") {
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

  const children = nb.proxy.getChildren();
  const childNodes: LayoutNode[] = [];
  for (const child of children) {
    if (nb.depth > 1) {
      childNodes.push(nb.computeIntrinsicSize(child.element, axis));
    }
  }

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
