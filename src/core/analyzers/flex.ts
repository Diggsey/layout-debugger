/**
 * Flex layout analyzer.
 *
 * Spec references:
 * - CSS Flexbox §9    Flex Layout Algorithm
 * - CSS Flexbox §9.2  Line Length Determination (flex basis, step 3)
 * - CSS Flexbox §9.3  Main Size Determination
 * - CSS Flexbox §9.5  Main-Axis Alignment (free space distribution)
 * - CSS Flexbox §9.7  Resolving Flexible Lengths
 * - CSS Flexbox §9.4  Cross Size Determination
 * - CSS Flexbox §4.5  Automatic Minimum Size of Flex Items
 */
import type { Axis, LayoutNode, SizeFns, CalcExpr } from "../dag";
import type { DagBuilder } from "../dag";
import { ref, constant, prop, add, sub, mul, div, cmax } from "../dag";
import type { LayoutContext } from "../types";
import { getExplicitSize, getSpecifiedValue } from "../sizing";
import { px, round, measureMinContentSize } from "../utils";

// ---------------------------------------------------------------------------
// Flex item — main axis
// ---------------------------------------------------------------------------

export function flexItemMain(
  fns: SizeFns, b: DagBuilder, el: Element, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const existing = b.get("flex-item-main", el, axis);
  if (existing) return existing;
  b.begin("flex-item-main", el, axis);

  const container = ctx.parent;
  const containerStyle = getComputedStyle(container);
  const rect = el.getBoundingClientRect();
  const actualSize = round(axis === "width" ? rect.width : rect.height);

  const containerBorderBox = fns.computeSize(container, axis, depth - 1);
  const containerContent = fns.containerContentArea(container, axis, containerBorderBox);

  const s = getComputedStyle(el);
  const fb = s.flexBasis;
  const pb = itemPaddingBorder(s, axis);
  // flex-basis: the CalcExpr reads the relevant CSS property
  let basisCalc: CalcExpr;
  if (fb !== "auto" && fb !== "content") {
    basisCalc = prop(el, "flex-basis");
  } else {
    basisCalc = prop(el, axis); // auto → falls back to width/height
  }
  const basisNode = fns.make("flex-basis", el, axis,
    `Starting size before flex grow/shrink is applied`,
    basisCalc, {});

  // §4.5 Automatic Minimum Size
  const minPropName = axis === "width" ? "min-width" : "min-height";
  const minVal = s.getPropertyValue(minPropName);
  const overflow = axis === "width" ? s.overflowX : s.overflowY;
  const isScroll = overflow !== "visible" && overflow !== "clip";
  let minContent: number;
  if (minVal === "auto") {
    minContent = isScroll ? 0 : measureMinContentSize(el, axis);
  } else {
    const raw = px(minVal);
    minContent = s.boxSizing === "border-box" ? raw : raw + pb;
  }
  minContent = Math.max(minContent, pb);
  let minContentCalc: CalcExpr;
  if (minVal === "auto") {
    // min-content: measured from the element's content (not a CSS property)
    minContentCalc = isScroll ? constant(0) : ({ op: "property", name: `min-content-${axis}`, value: minContent });
  } else {
    minContentCalc = prop(el, minPropName);
  }
  const minContentNode = fns.make("min-content", el, axis,
    minVal === "auto"
      ? (isScroll ? `Minimum ${axis} is 0 (scroll container)` : `Minimum ${axis} the element can be without overflowing`)
      : `${minPropName} constraint`,
    minContentCalc, {});

  // §9.2 step 4: hypothetical main size
  const baseSizeNode = fns.make("flex-base-size", el, axis,
    `Effective starting size \u2014 the larger of the basis and min-content`,
    cmax(ref(basisNode), ref(minContentNode)),
    { basis: basisNode, minContent: minContentNode }, {});

  // §9.3: Determine free space — build sibling hypothetical nodes for CalcExpr
  const allItems = collectFlexSiblings(fns, container, axis, depth);
  const gap = px(axis === "width" ? containerStyle.columnGap : containerStyle.rowGap);
  const totalGap = gap * Math.max(0, allItems.length - 1);
  const totalBases = allItems.reduce((sum, item) => sum + item.hypothetical + item.margin, 0);
  const freeSpace = containerContent.result - totalBases - totalGap;

  // Build free-space CalcExpr: containerContent - Σ(sibling hypotheticals) - gaps
  const gapPropName = axis === "width" ? "column-gap" : "row-gap";
  const siblingTerms: CalcExpr[] = allItems.map(item =>
    ({ op: "property", name: axis, value: item.hypothetical + item.margin }) as CalcExpr);
  if (totalGap > 0) {
    for (let gi = 0; gi < allItems.length - 1; gi++) {
      siblingTerms.push(prop(container, gapPropName));
    }
  }
  const freeSpaceNode = fns.make("flex-free-space", container, axis,
    `Space remaining after all items are placed at their base size`,
    sub(ref(containerContent), add(...siblingTerms)),
    { containerContent }, {});

  // §9.7: Resolve flexible lengths
  const resolved = resolveFlexLengths(allItems, containerContent.result, totalGap);
  const idx = allItems.findIndex((item) => item.element === el);
  const distributedSize = idx >= 0 ? resolved[idx] : actualSize;

  const grow = parseFloat(s.flexGrow) || 0;
  const shrink = parseFloat(s.flexShrink);

  // Build grow/shrink share nodes with sibling aggregation in CalcExpr
  let shareNode: LayoutNode;
  let shareCalc: CalcExpr;
  if (freeSpace > 0 && grow > 0) {
    // Grow share = (my flex-grow / Σ siblings' flex-grow) × free-space
    const siblingGrows = allItems.filter(i => i.grow > 0).map(i =>
      ({ op: "property", name: "flex-grow", value: i.grow }) as CalcExpr);
    shareCalc = mul(div(prop(el, "flex-grow"), add(...siblingGrows)), ref(freeSpaceNode));
    shareNode = fns.make("flex-grow-share", el, axis,
      `Portion of free space allocated to this item by flex-grow`,
      shareCalc, { freeSpace: freeSpaceNode });
  } else if (freeSpace < 0 && shrink > 0) {
    // Shrink share is complex (weighted by inner basis) — express as property read
    shareCalc = prop(el, "flex-shrink");
    shareNode = fns.make("flex-shrink-share", el, axis,
      `Amount this item shrinks to fit in the container`,
      shareCalc, { freeSpace: freeSpaceNode });
  } else {
    shareCalc = constant(0);
    shareNode = fns.make("flex-no-change", el, axis,
      grow === 0 ? "This item does not grow or shrink" : "No free space to distribute",
      shareCalc, {});
  }

  const calc = add(ref(baseSizeNode), ref(shareNode));

  return b.finish({ kind: "flex-item-main", element: el, axis,
    result: round(distributedSize),
    description: `Flex item \u2014 ${axis} determined by the flex layout algorithm`,
    calc,
    inputs: { baseSize: baseSizeNode, growShare: shareNode },
    cssProperties: { "flex-basis": fb, "flex-grow": String(grow), "flex-shrink": String(shrink),
      [minPropName]: minVal, [axis === "width" ? "max-width" : "max-height"]: s.getPropertyValue(axis === "width" ? "max-width" : "max-height") } });
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
  fns: SizeFns, b: DagBuilder, el: Element, axis: Axis,
  ctx: LayoutContext, depth: number,
): LayoutNode {
  const crossKind = determineFlexCrossKind(el, axis, ctx);

  const cached = b.get(crossKind, el, axis);
  if (cached) return cached;
  if (b.isBuilding(crossKind, el, axis)) return fns.measured(el, axis, "terminal");

  const s = getComputedStyle(el);
  const containerStyle = getComputedStyle(ctx.parent);
  const explicit = getExplicitSize(el, axis);
  if (explicit) {
    if (explicit.kind === "percentage") {
      const cbNode = fns.computeSize(ctx.containingBlock, axis, depth - 1);
      return fns.make("percentage", el, axis,
        `${axis} is a percentage of the containing block`,
        fns.borderBoxCalc(el, axis),
        { containingBlock: cbNode });
    }
    return fns.make("explicit", el, axis,
      `${axis} is set explicitly in CSS`,
      fns.borderBoxCalc(el, axis), {});
  }

  const alignSelf = s.alignSelf;
  const alignItems = containerStyle.alignItems;

  if (crossKind === "flex-cross-stretch") {
    const containerCross = fns.computeSize(ctx.parent, axis, depth - 1);
    return fns.make("flex-cross-stretch", el, axis,
      `Flex item stretches on the cross axis to fill the container`,
      fns.borderBoxCalc(el, axis),
      { containerCross },
      { "align-self": alignSelf, "align-items": alignItems });
  }

  const contentNode = fns.contentSize(el, axis, depth);
  return fns.make("flex-cross-content", el, axis,
    `Flex item cross-axis size is determined by its content`,
    ref(contentNode),
    { content: contentNode },
    { "align-self": alignSelf, "align-items": alignItems });
}

