/**
 * Flex layout analyzer.
 *
 * Spec references:
 * - CSS Flexbox §9    Flex Layout Algorithm
 * - CSS Flexbox §9.2  Line Length Determination (flex basis, step 3)
 * - CSS Flexbox §9.3  Main Size Determination
 * - CSS Flexbox §9.7  Resolving Flexible Lengths
 * - CSS Flexbox §9.4  Cross Size Determination
 * - CSS Flexbox §4.5  Automatic Minimum Size of Flex Items
 */
import type { Axis, LayoutNode, SizeFns, CalcExpr, NodeBuilder } from "../dag";
import { ref, constant, prop, propVal, measured, add, sub, mul, div, cmax, cmin } from "../dag";
import { PX } from "../units";
import type { LayoutContext } from "../types";
import { getExplicitSize, getSpecifiedValue } from "../sizing";
import { px, round, measureMinContentSize } from "../utils";

// ---------------------------------------------------------------------------
// Flex item — main axis
// ---------------------------------------------------------------------------

export function flexItemMain(
  fns: SizeFns, nb: NodeBuilder, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const el = nb.element;
  nb.setKind("flex-item-main");

  nb.css("flex-basis");
  nb.css("flex-grow");
  nb.css("flex-shrink");

  const container = ctx.parent;
  const containerStyle = getComputedStyle(container);
  const rect = el.getBoundingClientRect();
  const actualSize = round(axis === "width" ? rect.width : rect.height);

  const containerBorderBox = fns.computeSize(container, axis, depth - 1);
  const containerContent = fns.containerContentArea(container, axis, containerBorderBox);

  // Build sibling data (numbers for the algorithm + LayoutNodes for CalcExpr)
  const siblings = collectFlexSiblings(fns, nb, container, axis, depth);
  const gap = px(axis === "width" ? containerStyle.columnGap : containerStyle.rowGap);

  // Find the target in siblings
  const idx = siblings.findIndex(s => s.element === el);
  const target = idx >= 0 ? siblings[idx] : null;

  // Use the target's own basis/min-content/base-size nodes if available
  const baseSizeNode = target?.hypoNode ?? (
    fns.begin("flex-base-size", el, axis)
      ?.describe("Effective starting size")
      .calc(fns.borderBoxCalc(el, axis))
      .finish() ?? nb.get("flex-base-size", el, axis)!
  );

  // Free space: containerContent - Σ(sibling outer hypotheticals) - gaps
  const gapPropName = axis === "width" ? "column-gap" : "row-gap";
  const siblingTerms: CalcExpr[] = siblings.map(s => ref(s.outerNode));
  if (siblings.length > 1 && gap > 0) {
    for (let gi = 0; gi < siblings.length - 1; gi++) {
      siblingTerms.push(prop(container, gapPropName));
    }
  }
  const freeSpaceInputs: LayoutNode["inputs"] = { containerContent };
  siblings.forEach((s, i) => { freeSpaceInputs[`item${i}`] = s.outerNode; });
  const totalBases = siblings.reduce((sum, s) => sum + s.hypothetical + s.margin, 0);
  const totalGap = gap * Math.max(0, siblings.length - 1);
  const freeSpace = containerContent.result - totalBases - totalGap;

  const freeSpaceNode = fns.begin("flex-free-space", container, axis)
    ?.describe("Space remaining after all items are placed at their base size")
    .calc(sub(ref(containerContent), add(...siblingTerms)))
    .inputs(freeSpaceInputs)
    .finish() ?? nb.get("flex-free-space", container, axis)!;

  // Resolve flex lengths (iterative algorithm)
  const allItems = siblings.map(s => ({
    element: s.element, basis: s.basis, hypothetical: s.hypothetical,
    grow: s.grow, shrink: s.shrink, minMain: s.minMain, maxMain: s.maxMain,
    margin: s.margin, pb: s.pb,
  }));
  const resolved = resolveFlexLengths(allItems, containerContent.result, totalGap);
  const distributedSize = idx >= 0 ? resolved[idx] : actualSize;

  const grow = target?.grow ?? 0;
  const shrink = target?.shrink ?? 1;

  // Build share node with real CalcExpr
  let shareNode: LayoutNode;
  if (freeSpace > 0 && grow > 0) {
    const activeGrowNodes = siblings.filter(s => s.grow > 0).map(s => s.growNode!);
    const shareInputs: LayoutNode["inputs"] = { freeSpace: freeSpaceNode };
    activeGrowNodes.forEach((n, i) => { shareInputs[`grow${i}`] = n; });

    shareNode = fns.begin("flex-grow-share", el, axis)
      ?.describe("Portion of free space allocated to this item by flex-grow")
      .calc(mul(div(prop(el, "flex-grow"), add(...activeGrowNodes.map(ref))), ref(freeSpaceNode)))
      .inputs(shareInputs)
      .finish() ?? nb.get("flex-grow-share", el, axis)!;
  } else if (freeSpace < 0 && shrink > 0) {
    const activeShrinkNodes = siblings.filter(s => s.shrink > 0).map(s => s.scaledShrinkNode!);
    const shareInputs: LayoutNode["inputs"] = { freeSpace: freeSpaceNode };
    activeShrinkNodes.forEach((n, i) => { shareInputs[`shrink${i}`] = n; });

    const myScaledShrink = target?.scaledShrinkNode;
    shareNode = fns.begin("flex-shrink-share", el, axis)
      ?.describe("Amount this item shrinks to fit in the container")
      .calc(myScaledShrink
        ? mul(div(ref(myScaledShrink), add(...activeShrinkNodes.map(ref))), ref(freeSpaceNode))
        : constant(0, PX))
      .inputs(shareInputs)
      .finish() ?? nb.get("flex-shrink-share", el, axis)!;
  } else {
    shareNode = fns.begin("flex-no-change", el, axis)
      ?.describe(grow === 0 ? "This item does not grow or shrink" : "No free space to distribute")
      .calc(constant(0, PX))
      .finish() ?? nb.get("flex-no-change", el, axis)!;
  }

  return nb
    .describe(`Flex item \u2014 ${axis} determined by the flex layout algorithm`)
    .calc(add(ref(baseSizeNode), ref(shareNode)))
    .inputs({ baseSize: baseSizeNode, growShare: shareNode })
    .finishWithResult(round(distributedSize));
}

