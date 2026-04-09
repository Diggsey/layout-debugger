/**
 * Seeded random generator for LayoutSpec trees.
 *
 * Uses scenario-based generation: each node picks a layout scenario
 * (flex-row, grid, block, positioned, etc.) so generated layouts exercise
 * real layout code paths rather than random CSS noise.
 */
import type { LayoutSpec, GenerateOpts } from "./format";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Random integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Pick a random element from an array. */
  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  /** Return true with the given probability (0–1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Pick from weighted options: [[item, weight], ...] */
  weighted<T>(options: [T, number][]): T {
    const total = options.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, weight] of options) {
      r -= weight;
      if (r <= 0) return item;
    }
    return options[options.length - 1][0];
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Scenario =
  | "flex-row"
  | "flex-col"
  | "grid"
  | "block-explicit"
  | "block-auto"
  | "positioned"
  | "percentage"
  | "inline-block"
  | "aspect-ratio"
  | "flex-wrap"
  | "bare-css"
  | "nested-flex"
  | "display-contents"
  | "grid-named"
  | "clamped-sizes"
  | "mixed-units"
  | "deep-nesting";

const SCENARIO_WEIGHTS: [Scenario, number][] = [
  ["flex-row", 18],
  ["flex-col", 10],
  ["flex-wrap", 6],
  ["grid", 10],
  ["grid-named", 6],
  ["block-explicit", 10],
  ["block-auto", 6],
  ["positioned", 8],
  ["percentage", 5],
  ["inline-block", 5],
  ["aspect-ratio", 6],
  ["bare-css", 8],
  ["nested-flex", 8],
  ["display-contents", 6],
  ["clamped-sizes", 5],
  ["mixed-units", 4],
  ["deep-nesting", 4],
];

// ---------------------------------------------------------------------------
// Value generators
// ---------------------------------------------------------------------------

/** Random pixel value, sometimes "0" instead of "0px". */
function randomPx(rng: Rng, min = 20, max = 400): string {
  const v = rng.int(min, max);
  if (v === 0 && rng.chance(0.5)) return "0";
  return `${v}px`;
}

function randomSmallPx(rng: Rng, min = 0, max = 20): string {
  const v = rng.int(min, max);
  if (v === 0 && rng.chance(0.5)) return "0";
  return `${v}px`;
}

function maybeBoxSizing(rng: Rng): Record<string, string> {
  if (rng.chance(0.5)) return { "box-sizing": "border-box" };
  if (rng.chance(0.1)) return { "box-sizing": "content-box" }; // Explicit default
  return {};
}

function maybePadding(rng: Rng): Record<string, string> {
  if (!rng.chance(0.4)) return {};
  if (rng.chance(0.3)) {
    const props: Record<string, string> = {};
    for (const side of ["padding-top", "padding-right", "padding-bottom", "padding-left"]) {
      if (rng.chance(0.5)) props[side] = randomSmallPx(rng, 2, 15);
    }
    return props;
  }
  return { padding: randomSmallPx(rng, 2, 15) };
}

function maybeBorder(rng: Rng): Record<string, string> {
  if (!rng.chance(0.3)) return {};
  if (rng.chance(0.2)) {
    const props: Record<string, string> = {};
    for (const side of ["border-top", "border-right", "border-bottom", "border-left"]) {
      if (rng.chance(0.5)) props[side] = `${rng.int(1, 4)}px solid black`;
    }
    return props;
  }
  return { border: `${rng.int(1, 4)}px solid black` };
}

function maybeMargin(rng: Rng): Record<string, string> {
  if (!rng.chance(0.3)) return {};
  if (rng.chance(0.3)) {
    const props: Record<string, string> = {};
    for (const side of ["margin-top", "margin-right", "margin-bottom", "margin-left"]) {
      if (rng.chance(0.5)) props[side] = randomSmallPx(rng, 0, 15);
    }
    return props;
  }
  return { margin: randomSmallPx(rng, 0, 10) };
}

function maybeMinMax(rng: Rng, axis: "width" | "height"): Record<string, string> {
  const props: Record<string, string> = {};
  if (rng.chance(0.2)) props[`min-${axis}`] = randomDimension(rng, 10, 100);
  if (rng.chance(0.2)) props[`max-${axis}`] = randomDimension(rng, 100, 500);
  return props;
}

