/**
 * Flex layout analyzer.
 *
 * Implements sizing for flex items on both main and cross axes.
 *
 * Spec references:
 * - CSS Flexbox §9    Flex Layout Algorithm
 *   https://www.w3.org/TR/css-flexbox-1/#layout-algorithm
 *
 * - CSS Flexbox §9.2  Line Length Determination (flex basis, step 3)
 *   https://www.w3.org/TR/css-flexbox-1/#line-sizing
 *
 * - CSS Flexbox §9.3  Main Size Determination
 *   https://www.w3.org/TR/css-flexbox-1/#main-sizing
 *
 * - CSS Flexbox §9.5  Main-Axis Alignment (free space distribution)
 *   https://www.w3.org/TR/css-flexbox-1/#main-alignment
 *
 * - CSS Flexbox §9.7  Resolving Flexible Lengths
 *   https://www.w3.org/TR/css-flexbox-1/#resolve-flexible-lengths
 *   The freeze-and-redistribute loop for flex-grow / flex-shrink.
 *
 * - CSS Flexbox §9.4  Cross Size Determination
 *   https://www.w3.org/TR/css-flexbox-1/#cross-sizing
 *   Steps 7–11: determine each item's cross size, then the container's,
 *   then stretch items with align-self: stretch.
 *
 * - CSS Flexbox §4.5  Automatic Minimum Size of Flex Items
 *   https://www.w3.org/TR/css-flexbox-1/#min-size-auto
 *   "min-width: auto" on a flex item resolves to min-content.
 */
import type { Axis, LayoutNode, SizeFns } from "../dag";
import type { DagBuilder } from "../dag";
import type { LayoutContext } from "../types";
import { getExplicitSize, getSpecifiedValue } from "../sizing";
import { px, round, measureMinContentSize } from "../utils";

// ---------------------------------------------------------------------------
// Flex item — main axis
// ---------------------------------------------------------------------------

