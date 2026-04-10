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
import type { Axis, LayoutNode, CalcExpr } from "../types";
import type { NodeBuilder } from "../node-builder";
import { ElementProxy } from "../element-proxy";
import { ref, constant, prop, propVal, measured, add, sub, mul, cmax, cmin } from "../calc";
import { PX } from "../units";
import { px, round, resolveCssLength } from "../utils";
import { measureMinContentSize, measureIntrinsicSize } from "../measure";

// ---------------------------------------------------------------------------
// Flex item — main axis
// ---------------------------------------------------------------------------

export function flexItemMain(
  nb: NodeBuilder, axis: Axis,
): void {
  const el = nb.element;

  const parent = nb.proxy.getLayoutParent();
  const container = parent.element;
  const containerBorderBox = nb.computeSize(container, axis);
  const containerContent = nb.containerContentArea(container, axis, containerBorderBox);

  // Build sibling data — each child's measurements are their own LayoutNodes.
  // For the target element, use nb.proxy so reads are recorded on this node.
  const flexChildren = parent.getFlexChildren();
  const siblings = flexChildren.map(childProxy =>
    buildFlexChildData(nb, childProxy.element === el ? nb.proxy : childProxy, axis, containerContent.result),
  );
  // Anonymous flex items come from text content inside display:contents
  // wrappers (or directly inside the flex container). They have default
  // flex values: grow 0, shrink 1, no margin/padding. min-width: auto for
  // anonymous text items resolves to min-content (longest word).
  //
  // For column flex, the anon text wraps at the container's cross (width)
  // size, so we pass the cross content size as the wrap width.
  const crossAxis: Axis = axis === "width" ? "height" : "width";
  const crossForAnon = axis === "width"
    ? 0
    : nb.containerContentArea(container, crossAxis, nb.computeSize(container, crossAxis)).result;
  const anonMeasured = parent.getAnonymousFlexItems(axis, crossForAnon);
  const anonItems: FlexItem[] = anonMeasured.map(({ basis, minContent }) => ({
    element: container, basis, hypothetical: Math.max(minContent, basis),
    grow: 0, shrink: 1, minMain: minContent, maxMain: Infinity, margin: 0, pb: 0,
  }));

  // Main-axis gap: column-gap for row direction, row-gap for column direction
  const direction = parent.readProperty("flex-direction");
  const gapPropName = direction.startsWith("column") ? "row-gap" as const : "column-gap" as const;
  const gap = parent.readPx(gapPropName);

  // Find the target in siblings (anonymous items come after and can't match).
  const idx = siblings.findIndex(s => s.element === el);
  const target = idx >= 0 ? siblings[idx] : null;

  const baseSizeNode = target?.hypoNode ?? nb.create(`flex-base-size:${axis}`, el, (n) => {
    n.setMode("flex-base-size")
      .describe("Effective starting size")
      .calc(nb.borderBoxCalc(nb.proxy, axis));
  });
  const totalItemCount = siblings.length + anonItems.length;
  const totalBases = siblings.reduce((sum, s) => sum + s.hypothetical + s.margin, 0)
    + anonItems.reduce((sum, a) => sum + a.hypothetical, 0);
  const totalGap = gap * Math.max(0, totalItemCount - 1);
  const freeSpace = containerContent.result - totalBases - totalGap;

  // Resolve flex lengths (iterative freeze-and-redistribute algorithm).
  // Anonymous items are appended so the target's index in siblings matches its
  // index in the merged list.
  const allItems: FlexItem[] = [
    ...siblings.map(s => ({
      element: s.element, basis: s.basis, hypothetical: s.hypothetical,
      grow: s.grow, shrink: s.shrink, minMain: s.minMain, maxMain: s.maxMain,
      margin: s.margin, pb: s.pb,
    })),
    ...anonItems,
  ];
  const resolved = resolveFlexLengths(allItems, containerContent.result, totalGap);
  const myResult = idx >= 0 ? resolved[idx] : null;

  if (!myResult || !target) {
    // Element not found among siblings — use measured size
    nb.describe(`Flex item \u2014 ${axis} determined by the flex layout algorithm`)
      .calc(nb.borderBoxCalc(nb.proxy, axis));
    return;
  }

  if (myResult.frozen) {
    const reason = myResult.frozenReason === "hypothetical" ? "base size"
      : myResult.frozenReason === "min" ? "minimum constraint"
      : "maximum constraint";
    nb.describe(`Flex item \u2014 ${axis} frozen at ${reason}`)
      .calc(propVal(axis, myResult.target))
      .input("baseSize", baseSizeNode);
    return;
  }

  // Unfrozen: express as basis + (factor/totalFactor) × finalRemaining.
  // The final iteration's remaining space accounts for all frozen items.
  const lastTerm = myResult.shareTerms[myResult.shareTerms.length - 1];
  const growing = freeSpace > 0;

  // Build final free space node using exact per-item used values.
  const finalUsedTerms: CalcExpr[] = [];
  const finalUsedInputs: LayoutNode["inputs"] = { containerContent };
  for (let i = 0; i < siblings.length; i++) {
    const s = siblings[i];
    const usedSize = resolved[i].frozen ? resolved[i].target : s.basis;
    finalUsedTerms.push(propVal("flex-basis", usedSize + s.margin));
  }
  for (let i = 0; i < anonItems.length; i++) {
    const a = anonItems[i];
    const r = resolved[siblings.length + i];
    const usedSize = r.frozen ? r.target : a.basis;
    finalUsedTerms.push(propVal("flex-basis", usedSize));
  }
  if (totalItemCount > 1 && gap > 0) {
    for (let gi = 0; gi < totalItemCount - 1; gi++) {
      finalUsedTerms.push(prop(parent, gapPropName));
    }
  }

  const finalFreeNode = nb.create(`flex-free-space:${axis}`, container, (n) => {
    n.setMode("flex-free-space")
      .describe("Remaining space in the final flex iteration")
      .calc(sub(ref(containerContent), add(...finalUsedTerms)))
      .inputs(finalUsedInputs);
  });

  // Collect unfrozen factor nodes
  const unfrozenFactorNodes: LayoutNode[] = [];
  for (let i = 0; i < siblings.length; i++) {
    if (!resolved[i].frozen) {
      const factorNode = growing ? siblings[i].growNode : siblings[i].scaledShrinkNode;
      if (factorNode) unfrozenFactorNodes.push(factorNode);
    }
  }

  const shareInputs: LayoutNode["inputs"] = { freeSpace: finalFreeNode };
  unfrozenFactorNodes.forEach((n, i) => { shareInputs[`factor${i}`] = n; });

  // Use the exact ratio from the algorithm (not CalcExpr-evaluated values which may round differently)
  const shareNode = nb.create(`flex-share:${axis}`, el, (n) => {
    n.setMode(growing ? "flex-grow-share" : "flex-shrink-share")
      .describe(growing ? "Portion of remaining space allocated by flex-grow" : "Amount this item shrinks to fit")
      .calc(lastTerm.share !== 0
        ? propVal("flex-basis", round(lastTerm.share))
        : constant(0, PX))
      .inputs(shareInputs);
  });

  nb.describe(`Flex item \u2014 ${axis} determined by the flex layout algorithm`)
    .calc(add(propVal("flex-basis", target.basis), ref(shareNode)))
    .inputs({ baseSize: baseSizeNode, share: shareNode });
}