function maybeMinMaxBoth(rng: Rng): Record<string, string> {
  return { ...maybeMinMax(rng, "width"), ...maybeMinMax(rng, "height") };
}

function maybeOverflow(rng: Rng): Record<string, string> {
  if (!rng.chance(0.3)) return { overflow: "hidden" };
  const values = ["hidden", "visible", "auto", "scroll", "clip"];
  if (rng.chance(0.2)) {
    // Per-axis overflow
    const props: Record<string, string> = {};
    props["overflow-x"] = rng.pick(values);
    props["overflow-y"] = rng.pick(values);
    return props;
  }
  return { overflow: rng.pick(values) };
}

function maybeWritingMode(rng: Rng): Record<string, string> {
  if (!rng.chance(0.05)) return {};
  return { "writing-mode": rng.pick(["horizontal-tb", "vertical-rl", "vertical-lr"]) };
}

function maybeFloat(rng: Rng): Record<string, string> {
  if (!rng.chance(0.1)) return {};
  return { float: rng.pick(["left", "right"]) };
}

function maybeTextContent(rng: Rng): string | undefined {
  if (!rng.chance(0.15)) return undefined;
  const words = ["Hello", "Layout", "Test", "Flex", "Grid", "Box", "Content", "Overflow"];
  const count = rng.int(1, 5);
  return Array.from({ length: count }, () => rng.pick(words)).join(" ");
}

function randomPercentOrPx(rng: Rng, min = 20, max = 400): string {
  if (rng.chance(0.25)) return `${rng.int(10, 100)}%`;
  return randomPx(rng, min, max);
}

/** Generate a CSS function value: calc(), min(), max(), clamp(). */
function randomCssFunction(rng: Rng, min = 20, max = 400): string {
  const a = randomPx(rng, min, max);
  const b = randomPx(rng, min, max);
  return rng.weighted([
    [`calc(${a} + ${rng.int(5, 50)}px)`, 3],
    [`calc(${a} - ${rng.int(5, 30)}px)`, 2],
    [`calc(${rng.int(10, 100)}% - ${rng.int(10, 50)}px)`, 3],
    [`min(${a}, ${b})`, 2],
    [`max(${a}, ${b})`, 2],
    [`clamp(${randomPx(rng, min, Math.floor((min + max) / 2))}, ${rng.int(20, 80)}%, ${randomPx(rng, Math.floor((min + max) / 2), max)})`, 2],
  ]);
}

/** Dimension value: px, percentage, or occasionally a CSS function. */
function randomDimension(rng: Rng, min = 20, max = 400): string {
  return rng.weighted([
    [randomPx(rng, min, max), 8],
    [`${rng.int(10, 100)}%`, 2],
    [randomCssFunction(rng, min, max), 1],
  ]);
}

function maybeFlexShorthand(rng: Rng, style: Record<string, string>): void {
  if (rng.chance(0.6)) style["flex-grow"] = String(rng.int(0, 4));
  if (rng.chance(0.3)) style["flex-shrink"] = String(rng.int(0, 4));
  if (rng.chance(0.4)) {
    style["flex-basis"] = rng.weighted([
      ["auto", 4], ["0", 3], ["0px", 1], ["0%", 1],
      [randomPx(rng, 0, 200), 4], [`${rng.int(10, 80)}%`, 2],
      [randomCssFunction(rng, 0, 200), 1],
    ]);
  }
}

function maybeAlignSelf(rng: Rng): Record<string, string> {
  if (!rng.chance(0.2)) return {};
  return { "align-self": rng.pick(["auto", "normal", "stretch", "flex-start", "flex-end", "center", "baseline"]) };
}

function maybeGap(rng: Rng): Record<string, string> {
  if (!rng.chance(0.3)) return {};
  if (rng.chance(0.3)) {
    // Individual gaps
    const props: Record<string, string> = {};
    if (rng.chance(0.5)) props["column-gap"] = randomSmallPx(rng, 2, 20);
    if (rng.chance(0.5)) props["row-gap"] = randomSmallPx(rng, 2, 20);
    return props;
  }
  return { gap: randomSmallPx(rng, 2, 20) };
}

// ---------------------------------------------------------------------------
// Random CSS property bag — for the "bare-css" scenario
// ---------------------------------------------------------------------------