/**
 * Main-axis size of a flex item.
 *
 * CSS Flexbox §9.7: Resolving Flexible Lengths
 *   1. Determine each item's flex base size and hypothetical main size (§9.2 step 3–4)
 *   2. Collect free space = container content − Σ hypothetical outer sizes − gaps
 *   3. Distribute free space: grow if positive, shrink if negative
 *   4. Freeze items that hit min/max constraints, redistribute remainder
 */
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
  const basisVal = resolveBasis(fns, el, s, axis, containerContent.result, pb, depth);
  const basisNode = fns.make("flex-basis", el, axis, round(basisVal), {}, {},
    `flex-basis: ${fb} \u2192 ${round(basisVal)}px`,
    { "flex-basis": fb, [axis]: s.getPropertyValue(axis) });

  // §4.5 Automatic Minimum Size: min-width/min-height auto → min-content
  const minProp = axis === "width" ? "min-width" : "min-height";
  const minVal = s.getPropertyValue(minProp);
  const overflow = axis === "width" ? s.overflowX : s.overflowY;
  const isScroll = overflow !== "visible" && overflow !== "clip";
  let minContent: number;
  if (minVal === "auto") {
    minContent = isScroll ? 0 : measureMinContentSize(el, axis); // border-box
  } else {
    const raw = px(minVal);
    minContent = s.boxSizing === "border-box" ? raw : raw + pb;
  }
  const minContentNode = fns.make("min-content", el, axis, round(minContent), {}, {},
    minVal === "auto"
      ? (isScroll ? "0 (scroll container)" : `min-content: ${round(minContent)}px`)
      : `${minProp}: ${minVal} \u2192 ${round(minContent)}px`,
    { [minProp]: minVal, overflow });

  // §9.2 step 4: hypothetical main size = max(min-content, basis)
  // Floor min-content by irreducible padding+border (content can never be negative)
  minContent = Math.max(minContent, pb);
  const baseSize = Math.max(minContent, basisVal);
  const baseSizeNode = fns.make("flex-base-size", el, axis, round(baseSize),
    { basis: basisNode, minContent: minContentNode }, {},
    `max(${round(basisVal)}px, ${round(minContent)}px) = ${round(baseSize)}px`, {});

  // §9.3: Determine free space
  const allItems = collectFlexSiblings(fns, container, axis, depth);
  const gap = px(axis === "width" ? containerStyle.columnGap : containerStyle.rowGap);
  const totalGap = gap * Math.max(0, allItems.length - 1);
  const totalBases = allItems.reduce((sum, item) => sum + item.hypothetical + item.margin, 0);
  const freeSpace = containerContent.result - totalBases - totalGap;

  const freeSpaceNode = fns.make("flex-free-space", container, axis, round(freeSpace),
    { containerContent }, { totalItemBases: round(totalBases), totalGaps: round(totalGap) },
    `${round(containerContent.result)}px \u2212 ${round(totalBases)}px items \u2212 ${round(totalGap)}px gaps = ${round(freeSpace)}px`, {});

  // §9.7: Resolve flexible lengths
  const resolved = resolveFlexLengths(allItems, containerContent.result, totalGap);
  const idx = allItems.findIndex((item) => item.element === el);
  const distributedSize = idx >= 0 ? resolved[idx] : actualSize;
  const shareVal = round(distributedSize - baseSize);

  const grow = parseFloat(s.flexGrow) || 0;
  const shrink = parseFloat(s.flexShrink);
  const totalGrow = allItems.reduce((sum, item) => sum + item.grow, 0);

  let shareNode: LayoutNode;
  if (freeSpace > 0 && grow > 0) {
    shareNode = fns.make("flex-grow-share", el, axis, shareVal,
      { freeSpace: freeSpaceNode }, { growFactor: grow, totalGrowFactors: totalGrow },
      `${grow}/${totalGrow} \u00d7 ${round(freeSpace)}px = ${shareVal}px`,
      { "flex-grow": String(grow) });
  } else if (freeSpace < 0 && shrink > 0) {
    shareNode = fns.make("flex-shrink-share", el, axis, shareVal,
      { freeSpace: freeSpaceNode }, { shrinkFactor: shrink },
      `shrink: ${shareVal}px`, { "flex-shrink": String(shrink) });
  } else {
    shareNode = fns.make("flex-no-change", el, axis, 0, {}, { growFactor: grow },
      grow === 0 ? "flex-grow: 0 \u2192 no growth" : "no free space",
      { "flex-grow": String(grow), "flex-shrink": String(shrink) });
  }

  return b.finish({ kind: "flex-item-main", element: el, axis, result: round(distributedSize),
    inputs: { baseSize: baseSizeNode, growShare: shareNode }, literals: {},
    expr: `${round(baseSize)}px + ${shareVal}px = ${round(distributedSize)}px`,
    cssProperties: { "flex-basis": fb, "flex-grow": String(grow), "flex-shrink": String(shrink),
      [minProp]: minVal, [axis === "width" ? "max-width" : "max-height"]: s.getPropertyValue(axis === "width" ? "max-width" : "max-height") } });
}

// ---------------------------------------------------------------------------
// Flex item — cross axis
// ---------------------------------------------------------------------------

/**
 * Determine the cross-axis sizing kind without recursion.
 *
 * CSS Flexbox §9.4 step 9–11:
 *   - If the item has a definite cross size → use it
 *   - If align-self is stretch (and no definite cross size) → stretch to container
 *   - Otherwise → content-based
 */
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

/**
 * Cross-axis size of a flex item.
 *
 * CSS Flexbox §9.4 Cross Size Determination:
 *   Step 7:  Determine hypothetical cross size of each item
 *   Step 8:  Calculate cross size of each flex line (max of items)
 *   Step 9:  Handle align-content: stretch for multi-line
 *   Step 11: Determine used cross size — stretch if align-self: stretch
 */
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
  const rect = el.getBoundingClientRect();
  const size = round(axis === "width" ? rect.width : rect.height);

  const explicit = getExplicitSize(el, axis);
  if (explicit) {
    if (explicit.kind === "percentage") {
      const cbNode = fns.computeSize(ctx.containingBlock, axis, depth - 1);
      return fns.make("percentage", el, axis, size,
        { containingBlock: cbNode }, {},
        `${cbNode.result}px \u00d7 ${explicit.specifiedValue} = ${size}px`,
        { [axis]: explicit.specifiedValue });
    }
    return fns.make("explicit", el, axis, size, {}, {},
      `${s.getPropertyValue(axis)} \u2192 ${size}px`, { [axis]: s.getPropertyValue(axis) });
  }

  const alignSelf = s.alignSelf;
  const alignItems = containerStyle.alignItems;

  if (crossKind === "flex-cross-stretch") {
    const containerCross = fns.computeSize(ctx.parent, axis, depth - 1);
    return fns.make("flex-cross-stretch", el, axis, size,
      { containerCross }, {},
      `stretch \u2192 ${containerCross.result}px \u2192 ${size}px`,
      { "align-self": alignSelf, "align-items": alignItems });
  }

  const contentNode = fns.contentSize(el, axis, depth);
  return fns.make("flex-cross-content", el, axis, size,
    { content: contentNode }, {},
    `content \u2192 ${size}px`,
    { "align-self": alignSelf, "align-items": alignItems });
}