// ---------------------------------------------------------------------------
// Flex item — cross axis
// ---------------------------------------------------------------------------

type FlexCrossKind = "flex-cross-stretch" | "flex-cross-content" | "explicit" | "percentage";

export function determineFlexCrossKind(
  el: Element, axis: Axis, ctx: LayoutContext,
): FlexCrossKind {
  const explicit = getExplicitSize(el, axis);
  if (explicit) return explicit.kind === "percentage" ? "percentage" : "explicit";

  const s = getComputedStyle(el);
  const containerStyle = getComputedStyle(ctx.parent);
  const alignSelf = s.alignSelf;
  const alignItems = containerStyle.alignItems;
  const effectiveAlign = (alignSelf === "auto" || alignSelf === "normal") ? alignItems : alignSelf;

  return (effectiveAlign === "stretch" || effectiveAlign === "normal") ? "flex-cross-stretch" : "flex-cross-content";
}

export function flexItemCross(
  fns: SizeFns, nb: NodeBuilder, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const el = nb.element;
  const crossKind = determineFlexCrossKind(el, axis, ctx);

  const cached = nb.get(crossKind, el, axis);
  if (cached) return cached;
  if (nb.isBuilding(crossKind, el, axis)) return fns.measured(el, axis, "terminal");

  const explicit = getExplicitSize(el, axis);
  if (explicit) {
    if (explicit.kind === "percentage") {
      const cbNode = fns.computeSize(ctx.containingBlock, axis, depth - 1);
      const pnb = fns.begin("percentage", el, axis);
      if (!pnb) return nb.get("percentage", el, axis)!;
      return pnb.describe(`${axis} is a percentage of the containing block`)
        .calc(fns.borderBoxCalc(el, axis))
        .input("containingBlock", cbNode).finish();
    }
    const enb = fns.begin("explicit", el, axis);
    if (!enb) return nb.get("explicit", el, axis)!;
    return enb.describe(`${axis} is set explicitly in CSS`)
      .calc(fns.borderBoxCalc(el, axis)).finish();
  }

  const pp = nb.proxy.getParent();

  if (crossKind === "flex-cross-stretch") {
    nb.setKind("flex-cross-stretch");
    nb.css("align-self");
    pp.readProperty("align-items");
    const containerCross = fns.computeSize(ctx.parent, axis, depth - 1);
    return nb.describe("Flex item stretches on the cross axis to fill the container")
      .calc(fns.borderBoxCalc(el, axis))
      .input("containerCross", containerCross).finish();
  }

  nb.setKind("flex-cross-content");
  nb.css("align-self");
  pp.readProperty("align-items");
  const contentNode = fns.contentSize(el, axis, depth);
  return nb.describe("Flex item cross-axis size is determined by its content")
    .calc(ref(contentNode))
    .input("content", contentNode).finish();
}