function randomCssProps(rng: Rng): Record<string, string> {
  const style: Record<string, string> = {};

  // Size — allow percentages, calc, viewport units, and CSS functions
  if (rng.chance(0.6)) {
    style.width = rng.weighted([
      [randomPx(rng, 20, 400), 6],
      [`${rng.int(20, 100)}%`, 2],
      [`${rng.int(20, 80)}vw`, 1],
      [randomCssFunction(rng, 20, 400), 1],
    ]);
  }
  if (rng.chance(0.6)) {
    style.height = rng.weighted([
      [randomPx(rng, 20, 400), 6],
      [`${rng.int(20, 100)}%`, 2],
      [`${rng.int(20, 80)}vh`, 1],
      [randomCssFunction(rng, 20, 400), 1],
    ]);
  }

  // Box model
  Object.assign(style, maybePadding(rng), maybeBorder(rng), maybeMargin(rng), maybeBoxSizing(rng));

  // Min/max — sometimes percentage or viewport units
  if (rng.chance(0.25)) style["min-width"] = randomPercentOrPx(rng, 10, 100);
  if (rng.chance(0.25)) style["max-width"] = randomPercentOrPx(rng, 100, 500);
  if (rng.chance(0.2)) style["min-height"] = randomPercentOrPx(rng, 10, 100);
  if (rng.chance(0.2)) style["max-height"] = randomPercentOrPx(rng, 100, 500);

  // Display
  if (rng.chance(0.3)) {
    style.display = rng.weighted([
      ["block", 5], ["flex", 3], ["inline-block", 3], ["inline-flex", 1],
      ["grid", 2], ["inline-grid", 1], ["none", 1], ["contents", 1],
      ["table", 1], ["table-cell", 1],
    ]);
  }

  // Flex props (even if not a flex item — should be ignored)
  if (rng.chance(0.2)) style["flex-grow"] = String(rng.int(0, 4));
  if (rng.chance(0.2)) style["flex-shrink"] = String(rng.int(0, 4));
  if (rng.chance(0.2)) style["flex-basis"] = rng.pick(["auto", "0", "0px", "0%", randomPx(rng, 0, 200), `${rng.int(10, 80)}%`]);
  if (rng.chance(0.1)) style["flex-direction"] = rng.pick(["row", "row-reverse", "column", "column-reverse"]);
  if (rng.chance(0.1)) style["flex-wrap"] = rng.pick(["nowrap", "wrap", "wrap-reverse"]);

  // Positioning
  if (rng.chance(0.15)) {
    style.position = rng.weighted([
      ["relative", 4], ["absolute", 4], ["fixed", 1], ["sticky", 1],
    ]);
    if (style.position === "absolute" || style.position === "fixed") {
      if (rng.chance(0.5)) style.left = randomSmallPx(rng, 0, 30);
      if (rng.chance(0.5)) style.right = randomSmallPx(rng, 0, 30);
      if (rng.chance(0.5)) style.top = randomSmallPx(rng, 0, 30);
      if (rng.chance(0.5)) style.bottom = randomSmallPx(rng, 0, 30);
    }
  }

  // Overflow
  Object.assign(style, maybeOverflow(rng));

  // Writing mode / float
  Object.assign(style, maybeWritingMode(rng), maybeFloat(rng));

  // Aspect ratio
  if (rng.chance(0.1)) {
    style["aspect-ratio"] = rng.chance(0.8) ? `${rng.int(1, 4)} / ${rng.int(1, 4)}` : `${rng.int(1, 4)}`;
  }

  // Align
  if (rng.chance(0.15)) style["align-self"] = rng.pick(["auto", "stretch", "flex-start", "flex-end", "center", "baseline"]);
  if (rng.chance(0.15)) style["align-items"] = rng.pick(["stretch", "flex-start", "flex-end", "center", "baseline", "normal"]);

  // Gap
  Object.assign(style, maybeGap(rng));

  // Justify
  if (rng.chance(0.1)) style["justify-content"] = rng.pick(["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"]);

  return style;
}

// ---------------------------------------------------------------------------
// Leaf node (always has explicit size)
// ---------------------------------------------------------------------------