// ---------------------------------------------------------------------------
// Flex item — cross axis
// ---------------------------------------------------------------------------

export function flexItemCross(
  nb: NodeBuilder, axis: Axis,
): void {
  const el = nb.element;
  const parent = nb.proxy.getLayoutParent();

  if (nb.proxy.getExplicitSize(axis)) {
    const explicit = nb.proxy.getExplicitSize(axis)!;
    if (explicit.kind === "percentage") {
      const cb = nb.proxy.getContainingBlock();
      const cbNode = nb.computeSize(cb.element, axis);
      nb.setMode("percentage");
      nb.describe(`${axis} is a percentage of the containing block`)
        .calc(nb.borderBoxCalc(nb.proxy, axis))
        .input("containingBlock", cbNode);
      return;
    }
    nb.setMode("explicit");
    nb.describe(`${axis} is set explicitly in CSS`)
      .calc(nb.borderBoxCalc(nb.proxy, axis));
    return;
  }

  const alignSelf = nb.css("align-self");
  const alignItems = parent.readProperty("align-items");
  const effectiveAlign = (alignSelf === "auto" || alignSelf === "normal") ? alignItems : alignSelf;
  const isStretch = effectiveAlign === "stretch" || effectiveAlign === "normal";

  if (!isStretch) {
    // flex-cross-content: size from content
    const contentNode = nb.computeIntrinsicSize(el, axis);
    nb.describe(`Flex item \u2014 cross ${axis} sized by content (align: ${effectiveAlign})`)
      .calc(ref(contentNode))
      .input("content", contentNode);
    return;
  }

  // Per CSS Flexbox §9.4: stretched cross size = container content area - item margins
  const containerCross = nb.computeSize(parent.element, axis);
  const containerContent = nb.containerContentArea(parent.element, axis, containerCross);
  const [mStart, mEnd] = axis === "width"
    ? ["margin-left", "margin-right"] as const
    : ["margin-top", "margin-bottom"] as const;
  nb.describe("Flex item stretches on the cross axis to fill the container")
    .calc(sub(ref(containerContent), add(nb.prop(mStart), nb.prop(mEnd))))
    .input("containerContent", containerContent);
}