// ---------------------------------------------------------------------------
// Flex sibling data: numbers for algorithm + LayoutNodes for CalcExpr
// ---------------------------------------------------------------------------

interface FlexSiblingData {
  element: Element;
  basis: number;
  hypothetical: number;
  grow: number;
  shrink: number;
  minMain: number;
  maxMain: number;
  margin: number;
  pb: number;
  // LayoutNodes for CalcExpr
  basisNode: LayoutNode;
  hypoNode: LayoutNode;       // hypothetical = max(min, min(max, basis))
  outerNode: LayoutNode;      // outer = hypothetical + margin
  growNode: LayoutNode | null; // flex-grow factor (null if grow=0)
  scaledShrinkNode: LayoutNode | null; // flex-shrink × inner-basis (null if shrink=0)
}

function itemPaddingBorder(cs: CSSStyleDeclaration, axis: Axis): number {
  return axis === "width"
    ? px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth)
    : px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
}

function collectFlexSiblings(
  fns: SizeFns, nb: NodeBuilder, container: Element, axis: Axis, depth: number,
): FlexSiblingData[] {
  const minPropName = axis === "width" ? "min-width" : "min-height";
  const maxPropName = axis === "width" ? "max-width" : "max-height";
  const containerStyle = getComputedStyle(container);
  const containerRect = container.getBoundingClientRect();
  const containerBB = axis === "width" ? containerRect.width : containerRect.height;
  const pad = axis === "width"
    ? px(containerStyle.paddingLeft) + px(containerStyle.borderLeftWidth) +
      px(containerStyle.paddingRight) + px(containerStyle.borderRightWidth)
    : px(containerStyle.paddingTop) + px(containerStyle.borderTopWidth) +
      px(containerStyle.paddingBottom) + px(containerStyle.borderBottomWidth);
  const containerContent = containerBB - pad;

  const items: FlexSiblingData[] = [];
  for (const child of Array.from(container.children)) {
    const cs = getComputedStyle(child);
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    if (cs.display === "none" || cs.display === "contents") continue;

    const pb = itemPaddingBorder(cs, axis);
    const isBorderBox = cs.boxSizing === "border-box";
    const fb = cs.flexBasis;

    // --- Basis (number + node) ---
    let basis: number;
    let basisCalc: CalcExpr;
    if (fb === "0" || fb === "0px" || fb === "0%") {
      basis = pb;
      basisCalc = propVal("flex-basis", 0);
    } else if (fb.endsWith("px") && fb !== "auto") {
      const raw = parseFloat(fb);
      basis = isBorderBox ? raw : raw + pb;
      basisCalc = prop(child, "flex-basis");
    } else if (fb.endsWith("%")) {
      const raw = (parseFloat(fb) / 100) * containerContent;
      basis = isBorderBox ? raw : raw + pb;
      basisCalc = prop(child, "flex-basis");
    } else if (fb === "auto") {
      const specified = getSpecifiedValue(child, axis);
      if (specified && specified.endsWith("px")) {
        const raw = parseFloat(specified);
        basis = isBorderBox ? raw : raw + pb;
        // Can't use prop(child, axis) — getComputedStyle returns the post-flex
        // used value, not the specified value. Use propVal with the specified value.
        basisCalc = propVal(axis, raw);
      } else if (specified && specified.endsWith("%")) {
        const raw = (parseFloat(specified) / 100) * containerContent;
        basis = isBorderBox ? raw : raw + pb;
        basisCalc = propVal(axis, raw);
      } else {
        basis = fns.computeIntrinsicSize(child, axis, depth - 1).result;
        basisCalc = ref(fns.computeIntrinsicSize(child, axis, depth - 1));
      }
    } else {
      basis = fns.computeIntrinsicSize(child, axis, depth - 1).result;
      basisCalc = ref(fns.computeIntrinsicSize(child, axis, depth - 1));
    }
    basis = Math.max(basis, pb);

    const basisNode = fns.begin("flex-basis", child, axis)
      ?.describe("Starting size before flex grow/shrink")
      .calc(basisCalc).finish() ?? nb.get("flex-basis", child, axis)!;

    // --- Max main ---
    const maxV = cs.getPropertyValue(maxPropName);
    let maxMain: number;
    if (maxV === "none") {
      maxMain = Infinity;
    } else {
      const raw = px(maxV);
      maxMain = isBorderBox ? raw : raw + pb;
    }

    // --- Min main (number + node) ---
    const minV = cs.getPropertyValue(minPropName);
    const ov = axis === "width" ? cs.overflowX : cs.overflowY;
    const isScroll = ov !== "visible" && ov !== "clip";
    let minMain: number;
    let minCalc: CalcExpr;
    if (minV === "auto") {
      if (isScroll) {
        minMain = 0;
        minCalc = constant(0, PX);
      } else {
        // CSS Flexbox §4.5: automatic minimum size =
        //   min(content minimum, specified size, max main size)
        // For aspect-ratio elements, the transferred size contributes to min-content.
        const arVal = cs.getPropertyValue("aspect-ratio");
        const otherAxis: "width" | "height" = axis === "width" ? "height" : "width";
        const otherVal = cs.getPropertyValue(otherAxis);
        if (arVal && arVal !== "auto" && otherVal && parseFloat(otherVal) > 0) {
          const arMatch = arVal.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
          if (arMatch) {
            const ratio = parseFloat(arMatch[1]) / (arMatch[2] ? parseFloat(arMatch[2]) : 1);
            const otherPx = parseFloat(otherVal);
            const transferred = axis === "width" ? otherPx * ratio : otherPx / ratio;
            minMain = transferred + pb;
            minCalc = measured("min-content (aspect-ratio)", minMain);
          } else {
            minMain = measureMinContentSize(child, axis);
            minCalc = measured("min-content", minMain);
          }
        } else {
          minMain = measureMinContentSize(child, axis);
          minCalc = measured("min-content", minMain);
        }
        // Cap by specified size if present
        const specified = getSpecifiedValue(child, axis);
        if (specified) {
          const specPx = parseFloat(specified);
          if (!isNaN(specPx)) {
            const specBB = isBorderBox ? specPx : specPx + pb;
            if (specBB < minMain) {
              minMain = specBB;
              minCalc = propVal(axis, specPx);
            }
          }
        }
        // Cap by max main size (§4.5: "clamped by the max main size property")
        if (maxMain !== Infinity && maxMain < minMain) {
          minMain = maxMain;
        }
      }
    } else {
      const raw = px(minV);
      minMain = isBorderBox ? raw : raw + pb;
      if (isBorderBox) {
        minCalc = prop(child, minPropName);
      } else {
        const pbNames = axis === "width"
          ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
          : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
        minCalc = add(prop(child, minPropName), ...pbNames.map(p => prop(child, p)));
      }
    }
    minMain = Math.max(minMain, pb);
    const minNode = fns.begin("min-content", child, axis)
      ?.describe(minV === "auto" ? `Minimum ${axis} from content` : `${minPropName} constraint`)
      .calc(minCalc).finish() ?? nb.get("min-content", child, axis)!;

    // --- Hypothetical: max(min, min(max, basis)) ---
    const hypothetical = Math.max(minMain, Math.min(maxMain, basis));
    let hypoCalc: CalcExpr;
    if (maxMain === Infinity) {
      hypoCalc = cmax(ref(minNode), ref(basisNode));
    } else {
      // For content-box, max-width/height is content-box — add padding+border
      let maxCalc: CalcExpr;
      if (isBorderBox) {
        maxCalc = prop(child, maxPropName);
      } else {
        const pbNames = axis === "width"
          ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
          : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
        maxCalc = add(prop(child, maxPropName), ...pbNames.map(p => prop(child, p)));
      }
      const maxNode = fns.begin("clamped", child, axis)
        ?.describe(`${maxPropName} constraint`).calc(maxCalc).finish()
        ?? nb.get("clamped", child, axis)!;
      hypoCalc = cmax(ref(minNode), cmin(ref(maxNode), ref(basisNode)));
    }
    const hypoNode = fns.begin("flex-base-size", child, axis)
      ?.describe("Hypothetical main size (basis clamped by min/max)")
      .calc(hypoCalc).inputs({ basis: basisNode, minContent: minNode })
      .finish() ?? nb.get("flex-base-size", child, axis)!;

    // --- Margin + outer hypothetical ---
    const [mStartName, mEndName] = axis === "width"
      ? ["margin-left", "margin-right"] as const
      : ["margin-top", "margin-bottom"] as const;
    const mStart = px(cs.getPropertyValue(mStartName));
    const mEnd = px(cs.getPropertyValue(mEndName));
    const margin = mStart + mEnd;

    const outerCalc = margin > 0
      ? add(ref(hypoNode), prop(child, mStartName), prop(child, mEndName))
      : ref(hypoNode);
    const outerNode = fns.begin("flex-outer-hypo", child, axis)
      ?.describe("Outer hypothetical size (including margins)")
      .calc(outerCalc).input("hypothetical", hypoNode)
      .finish() ?? nb.get("flex-outer-hypo", child, axis)!;

    // --- Grow factor node ---
    const growVal = parseFloat(cs.flexGrow) || 0;
    const growNode = growVal > 0
      ? (fns.begin("flex-grow-factor", child, axis)
          ?.describe("flex-grow factor").calc(prop(child, "flex-grow")).finish()
          ?? nb.get("flex-grow-factor", child, axis)!)
      : null;

    // --- Scaled shrink factor: flex-shrink × inner-basis ---
    // Inner basis = basis - padding+border (content-box basis per §9.7 step 3b)
    const shrinkVal = parseFloat(cs.flexShrink);
    const pbProps = axis === "width"
      ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
      : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
    const innerBasisCalc = cmax(constant(0, PX), sub(ref(basisNode), add(...pbProps.map(p => prop(child, p)))));
    const scaledShrinkNode = shrinkVal > 0
      ? (fns.begin("flex-scaled-shrink", child, axis)
          ?.describe("Scaled shrink factor (flex-shrink \u00d7 inner basis)")
          .calc(mul(prop(child, "flex-shrink"), innerBasisCalc))
          .input("basis", basisNode).finish()
          ?? nb.get("flex-scaled-shrink", child, axis)!)
      : null;

    items.push({
      element: child, basis, hypothetical, grow: growVal, shrink: shrinkVal,
      minMain, maxMain, margin, pb,
      basisNode, hypoNode, outerNode, growNode, scaledShrinkNode,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Flex length resolution (freeze-and-redistribute)
// ---------------------------------------------------------------------------

interface FlexItem {
  element: Element; basis: number; hypothetical: number;
  grow: number; shrink: number; minMain: number; maxMain: number; margin: number;
  pb: number;
}

function resolveFlexLengths(
  items: FlexItem[], containerContent: number, totalGap: number,
): number[] {
  const state = items.map((item) => ({ frozen: false, target: item.basis }));
  const totalHypo = items.reduce((s, i) => s + i.hypothetical + i.margin, 0);
  const growing = containerContent - totalHypo - totalGap > 0;

  for (let i = 0; i < items.length; i++) {
    const factor = growing ? items[i].grow : items[i].shrink;
    if (factor === 0 || (growing && items[i].basis > items[i].hypothetical) ||
        (!growing && items[i].basis < items[i].hypothetical)) {
      state[i].target = items[i].hypothetical;
      state[i].frozen = true;
    }
  }

  for (let iter = 0; iter < 20; iter++) {
    const unfrozen = state.map((s, i) => s.frozen ? -1 : i).filter((i) => i >= 0);
    if (unfrozen.length === 0) break;

    const used = state.reduce((s, st, i) => s + (st.frozen ? st.target : items[i].basis) + items[i].margin, 0);
    const remaining = containerContent - used - totalGap;

    if (growing) {
      const tg = unfrozen.reduce((s, i) => s + items[i].grow, 0);
      for (const i of unfrozen) state[i].target = items[i].basis + (tg > 0 ? (items[i].grow / tg) * remaining : 0);
    } else {
      const ts = unfrozen.reduce((s, i) => s + items[i].shrink * Math.max(0, items[i].basis - items[i].pb), 0);
      for (const i of unfrozen) {
        const innerBasis = Math.max(0, items[i].basis - items[i].pb);
        const r = ts > 0 ? (items[i].shrink * innerBasis) / ts : 0;
        state[i].target = items[i].basis + r * remaining;
      }
    }

    let totalViolation = 0;
    const clamped: number[] = [];
    for (const i of unfrozen) {
      let violation = 0;
      if (state[i].target < items[i].minMain) {
        violation = items[i].minMain - state[i].target;
        state[i].target = items[i].minMain;
      } else if (state[i].target > items[i].maxMain) {
        violation = items[i].maxMain - state[i].target;
        state[i].target = items[i].maxMain;
      }
      if (violation !== 0) clamped.push(i);
      totalViolation += violation;
    }
    if (clamped.length === 0) break;
    for (const i of clamped) {
      const isMin = state[i].target === items[i].minMain;
      if ((totalViolation > 0 && isMin) || (totalViolation < 0 && !isMin)) {
        state[i].frozen = true;
      }
    }
  }

  return state.map((s) => round(s.target));
}