function makeLeaf(rng: Rng): LayoutSpec {
  const style: Record<string, string> = {
    width: randomPx(rng, 20, 150),
    height: randomPx(rng, 20, 100),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
    ...maybeMargin(rng),
  };

  // Occasionally hide or use display:contents
  if (rng.chance(0.05)) {
    style.display = "none";
  } else if (rng.chance(0.05)) {
    style.display = "contents";
  }

  // Occasionally add min/max constraints
  Object.assign(style, maybeMinMaxBoth(rng));

  // Occasionally use percentage or CSS function width
  if (rng.chance(0.1)) style.width = `${rng.int(20, 100)}%`;
  else if (rng.chance(0.05)) style.width = randomCssFunction(rng, 20, 150);

  // Occasionally use "0" instead of "0px"
  for (const [k, v] of Object.entries(style)) {
    if (v === "0px" && rng.chance(0.3)) style[k] = "0";
  }

  const text = maybeTextContent(rng);
  return text ? { style, text } : { style };
}

// ---------------------------------------------------------------------------
// Scenario builders
// ---------------------------------------------------------------------------

function buildFlexRow(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    display: "flex",
    "flex-direction": rng.chance(0.15) ? "row-reverse" : "row",
    width: randomPx(rng, 200, 800),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
    ...maybeGap(rng),
    ...maybeWritingMode(rng),
  };
  if (rng.chance(0.3)) style["align-items"] = rng.pick(["stretch", "flex-start", "flex-end", "center", "baseline", "normal"]);
  if (rng.chance(0.2)) style["justify-content"] = rng.pick(["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"]);
  if (rng.chance(0.4)) style.height = randomPx(rng, 100, 500);

  for (const child of children) {
    if (!child.style) child.style = {};
    maybeFlexShorthand(rng, child.style);
    Object.assign(child.style, maybeAlignSelf(rng), maybeMinMax(rng, "width"), maybeMinMax(rng, "height"), maybeMargin(rng));
  }

  return { style, children };
}

function buildFlexCol(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    display: "flex",
    "flex-direction": rng.chance(0.15) ? "column-reverse" : "column",
    height: randomPx(rng, 200, 800),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
    ...maybeGap(rng),
    ...maybeWritingMode(rng),
  };
  if (rng.chance(0.3)) style["align-items"] = rng.pick(["stretch", "flex-start", "flex-end", "center", "baseline", "normal"]);
  if (rng.chance(0.3)) style.width = randomPx(rng, 100, 500);

  for (const child of children) {
    if (!child.style) child.style = {};
    maybeFlexShorthand(rng, child.style);
    Object.assign(child.style, maybeAlignSelf(rng), maybeMinMax(rng, "height"), maybeMinMax(rng, "width"), maybeMargin(rng));
  }

  return { style, children };
}

function buildFlexWrap(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    display: "flex",
    "flex-direction": rng.pick(["row", "row-reverse", "column", "column-reverse"]),
    "flex-wrap": rng.chance(0.2) ? "wrap-reverse" : "wrap",
    width: randomPx(rng, 200, 500),
    height: randomPx(rng, 200, 500),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBoxSizing(rng),
    ...maybeGap(rng),
  };
  if (rng.chance(0.3)) style["align-content"] = rng.pick(["stretch", "flex-start", "flex-end", "center", "space-between"]);

  for (const child of children) {
    if (!child.style) child.style = {};
    if (rng.chance(0.5)) child.style["flex-basis"] = randomPx(rng, 50, 200);
    if (rng.chance(0.3)) child.style["flex-grow"] = String(rng.int(0, 2));
    Object.assign(child.style, maybeMargin(rng));
  }

  return { style, children };
}

function buildGrid(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const cols = Math.min(children.length, rng.int(2, 4));
  const fracs = Array.from({ length: cols }, () => `${rng.int(1, 3)}fr`).join(" ");
  const style: Record<string, string> = {
    display: "grid",
    "grid-template-columns": fracs,
    width: randomPx(rng, 200, 800),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
    ...maybeGap(rng),
  };
  if (rng.chance(0.3)) style["grid-auto-rows"] = rng.pick(["auto", "min-content", randomPx(rng, 30, 150)]);
  if (rng.chance(0.3)) style.height = randomPx(rng, 200, 600);
  if (rng.chance(0.2)) style["align-items"] = rng.pick(["stretch", "start", "end", "center"]);
  if (rng.chance(0.2)) style["justify-items"] = rng.pick(["stretch", "start", "end", "center"]);

  for (const child of children) {
    if (!child.style) child.style = {};
    Object.assign(child.style, maybeMargin(rng), maybeMinMaxBoth(rng));
  }

  return { style, children };
}