// ---------------------------------------------------------------------------
// Flex basis resolution
// ---------------------------------------------------------------------------

/**
 * Resolve flex-basis to a border-box pixel value.
 *
 * CSS Flexbox §9.2 step 3 (Determine the flex base size):
 *   A. If flex-basis is a definite length → use it (interpreted per box-sizing)
 *   B. If flex-basis is "content" or "auto" and the item has a definite
 *      main size → use that
 *   C. Otherwise → compute from content via computeIntrinsicSize
 *
 * All returned values are normalized to border-box.
 */
function resolveBasis(
  fns: SizeFns, el: Element, s: CSSStyleDeclaration, axis: Axis,
  containerContent: number, paddingBorder: number, depth: number,
): number {
  const fb = s.flexBasis;
  const isBorderBox = s.boxSizing === "border-box";

  let basis: number;
  if (fb === "0" || fb === "0px" || fb === "0%") {
    basis = 0;
  } else if (fb !== "auto" && fb !== "content" && fb.endsWith("px")) {
    const raw = parseFloat(fb);
    basis = isBorderBox ? raw : raw + paddingBorder;
  } else if (fb.endsWith("%")) {
    const raw = (parseFloat(fb) / 100) * containerContent;
    basis = isBorderBox ? raw : raw + paddingBorder;
  } else if (fb === "auto") {
    // Read the SPECIFIED value, not the computed/used value.
    // getComputedStyle returns the post-layout used value, which is wrong
    // for flex items whose size changed due to flex distribution.
    const specified = getSpecifiedValue(el, axis);
    if (specified && specified.endsWith("px")) {
      const raw = parseFloat(specified);
      basis = isBorderBox ? raw : raw + paddingBorder;
    } else if (specified && specified.endsWith("%")) {
      const raw = (parseFloat(specified) / 100) * containerContent;
      basis = isBorderBox ? raw : raw + paddingBorder;
    } else {
      // No explicit size — compute from content using our own DAG recursion
      basis = fns.computeIntrinsicSize(el, axis, depth - 1).result;
    }
  } else {
    basis = fns.computeIntrinsicSize(el, axis, depth - 1).result;
  }

  // CSS can't render negative content — floor by padding+border
  return Math.max(basis, paddingBorder);
}

// ---------------------------------------------------------------------------
// Flex sibling data collection
// ---------------------------------------------------------------------------

interface FlexSibling {
  element: Element; basis: number; hypothetical: number;
  grow: number; shrink: number; minMain: number; maxMain: number; margin: number;
  /** Padding+border on the main axis (for shrink weighting per §9.7 step 3b). */
  pb: number;
}

/** Padding + border on a given axis. */
function itemPaddingBorder(cs: CSSStyleDeclaration, axis: Axis): number {
  return axis === "width"
    ? px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth)
    : px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
}