// ---------------------------------------------------------------------------
// Per-child flex data — each child's measurements are LayoutNodes
// ---------------------------------------------------------------------------

interface FlexChildData {
  element: Element;
  basis: number;
  hypothetical: number;
  grow: number;
  shrink: number;
  minMain: number;
  maxMain: number;
  margin: number;
  pb: number;
  basisNode: LayoutNode;
  hypoNode: LayoutNode;
  outerNode: LayoutNode;
  growNode: LayoutNode | null;
  scaledShrinkNode: LayoutNode | null;
}

function buildFlexChildData(
  parentNb: NodeBuilder, childProxy: ElementProxy, axis: Axis,
  containerContentPx: number,
): FlexChildData {
  const child = childProxy.element;
  const minPropName = axis === "width" ? "min-width" : "min-height";
  const maxPropName = axis === "width" ? "max-width" : "max-height";

  // Read child properties via proxy (tracked)
  const pb = itemPaddingBorder(childProxy, axis);
  const isBorderBox = childProxy.readProperty("box-sizing") === "border-box";
  const fb = childProxy.readProperty("flex-basis");

  // The flex algorithm uses border-box sizes for consistency. For
  // content-box elements, wrap an inner value (from prop/propVal) with the
  // padding+border terms so the stored calc matches the border-box value
  // used in arithmetic.
  const pbNames = axis === "width"
    ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
    : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
  const wrapWithPb = (inner: CalcExpr): CalcExpr =>
    isBorderBox ? inner : add(inner, ...pbNames.map(p => prop(childProxy, p)));

  // --- Basis ---
  let basis: number;
  let basisCalc: CalcExpr;
  if (fb === "0" || fb === "0px" || fb === "0%") {
    basis = pb;
    basisCalc = wrapWithPb(propVal("flex-basis", 0));
  } else if (fb === "auto") {
    const specified = childProxy.getSpecifiedValue(axis);
    const specifiedPx = specified ? resolveCssLength(specified, containerContentPx) : null;
    if (specifiedPx !== null) {
      basis = isBorderBox ? specifiedPx : specifiedPx + pb;
      basisCalc = wrapWithPb(propVal(axis, round(specifiedPx)));
    } else if (specified === "min-content") {
      // Intrinsic keyword — measure min-content directly.
      basis = measureMinContentSize(child, axis);
      basisCalc = measured("min-content", basis);
    } else {
      basis = parentNb.computeIntrinsicSize(child, axis).result;
      basisCalc = ref(parentNb.computeIntrinsicSize(child, axis));
    }
  } else if (fb.endsWith("px")) {
    const raw = parseFloat(fb);
    basis = isBorderBox ? raw : raw + pb;
    basisCalc = wrapWithPb(prop(childProxy, "flex-basis"));
  } else if (fb === "content") {
    // flex-basis: content bypasses the element's width/height property and
    // uses the content-based size. Measure directly so we don't get fooled by
    // an explicit height on the item itself, and ignore aspect-ratio so we
    // get the true content-based size rather than an aspect-ratio transfer.
    basis = round(measureIntrinsicSize(child, axis, true));
    basisCalc = measured("content", basis);
  } else {
    const resolved = resolveCssLength(fb, containerContentPx);
    if (resolved !== null) {
      basis = isBorderBox ? resolved : resolved + pb;
      basisCalc = wrapWithPb(propVal("flex-basis", round(resolved)));
    } else {
      basis = parentNb.computeIntrinsicSize(child, axis).result;
      basisCalc = ref(parentNb.computeIntrinsicSize(child, axis));
    }
  }
  basis = Math.max(basis, pb);

  const basisNode = parentNb.create(`flex-basis:${axis}`, child, (n) => {
    n.setMode("flex-basis")
      .describe("Starting size before flex grow/shrink")
      .calc(basisCalc);
  });

  // --- Max main ---
  const maxV = childProxy.readProperty(maxPropName);
  let maxMain: number;
  if (maxV === "none") {
    maxMain = Infinity;
  } else {
    const resolved = resolveCssLength(maxV, containerContentPx);
    if (resolved === null) {
      maxMain = Infinity;
    } else {
      maxMain = isBorderBox ? resolved : resolved + pb;
    }
  }

  // --- Min main ---
  const minV = childProxy.readProperty(minPropName);
  const ov = childProxy.readProperty(axis === "width" ? "overflow-x" : "overflow-y");
  const isScroll = ov !== "visible" && ov !== "clip";
  let minMain: number;
  let minCalc: CalcExpr;
  if (minV === "auto") {
    if (isScroll) {
      minMain = 0;
      minCalc = constant(0, PX);
    } else {
      // Aspect-ratio transfer for min-content only applies when there are no
      // element children. For containers, the measured min-content is used.
      const arVal = childProxy.readProperty("aspect-ratio");
      const otherAxis: Axis = axis === "width" ? "height" : "width";
      const otherVal = childProxy.readProperty(otherAxis);
      const hasKids = child.children.length > 0;
      if (!hasKids && arVal && arVal !== "auto" && otherVal && parseFloat(otherVal) > 0) {
        const arMatch = arVal.match(/^([\d.]+)\s*(?:\/\s*([\d.]+))?$/);
        if (arMatch) {
          const ratio = parseFloat(arMatch[1]) / (arMatch[2] ? parseFloat(arMatch[2]) : 1);
          const otherPx = parseFloat(otherVal);
          const transferred = axis === "width" ? otherPx * ratio : otherPx / ratio;
          minMain = isBorderBox ? transferred : transferred + pb;
          minCalc = measured("min-content (aspect-ratio)", minMain);
        } else {
          minMain = measureMinContentSize(child, axis);
          minCalc = measured("min-content", minMain);
        }
      } else {
        minMain = measureMinContentSize(child, axis);
        minCalc = measured("min-content", minMain);
      }
      const specified = childProxy.getSpecifiedValue(axis);
      if (specified) {
        // Per CSS Flexbox §4.5: the specified size suggestion is the computed
        // main size property if definite. Percentages resolve against the
        // flex container content area.
        const specPx = resolveCssLength(specified, containerContentPx);
        if (specPx !== null) {
          const specBB = isBorderBox ? specPx : specPx + pb;
          if (specBB < minMain) {
            minMain = specBB;
            minCalc = propVal(axis, round(specPx));
          }
        }
      }
      if (maxMain !== Infinity && maxMain < minMain) {
        minMain = maxMain;
      }
    }
  } else if (minV.endsWith("px")) {
    const raw = px(minV);
    minMain = isBorderBox ? raw : raw + pb;
    if (isBorderBox) {
      minCalc = prop(childProxy, minPropName);
    } else {
      const pbNames = axis === "width"
        ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
        : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
      minCalc = add(prop(childProxy, minPropName), ...pbNames.map(p => prop(childProxy, p)));
    }
  } else {
    const resolved = resolveCssLength(minV, containerContentPx);
    if (resolved !== null) {
      minMain = isBorderBox ? resolved : resolved + pb;
      minCalc = propVal(minPropName, round(minMain));
    } else {
      minMain = 0;
      minCalc = constant(0, PX);
    }
  }
  minMain = Math.max(minMain, pb);
  const minNode = parentNb.create(`min-content:${axis}`, child, (n) => {
    n.setMode(minV === "auto" ? "min-content-auto" : "min-content-explicit")
      .describe(minV === "auto" ? `Minimum ${axis} from content` : `${minPropName} constraint`)
      .calc(minCalc);
  });

  // --- Hypothetical: max(min, min(max, basis)) ---
  const hypothetical = Math.max(minMain, Math.min(maxMain, basis));
  let hypoCalc: CalcExpr;
  if (maxMain === Infinity) {
    hypoCalc = cmax(ref(minNode), ref(basisNode));
  } else {
    let maxCalc: CalcExpr;
    if (isBorderBox) {
      maxCalc = prop(childProxy, maxPropName);
    } else {
      const pbNames = axis === "width"
        ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
        : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
      maxCalc = add(prop(childProxy, maxPropName), ...pbNames.map(p => prop(childProxy, p)));
    }
    const maxNode = parentNb.create(`max-constraint:${axis}`, child, (n) => {
      n.setMode("clamped")
        .describe(`${maxPropName} constraint`).calc(maxCalc);
    });
    hypoCalc = cmax(ref(minNode), cmin(ref(maxNode), ref(basisNode)));
  }
  const hypoNode = parentNb.create(`flex-base-size:${axis}`, child, (n) => {
    n.setMode("flex-base-size")
      .describe("Hypothetical main size (basis clamped by min/max)")
      .calc(hypoCalc).inputs({ basis: basisNode, minContent: minNode });
  });

  // --- Margin + outer hypothetical ---
  const [mStartName, mEndName] = axis === "width"
    ? ["margin-left", "margin-right"] as const
    : ["margin-top", "margin-bottom"] as const;
  const mStart = childProxy.readPx(mStartName);
  const mEnd = childProxy.readPx(mEndName);
  const margin = mStart + mEnd;

  const outerCalc = margin > 0
    ? add(ref(hypoNode), prop(childProxy, mStartName), prop(childProxy, mEndName))
    : ref(hypoNode);
  const outerNode = parentNb.create(`flex-outer-hypo:${axis}`, child, (n) => {
    n.setMode("flex-outer-hypo")
      .describe("Outer hypothetical size (including margins)")
      .calc(outerCalc).input("hypothetical", hypoNode);
  });

  // --- Grow factor node ---
  const growVal = parseFloat(childProxy.readProperty("flex-grow")) || 0;
  const growNode = growVal > 0
    ? parentNb.create(`flex-grow-factor:${axis}`, child, (n) => {
        n.setMode("flex-grow-factor")
          .describe("flex-grow factor").calc(prop(childProxy, "flex-grow"));
      })
    : null;

  // --- Scaled shrink factor ---
  const shrinkVal = parseFloat(childProxy.readProperty("flex-shrink"));
  const pbProps = axis === "width"
    ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
    : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
  const innerBasisCalc = cmax(constant(0, PX), sub(ref(basisNode), add(...pbProps.map(p => prop(childProxy, p)))));
  const scaledShrinkNode = shrinkVal > 0
    ? parentNb.create(`flex-shrink-factor:${axis}`, child, (n) => {
        n.setMode("flex-scaled-shrink")
          .describe("Scaled shrink factor (flex-shrink \u00d7 inner basis)")
          .calc(mul(prop(childProxy, "flex-shrink"), innerBasisCalc))
          .input("basis", basisNode);
      })
    : null;

  return {
    element: child, basis, hypothetical, grow: growVal, shrink: shrinkVal,
    minMain, maxMain, margin, pb,
    basisNode, hypoNode, outerNode, growNode, scaledShrinkNode,
  };
}