function buildBlockExplicit(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
    ...maybeWritingMode(rng),
  };
  if (rng.chance(0.7)) style.width = randomPx(rng, 100, 600);
  if (rng.chance(0.5)) style.height = randomPx(rng, 100, 600);
  Object.assign(style, maybeMinMaxBoth(rng));

  for (const child of children) {
    if (!child.style) child.style = {};
    Object.assign(child.style, maybeMargin(rng), maybeFloat(rng));
  }

  return { style, children };
}

function buildBlockAuto(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeWritingMode(rng),
  };

  for (const child of children) {
    if (!child.style) child.style = {};
    Object.assign(child.style, maybeMargin(rng), maybeFloat(rng));
  }

  return { style, children };
}

function buildPositioned(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    position: "relative",
    width: randomPx(rng, 200, 600),
    height: randomPx(rng, 200, 600),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
  };

  // Make at least one child positioned
  if (children.length > 0) {
    const absChild = children[rng.int(0, children.length - 1)];
    if (!absChild.style) absChild.style = {};
    absChild.style.position = rng.weighted([
      ["absolute", 8], ["fixed", 2], ["sticky", 1],
    ]);

    // Choose which axes get opposing offsets
    const bothAxes = rng.chance(0.3);
    const doWidth = rng.chance(0.5) || bothAxes;
    const doHeight = !doWidth || bothAxes;

    if (doWidth) {
      absChild.style.left = randomSmallPx(rng, 0, 30);
      absChild.style.right = randomSmallPx(rng, 0, 30);
      delete absChild.style.width;
    }
    if (doHeight) {
      absChild.style.top = randomSmallPx(rng, 0, 30);
      absChild.style.bottom = randomSmallPx(rng, 0, 30);
      delete absChild.style.height;
    }
    Object.assign(absChild.style, maybeMargin(rng), maybeMinMaxBoth(rng), maybePadding(rng), maybeBoxSizing(rng));
  }

  return { style, children };
}

function buildPercentage(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    width: randomPx(rng, 200, 600),
    height: randomPx(rng, 200, 600),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBoxSizing(rng),
  };

  for (const child of children) {
    if (!child.style) child.style = {};
    if (rng.chance(0.7)) child.style.width = `${rng.int(20, 100)}%`;
    if (rng.chance(0.5)) child.style.height = `${rng.int(20, 100)}%`;
    Object.assign(child.style, maybeMargin(rng), maybeMinMaxBoth(rng));
  }

  return { style, children };
}

function buildInlineBlock(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const wrappedChildren = children.map((child) => {
    if (!child.style) child.style = {};
    child.style.display = "inline-block";
    if (rng.chance(0.5)) child.style.width = randomPx(rng, 50, 200);
    if (rng.chance(0.5)) child.style.height = randomPx(rng, 30, 100);
    Object.assign(child.style, maybeMargin(rng));
    return child;
  });

  return {
    style: {
      width: randomPx(rng, 300, 800),
      ...maybeOverflow(rng),
      ...maybePadding(rng),
    },
    children: wrappedChildren,
  };
}

function buildAspectRatio(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBoxSizing(rng),
  };

  const ratioW = rng.int(1, 4);
  const ratioH = rng.int(1, 4);
  style["aspect-ratio"] = `${ratioW} / ${ratioH}`;

  if (rng.chance(0.5)) {
    style.width = randomPx(rng, 100, 400);
  } else {
    style.height = randomPx(rng, 100, 400);
  }
  Object.assign(style, maybeMinMaxBoth(rng));

  return { style, children };
}