// ---------------------------------------------------------------------------
// Flex sibling data collection
// ---------------------------------------------------------------------------

interface FlexSibling {
  element: Element; basis: number; hypothetical: number;
  grow: number; shrink: number; minMain: number; maxMain: number; margin: number;
  pb: number;
}

function itemPaddingBorder(cs: CSSStyleDeclaration, axis: Axis): number {
  return axis === "width"
    ? px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth)
    : px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
}

function collectFlexSiblings(
  fns: SizeFns, container: Element, axis: Axis, depth: number,
): FlexSibling[] {
  const minProp = axis === "width" ? "min-width" : "min-height";
  const maxProp = axis === "width" ? "max-width" : "max-height";
  const containerStyle = getComputedStyle(container);
  const containerRect = container.getBoundingClientRect();
  const containerBB = axis === "width" ? containerRect.width : containerRect.height;
  const pad = axis === "width"
    ? px(containerStyle.paddingLeft) + px(containerStyle.borderLeftWidth) +
      px(containerStyle.paddingRight) + px(containerStyle.borderRightWidth)
    : px(containerStyle.paddingTop) + px(containerStyle.borderTopWidth) +
      px(containerStyle.paddingBottom) + px(containerStyle.borderBottomWidth);
  const containerContent = containerBB - pad;

  const items: FlexSibling[] = [];
  for (const child of Array.from(container.children)) {
    const cs = getComputedStyle(child);
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    if (cs.display === "contents") continue;

    const pb = itemPaddingBorder(cs, axis);
    const isBorderBox = cs.boxSizing === "border-box";
    const fb = cs.flexBasis;

    let basis: number;
    if (fb === "0" || fb === "0px" || fb === "0%") {
      basis = pb;
    } else if (fb.endsWith("px") && fb !== "auto") {
      const raw = parseFloat(fb);
      basis = isBorderBox ? raw : raw + pb;
    } else if (fb.endsWith("%")) {
      const raw = (parseFloat(fb) / 100) * containerContent;
      basis = isBorderBox ? raw : raw + pb;
    } else if (fb === "auto") {
      const specified = getSpecifiedValue(child, axis);
      if (specified && specified.endsWith("px")) {
        const raw = parseFloat(specified);
        basis = isBorderBox ? raw : raw + pb;
      } else if (specified && specified.endsWith("%")) {
        const raw = (parseFloat(specified) / 100) * containerContent;
        basis = isBorderBox ? raw : raw + pb;
      } else {
        basis = fns.computeIntrinsicSize(child, axis, depth - 1).result;
      }
    } else {
      basis = fns.computeIntrinsicSize(child, axis, depth - 1).result;
    }

    basis = Math.max(basis, pb);

    const minV = cs.getPropertyValue(minProp);
    const ov = axis === "width" ? cs.overflowX : cs.overflowY;
    const isScroll = ov !== "visible" && ov !== "clip";
    let minMain: number;
    if (minV === "auto") {
      minMain = isScroll ? 0 : measureMinContentSize(child, axis);
    } else {
      const raw = px(minV);
      minMain = cs.boxSizing === "border-box" ? raw : raw + pb;
    }
    const maxV = cs.getPropertyValue(maxProp);
    let maxMain: number;
    if (maxV === "none") {
      maxMain = Infinity;
    } else {
      const raw = px(maxV);
      maxMain = cs.boxSizing === "border-box" ? raw : raw + pb;
    }

    minMain = Math.max(minMain, pb);
    const hypothetical = Math.max(minMain, Math.min(maxMain, basis));

    const mStart = axis === "width" ? px(cs.marginLeft) : px(cs.marginTop);
    const mEnd = axis === "width" ? px(cs.marginRight) : px(cs.marginBottom);

    items.push({ element: child, basis, hypothetical, grow: parseFloat(cs.flexGrow) || 0,
      shrink: parseFloat(cs.flexShrink), minMain, maxMain, margin: mStart + mEnd, pb });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Flex length resolution (freeze-and-redistribute)
// ---------------------------------------------------------------------------

function resolveFlexLengths(
  items: FlexSibling[], containerContent: number, totalGap: number,
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