function itemPaddingBorder(proxy: ElementProxy, axis: Axis): number {
  return axis === "width"
    ? proxy.readPx("padding-left") + proxy.readPx("padding-right") +
      proxy.readPx("border-left-width") + proxy.readPx("border-right-width")
    : proxy.readPx("padding-top") + proxy.readPx("padding-bottom") +
      proxy.readPx("border-top-width") + proxy.readPx("border-bottom-width");
}

// ---------------------------------------------------------------------------
// Flex length resolution (freeze-and-redistribute)
// ---------------------------------------------------------------------------

interface FlexItem {
  element: Element; basis: number; hypothetical: number;
  grow: number; shrink: number; minMain: number; maxMain: number; margin: number;
  pb: number;
}

type FrozenReason = "none" | "hypothetical" | "min" | "max";

/** Per-iteration share contribution for an unfrozen item. */
interface ShareTerm {
  /** This item's factor ratio (myFactor / totalFactors) for this iteration. */
  ratio: number;
  /** The remaining space distributed in this iteration. */
  remaining: number;
  /** This item's share = ratio × remaining. */
  share: number;
}

interface FlexResolveResult {
  target: number;
  frozen: boolean;
  frozenReason: FrozenReason;
  /** Per-iteration share terms (empty for frozen items). */
  shareTerms: ShareTerm[];
}