function buildNestedFlex(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  // Outer flex with inner flex children — tests flex-in-flex interactions
  const outerDir = rng.pick(["row", "row-reverse", "column", "column-reverse"]);
  const style: Record<string, string> = {
    display: "flex",
    "flex-direction": outerDir,
    [outerDir === "row" ? "width" : "height"]: randomPx(rng, 300, 700),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBoxSizing(rng),
    ...maybeGap(rng),
    ...maybeWritingMode(rng),
  };
  if (rng.chance(0.3)) style["align-items"] = rng.pick(["stretch", "flex-start", "flex-end", "center"]);
  if (rng.chance(0.4)) style[outerDir === "row" ? "height" : "width"] = randomPx(rng, 200, 500);

  // Make some children flex containers themselves
  for (const child of children) {
    if (!child.style) child.style = {};
    maybeFlexShorthand(rng, child.style);
    Object.assign(child.style, maybeAlignSelf(rng), maybeMargin(rng));

    if (rng.chance(0.5) && child.children && child.children.length > 0) {
      const innerDir = rng.pick(["row", "row-reverse", "column", "column-reverse"]);
      child.style.display = "flex";
      child.style["flex-direction"] = innerDir;
      Object.assign(child.style, maybeOverflow(rng), maybeGap(rng));
      if (rng.chance(0.3)) child.style["align-items"] = rng.pick(["stretch", "flex-start", "flex-end", "center"]);

      for (const gc of child.children) {
        if (!gc.style) gc.style = {};
        maybeFlexShorthand(rng, gc.style);
        Object.assign(gc.style, maybeAlignSelf(rng), maybeMargin(rng));
      }
    }
  }

  return { style, children };
}

function buildDisplayContents(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  // Parent with display:contents — children participate in grandparent's layout
  const gpDisplay = rng.weighted([
    ["flex", 4], ["grid", 3], ["block", 3],
  ]);
  const gpStyle: Record<string, string> = {};

  if (gpDisplay === "flex") {
    gpStyle.display = "flex";
    gpStyle["flex-direction"] = rng.pick(["row", "row-reverse", "column", "column-reverse"]);
    gpStyle[gpStyle["flex-direction"] === "row" ? "width" : "height"] = randomPx(rng, 300, 600);
    Object.assign(gpStyle, maybeGap(rng), maybeOverflow(rng), maybeBoxSizing(rng));
    if (rng.chance(0.3)) gpStyle["align-items"] = rng.pick(["stretch", "flex-start", "flex-end", "center"]);
  } else if (gpDisplay === "grid") {
    const cols = Math.min(children.length + 1, rng.int(2, 4));
    gpStyle.display = "grid";
    gpStyle["grid-template-columns"] = Array.from({ length: cols }, () => `${rng.int(1, 3)}fr`).join(" ");
    gpStyle.width = randomPx(rng, 300, 600);
    Object.assign(gpStyle, maybeGap(rng), maybeOverflow(rng), maybeBoxSizing(rng));
  } else {
    gpStyle.width = randomPx(rng, 300, 600);
    Object.assign(gpStyle, maybeOverflow(rng), maybeBoxSizing(rng));
  }

  // The contents wrapper
  const contentsStyle: Record<string, string> = {
    display: "contents",
    ...maybeWritingMode(rng),
  };

  // Some children go in the contents wrapper, some directly in the grandparent
  const directChildren: LayoutSpec[] = [];
  const wrappedChildren: LayoutSpec[] = [];
  for (const child of children) {
    if (!child.style) child.style = {};
    Object.assign(child.style, maybeMargin(rng), maybeMinMaxBoth(rng));
    if (gpDisplay === "flex") maybeFlexShorthand(rng, child.style);
    if (rng.chance(0.6)) wrappedChildren.push(child);
    else directChildren.push(child);
  }
  if (wrappedChildren.length === 0 && children.length > 0) {
    wrappedChildren.push(directChildren.pop()!);
  }

  const contentsNode: LayoutSpec = { style: contentsStyle, children: wrappedChildren };
  return { style: gpStyle, children: [contentsNode, ...directChildren] };
}

