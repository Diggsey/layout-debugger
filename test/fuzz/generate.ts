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
  | "flex-wrap";

const SCENARIO_WEIGHTS: [Scenario, number][] = [
  ["flex-row", 20],
  ["flex-col", 12],
  ["flex-wrap", 8],
  ["grid", 12],
  ["block-explicit", 12],
  ["block-auto", 8],
  ["positioned", 10],
  ["percentage", 5],
  ["inline-block", 5],
  ["aspect-ratio", 8],
];

// ---------------------------------------------------------------------------
// Value generators
// ---------------------------------------------------------------------------

function randomPx(rng: Rng, min = 20, max = 400): string {
  return `${rng.int(min, max)}px`;
}

function randomSmallPx(rng: Rng, min = 0, max = 20): string {
  return `${rng.int(min, max)}px`;
}

function maybeBoxSizing(rng: Rng): Record<string, string> {
  return rng.chance(0.5) ? { "box-sizing": "border-box" } : {};
}

function maybePadding(rng: Rng): Record<string, string> {
  if (!rng.chance(0.4)) return {};
  if (rng.chance(0.3)) {
    // Individual sides
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
    // Individual sides
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
    // Individual sides
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
  if (rng.chance(0.2)) props[`min-${axis}`] = randomPx(rng, 10, 100);
  if (rng.chance(0.2)) props[`max-${axis}`] = randomPx(rng, 100, 500);
  return props;
}

function maybeOverflow(rng: Rng): Record<string, string> {
  if (!rng.chance(0.3)) return { overflow: "hidden" };
  return { overflow: rng.pick(["hidden", "visible", "auto", "scroll"]) };
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

  return { style };
}

// ---------------------------------------------------------------------------
// Scenario builders
// ---------------------------------------------------------------------------

function buildFlexRow(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    display: "flex",
    "flex-direction": "row",
    width: randomPx(rng, 200, 800),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
  };
  if (rng.chance(0.3)) style.gap = randomSmallPx(rng, 2, 20);
  if (rng.chance(0.2)) style["align-items"] = rng.pick(["stretch", "flex-start", "flex-end", "center", "baseline"]);
  if (rng.chance(0.2)) style["justify-content"] = rng.pick(["flex-start", "flex-end", "center", "space-between", "space-around"]);

  for (const child of children) {
    if (!child.style) child.style = {};
    if (rng.chance(0.6)) child.style["flex-grow"] = String(rng.int(0, 3));
    if (rng.chance(0.3)) child.style["flex-shrink"] = String(rng.int(0, 3));
    if (rng.chance(0.4)) child.style["flex-basis"] = rng.pick(["auto", "0", randomPx(rng, 0, 200)]);
    if (rng.chance(0.15)) child.style["align-self"] = rng.pick(["auto", "stretch", "flex-start", "flex-end", "center"]);
    Object.assign(child.style, maybeMinMax(rng, "width"), maybeMargin(rng));
  }

  return { style, children };
}

function buildFlexCol(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    display: "flex",
    "flex-direction": "column",
    height: randomPx(rng, 200, 800),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
  };
  if (rng.chance(0.3)) style.gap = randomSmallPx(rng, 2, 20);
  if (rng.chance(0.2)) style["align-items"] = rng.pick(["stretch", "flex-start", "flex-end", "center"]);

  for (const child of children) {
    if (!child.style) child.style = {};
    if (rng.chance(0.6)) child.style["flex-grow"] = String(rng.int(0, 3));
    if (rng.chance(0.3)) child.style["flex-shrink"] = String(rng.int(0, 3));
    if (rng.chance(0.4)) child.style["flex-basis"] = rng.pick(["auto", "0", randomPx(rng, 0, 200)]);
    if (rng.chance(0.15)) child.style["align-self"] = rng.pick(["auto", "stretch", "flex-start", "flex-end", "center"]);
    Object.assign(child.style, maybeMinMax(rng, "height"), maybeMargin(rng));
  }

  return { style, children };
}

function buildFlexWrap(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    display: "flex",
    "flex-direction": rng.pick(["row", "column"]),
    "flex-wrap": "wrap",
    width: randomPx(rng, 200, 500),
    height: randomPx(rng, 200, 500),
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBoxSizing(rng),
  };
  if (rng.chance(0.3)) style.gap = randomSmallPx(rng, 2, 10);
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
  };
  if (rng.chance(0.3)) style.gap = randomSmallPx(rng, 2, 20);
  if (rng.chance(0.3)) style["grid-auto-rows"] = rng.pick(["auto", "min-content", randomPx(rng, 30, 150)]);

  return { style, children };
}

function buildBlockExplicit(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
  };
  if (rng.chance(0.7)) style.width = randomPx(rng, 100, 600);
  if (rng.chance(0.5)) style.height = randomPx(rng, 100, 600);

  // Some children get margins
  for (const child of children) {
    if (!child.style) child.style = {};
    Object.assign(child.style, maybeMargin(rng));
  }

  return { style, children };
}

function buildBlockAuto(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    ...maybeOverflow(rng),
    ...maybePadding(rng),
    ...maybeBorder(rng),
  };

  for (const child of children) {
    if (!child.style) child.style = {};
    Object.assign(child.style, maybeMargin(rng));
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

  // Make at least one child absolutely positioned
  if (children.length > 0) {
    const absChild = children[rng.int(0, children.length - 1)];
    if (!absChild.style) absChild.style = {};
    absChild.style.position = "absolute";

    if (rng.chance(0.5)) {
      // Both horizontal offsets → width from offsets
      absChild.style.left = randomSmallPx(rng, 0, 30);
      absChild.style.right = randomSmallPx(rng, 0, 30);
      delete absChild.style.width;
    } else {
      // Both vertical offsets → height from offsets
      absChild.style.top = randomSmallPx(rng, 0, 30);
      absChild.style.bottom = randomSmallPx(rng, 0, 30);
      delete absChild.style.height;
    }
    // Sometimes add margins to positioned child
    Object.assign(absChild.style, maybeMargin(rng));
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
    Object.assign(child.style, maybeMargin(rng));
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

  // Set one axis explicitly, let aspect-ratio determine the other
  const ratioW = rng.int(1, 4);
  const ratioH = rng.int(1, 4);
  style["aspect-ratio"] = `${ratioW} / ${ratioH}`;

  if (rng.chance(0.5)) {
    style.width = randomPx(rng, 100, 400);
    // height derived from aspect-ratio
  } else {
    style.height = randomPx(rng, 100, 400);
    // width derived from aspect-ratio
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