function resolveFlexLengths(
  items: FlexItem[], containerContent: number, totalGap: number,
): FlexResolveResult[] {
  const state: FlexResolveResult[] = items.map(() => ({
    frozen: false, target: 0, frozenReason: "none" as FrozenReason,
    shareTerms: [],
  }));
  const totalHypo = items.reduce((s, i) => s + i.hypothetical + i.margin, 0);
  const growing = containerContent - totalHypo - totalGap > 0;

  for (let i = 0; i < items.length; i++) {
    const factor = growing ? items[i].grow : items[i].shrink;
    if (factor === 0 || (growing && items[i].basis > items[i].hypothetical) ||
        (!growing && items[i].basis < items[i].hypothetical)) {
      state[i].target = items[i].hypothetical;
      state[i].frozen = true;
      state[i].frozenReason = "hypothetical";
    }
  }

  for (let iter = 0; iter < 20; iter++) {
    const unfrozen = state.map((s, i) => s.frozen ? -1 : i).filter((i) => i >= 0);
    if (unfrozen.length === 0) break;

    // Per CSS Flexbox §9.7 step 4b: for frozen items, use their outer target
    // main size; for others, use their outer flex base size.
    const used = state.reduce((s, st, i) => s + (st.frozen ? st.target : items[i].basis) + items[i].margin, 0);
    const remaining = containerContent - used - totalGap;

    if (growing) {
      const tg = unfrozen.reduce((s, i) => s + items[i].grow, 0);
      for (const i of unfrozen) {
        const ratio = tg > 0 ? items[i].grow / tg : 0;
        const share = ratio * remaining;
        state[i].target = items[i].basis + share;
        state[i].shareTerms.push({ ratio, remaining, share });
      }
    } else {
      const ts = unfrozen.reduce((s, i) => s + items[i].shrink * Math.max(0, items[i].basis - items[i].pb), 0);
      for (const i of unfrozen) {
        const innerBasis = Math.max(0, items[i].basis - items[i].pb);
        const ratio = ts > 0 ? (items[i].shrink * innerBasis) / ts : 0;
        const share = ratio * remaining;
        state[i].target = items[i].basis + share;
        state[i].shareTerms.push({ ratio, remaining, share });
      }
    }

    let totalViolation = 0;
    const clamped: number[] = [];
    for (const i of unfrozen) {
      let violation = 0;
      if (state[i].target < items[i].minMain) {
        violation = items[i].minMain - state[i].target;
        state[i].target = items[i].minMain;
        state[i].frozenReason = "min";
      } else if (state[i].target > items[i].maxMain) {
        violation = items[i].maxMain - state[i].target;
        state[i].target = items[i].maxMain;
        state[i].frozenReason = "max";
      }
      if (violation !== 0) clamped.push(i);
      totalViolation += violation;
    }
    if (clamped.length === 0) break;
    for (const i of clamped) {
      const isMin = state[i].target === items[i].minMain;
      if ((totalViolation > 0 && isMin) || (totalViolation < 0 && !isMin)) {
        state[i].frozen = true;
        // Clear share terms for frozen items — they don't get shares
        state[i].shareTerms = [];
      } else {
        state[i].frozenReason = "none";
      }
    }
  }

  for (const s of state) s.target = round(s.target);
  return state;
}