function buildGridNamed(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  // Grid with minmax, auto-fill/auto-fit, and explicit row templates
  const colTemplate = rng.weighted([
    [`repeat(auto-fill, minmax(${rng.int(80, 200)}px, 1fr))`, 3],
    [`repeat(auto-fit, minmax(${rng.int(80, 200)}px, 1fr))`, 2],
    [`repeat(${rng.int(2, 4)}, minmax(${rng.int(40, 100)}px, ${rng.int(1, 3)}fr))`, 3],
    [`${randomPx(rng, 100, 200)} 1fr ${randomPx(rng, 100, 200)}`, 2],
  ]);
  const style: Record<string, string> = {
    display: "grid",
    "grid-template-columns": colTemplate,
    width: randomPx(rng, 300, 800),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
    ...maybeGap(rng),
  };
  if (rng.chance(0.3)) style["grid-auto-rows"] = rng.pick(["auto", "min-content", `minmax(${rng.int(30, 80)}px, auto)`, randomPx(rng, 30, 150)]);
  if (rng.chance(0.3)) style.height = randomPx(rng, 200, 600);
  if (rng.chance(0.2)) style["align-items"] = rng.pick(["stretch", "start", "end", "center"]);

  // Occasionally span or position children in specific grid tracks
  for (const child of children) {
    if (!child.style) child.style = {};
    if (rng.chance(0.25)) {
      child.style["grid-column"] = rng.weighted([
        [`span ${rng.int(2, 3)}`, 4],
        [`${rng.int(1, 3)} / ${rng.int(2, 4)}`, 2],
        [`${rng.int(1, 3)}`, 1],
      ]);
    }
    if (rng.chance(0.15)) {
      child.style["grid-row"] = rng.weighted([
        [`span ${rng.int(2, 3)}`, 4],
        [`${rng.int(1, 3)} / ${rng.int(2, 4)}`, 2],
        [`${rng.int(1, 3)}`, 1],
      ]);
    }
    Object.assign(child.style, maybeMargin(rng), maybeMinMaxBoth(rng));
  }

  return { style, children };
}

function buildClampedSizes(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  // Exercises min/max clamping heavily
  const style: Record<string, string> = {
    display: rng.pick(["flex", "block", "grid"]),
    width: randomPx(rng, 200, 500),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBoxSizing(rng),
  };
  if (style.display === "flex") {
    style["flex-direction"] = rng.pick(["row", "column"]);
    Object.assign(style, maybeGap(rng));
  }
  if (style.display === "grid") {
    const cols = Math.min(children.length, rng.int(2, 3));
    style["grid-template-columns"] = Array.from({ length: cols }, () => "1fr").join(" ");
  }

  for (const child of children) {
    if (!child.style) child.style = {};
    // Always add min/max constraints
    child.style["min-width"] = randomPx(rng, 10, 80);
    child.style["max-width"] = randomPx(rng, 80, 300);
    child.style["min-height"] = randomPx(rng, 10, 60);
    child.style["max-height"] = randomPx(rng, 60, 250);
    // Width/height that may conflict with constraints
    if (rng.chance(0.5)) child.style.width = randomPx(rng, 5, 400);
    if (rng.chance(0.5)) child.style.height = randomPx(rng, 5, 300);
    Object.assign(child.style, maybeMargin(rng), maybeBoxSizing(rng));
    if (style.display === "flex") maybeFlexShorthand(rng, child.style);
  }

  return { style, children };
}

function buildMixedUnits(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  // Mixes em, rem, percentage, vw/vh, and px units
  const style: Record<string, string> = {
    width: randomPx(rng, 300, 600),
    height: randomPx(rng, 200, 500),
    "font-size": `${rng.int(12, 24)}px`,
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBoxSizing(rng),
  };

  for (const child of children) {
    if (!child.style) child.style = {};
    // Use varied units for size
    const unitType = rng.pick(["px", "em", "rem", "%", "vw", "vh"]);
    switch (unitType) {
      case "px": child.style.width = randomPx(rng, 30, 200); break;
      case "em": child.style.width = `${rng.int(2, 15)}em`; break;
      case "rem": child.style.width = `${rng.int(2, 15)}rem`; break;
      case "%": child.style.width = `${rng.int(20, 80)}%`; break;
      case "vw": child.style.width = `${rng.int(10, 50)}vw`; break;
      case "vh": child.style.width = `${rng.int(10, 50)}vh`; break;
    }
    if (rng.chance(0.6)) child.style.height = randomPx(rng, 20, 100);
    Object.assign(child.style, maybeMargin(rng), maybeMinMaxBoth(rng), maybeBoxSizing(rng));
  }

  return { style, children };
}