/**
 * Collect sizing data for all flex items in a container.
 *
 * CSS Flexbox §9.2–9.3: all sizes (basis, hypothetical, min/max) are
 * normalized to border-box so the outer hypothetical main size is simply
 * hypothetical + margin.
 */
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

    // Compute basis normalized to border-box.
    // CSS values from getComputedStyle are content-box; explicit flex-basis
    // values are interpreted per box-sizing (§7.2.2).
    let basis: number;
    if (fb === "0" || fb === "0px" || fb === "0%") {
      // flex-basis: 0 nominally means 0, but CSS can't render negative
      // content, so the actual minimum border-box is always padding+border.
      basis = pb;
    } else if (fb.endsWith("px") && fb !== "auto") {
      // flex-basis: <length> — interpreted per box-sizing
      const raw = parseFloat(fb);
      basis = isBorderBox ? raw : raw + pb;
    } else if (fb.endsWith("%")) {
      const raw = (parseFloat(fb) / 100) * containerContent;
      basis = isBorderBox ? raw : raw + pb;
    } else if (fb === "auto") {
      // Read specified (authored) value, not the post-layout used value
      const specified = getSpecifiedValue(child, axis);
      if (specified && specified.endsWith("px")) {
        const raw = parseFloat(specified);
        basis = isBorderBox ? raw : raw + pb;
      } else if (specified && specified.endsWith("%")) {
        const raw = (parseFloat(specified) / 100) * containerContent;
        basis = isBorderBox ? raw : raw + pb;
      } else {
        // No explicit size — compute intrinsic (pre-flex) content-based size
        // using our own DAG computation. This avoids DOM cloning which can
        // give wrong results due to different ancestor context.
        basis = fns.computeIntrinsicSize(child, axis, depth - 1).result;
      }
    } else {
      basis = fns.computeIntrinsicSize(child, axis, depth - 1).result;
    }

    // Floor basis by padding+border (CSS can't render negative content)
    basis = Math.max(basis, pb);

    // min/max: getComputedStyle returns content-box for px values;
    // measureMinContentSize returns border-box (from getBoundingClientRect on clone)
    const minV = cs.getPropertyValue(minProp);
    const ov = axis === "width" ? cs.overflowX : cs.overflowY;
    const isScroll = ov !== "visible" && ov !== "clip";
    let minMain: number;
    if (minV === "auto") {
      minMain = isScroll ? 0 : measureMinContentSize(child, axis); // border-box
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

    // A box can never be smaller than its padding+border (CSS can't
    // render negative content). Apply this floor to minMain so the
    // freeze-and-redistribute loop in resolveFlexLengths respects it.
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

/**
 * Resolve flexible lengths via the freeze-and-redistribute algorithm.
 *
 * CSS Flexbox §9.7 — Resolving Flexible Lengths:
 *   1. Determine each item as inflexible or flexible
 *   2. Size inflexible items, calculate initial free space
 *   3. Loop: distribute remaining space by flex factors,
 *      freeze items that violate min/max, repeat until stable
 *
 * Shrink distribution is weighted by flex-shrink × flex-basis (§9.7 step 3b),
 * not by flex-shrink alone.
 */
function resolveFlexLengths(
  items: FlexSibling[], containerContent: number, totalGap: number,
): number[] {
  const state = items.map((item) => ({ frozen: false, target: item.basis }));
  // §9.7 step 1: determine grow vs shrink using outer HYPOTHETICAL main sizes
  // (clamped by min/max), not raw basis values
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
      // §9.7 step 3b: scaled flex shrink factor = flex-shrink × inner flex base size
      // "inner" = content-box (basis minus padding+border)
      const ts = unfrozen.reduce((s, i) => s + items[i].shrink * Math.max(0, items[i].basis - items[i].pb), 0);
      for (const i of unfrozen) {
        const innerBasis = Math.max(0, items[i].basis - items[i].pb);
        const r = ts > 0 ? (items[i].shrink * innerBasis) / ts : 0;
        state[i].target = items[i].basis + r * remaining;
      }
    }

    // §9.7 step 3c–d: Clamp to min/max, compute total violation, then
    // freeze ONLY items violating in the total violation's direction.
    let totalViolation = 0;
    const clamped: number[] = [];
    for (const i of unfrozen) {
      let violation = 0;
      if (state[i].target < items[i].minMain) {
        violation = items[i].minMain - state[i].target; // positive = min violation
        state[i].target = items[i].minMain;
      } else if (state[i].target > items[i].maxMain) {
        violation = items[i].maxMain - state[i].target; // negative = max violation
        state[i].target = items[i].maxMain;
      }
      if (violation !== 0) clamped.push(i);
      totalViolation += violation;
    }
    if (clamped.length === 0) break;
    // Positive total → freeze min violations; negative → freeze max violations
    for (const i of clamped) {
      const isMin = state[i].target === items[i].minMain;
      if ((totalViolation > 0 && isMin) || (totalViolation < 0 && !isMin)) {
        state[i].frozen = true;
      } else {
        // Unclamped — restore to pre-clamp target for next iteration.
        // The basis will be used again in the next iteration's distribution.
      }
    }
  }

  return state.map((s) => round(s.target));
}