function buildDeepNesting(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  // Wraps children in 2-4 levels of containers with varied display modes
  let current: LayoutSpec = { style: {}, children };
  const levels = rng.int(2, 4);

  for (let i = 0; i < levels; i++) {
    const d = rng.weighted([
      ["block", 4], ["flex", 3], ["grid", 2],
    ]);
    const wrapStyle: Record<string, string> = { ...maybeOverflow(rng), ...maybeBoxSizing(rng) };

    if (d === "flex") {
      wrapStyle.display = "flex";
      wrapStyle["flex-direction"] = rng.pick(["row", "column"]);
      Object.assign(wrapStyle, maybeGap(rng));
      if (rng.chance(0.3)) wrapStyle["align-items"] = rng.pick(["stretch", "flex-start", "flex-end", "center"]);
    } else if (d === "grid") {
      wrapStyle.display = "grid";
      wrapStyle["grid-template-columns"] = `repeat(${rng.int(1, 3)}, 1fr)`;
    }

    // Outer levels get explicit sizes
    if (i === levels - 1) {
      wrapStyle.width = randomPx(rng, 300, 700);
      if (rng.chance(0.5)) wrapStyle.height = randomPx(rng, 200, 500);
    }
    Object.assign(wrapStyle, maybePadding(rng), maybeBorder(rng));

    current = { style: wrapStyle, children: [current] };
  }

  return current;
}

function buildBareCss(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style = randomCssProps(rng);

  // Apply random CSS to children too
  for (const child of children) {
    if (!child.style) child.style = {};
    if (rng.chance(0.5)) Object.assign(child.style, randomCssProps(rng));
  }

  return { style, children };
}

function buildScenario(
  scenario: Scenario, rng: Rng, children: LayoutSpec[],
): LayoutSpec {
  switch (scenario) {
    case "flex-row": return buildFlexRow(rng, children);
    case "flex-col": return buildFlexCol(rng, children);
    case "flex-wrap": return buildFlexWrap(rng, children);
    case "grid": return buildGrid(rng, children);
    case "block-explicit": return buildBlockExplicit(rng, children);
    case "block-auto": return buildBlockAuto(rng, children);
    case "positioned": return buildPositioned(rng, children);
    case "percentage": return buildPercentage(rng, children);
    case "inline-block": return buildInlineBlock(rng, children);
    case "aspect-ratio": return buildAspectRatio(rng, children);
    case "bare-css": return buildBareCss(rng, children);
    case "nested-flex": return buildNestedFlex(rng, children);
    case "display-contents": return buildDisplayContents(rng, children);
    case "grid-named": return buildGridNamed(rng, children);
    case "clamped-sizes": return buildClampedSizes(rng, children);
    case "mixed-units": return buildMixedUnits(rng, children);
    case "deep-nesting": return buildDeepNesting(rng, children);
  }
}

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

function buildTree(
  rng: Rng, depth: number, maxDepth: number,
  remaining: { count: number },
): LayoutSpec {
  if (remaining.count <= 0 || depth >= maxDepth) {
    return makeLeaf(rng);
  }

  const numChildren = rng.int(1, Math.min(4, remaining.count));
  remaining.count -= numChildren;

  const children: LayoutSpec[] = [];
  for (let i = 0; i < numChildren; i++) {
    if (depth + 1 < maxDepth && remaining.count > 0 && rng.chance(0.3)) {
      children.push(buildTree(rng, depth + 1, maxDepth, remaining));
    } else {
      children.push(makeLeaf(rng));
    }
  }

  const scenario = rng.weighted(SCENARIO_WEIGHTS);
  return buildScenario(scenario, rng, children);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a random LayoutSpec tree.
 *
 * @param seed  Deterministic seed for reproducibility
 * @param opts  maxElements (default 10), maxDepth (default 3)
 * @returns     A LayoutSpec with one node marked as target
 */
export function generateSpec(seed: number, opts: GenerateOpts = {}): LayoutSpec {
  const rng = new Rng(seed);
  const maxElements = opts.maxElements ?? 10;
  const maxDepth = opts.maxDepth ?? 3;
  const remaining = { count: maxElements - 1 };

  const tree = buildTree(rng, 0, maxDepth, remaining);
  assignTarget(tree, rng);

  return tree;
}

/** Walk the tree and mark exactly one node as the target. */
function assignTarget(spec: LayoutSpec, rng: Rng): void {
  const nodes: LayoutSpec[] = [];
  function walk(node: LayoutSpec): void {
    nodes.push(node);
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  }
  walk(spec);

  const idx = nodes.length > 1 ? rng.int(1, nodes.length - 1) : 0;
  nodes[idx].target = true;
}
