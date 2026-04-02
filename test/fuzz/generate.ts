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
  | "inline-block";

const SCENARIO_WEIGHTS: [Scenario, number][] = [
  ["flex-row", 25],
  ["flex-col", 15],
  ["grid", 15],
  ["block-explicit", 15],
  ["block-auto", 10],
  ["positioned", 10],
  ["percentage", 5],
  ["inline-block", 5],
];

// Scenarios that can appear as child containers (i.e. can have their own children)
const CONTAINER_SCENARIOS: Scenario[] = [
  "flex-row", "flex-col", "grid", "block-explicit", "block-auto",
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
  return { padding: randomSmallPx(rng, 2, 15) };
}

function maybeBorder(rng: Rng): Record<string, string> {
  if (!rng.chance(0.3)) return {};
  return { border: `${rng.int(1, 4)}px solid black` };
}

function maybeMinMax(rng: Rng, axis: "width" | "height"): Record<string, string> {
  const props: Record<string, string> = {};
  if (rng.chance(0.2)) props[`min-${axis}`] = randomPx(rng, 10, 100);
  if (rng.chance(0.2)) props[`max-${axis}`] = randomPx(rng, 100, 500);
  return props;
}

// ---------------------------------------------------------------------------
// Leaf node (always has explicit size)
// ---------------------------------------------------------------------------

function makeLeaf(rng: Rng): LayoutSpec {
  return {
    style: {
      width: randomPx(rng, 20, 150),
      height: randomPx(rng, 20, 100),
      ...maybePadding(rng),
      ...maybeBorder(rng),
      ...maybeBoxSizing(rng),
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario builders
// ---------------------------------------------------------------------------

function buildFlexRow(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    display: "flex",
    "flex-direction": "row",
    width: randomPx(rng, 200, 800),
    overflow: "hidden",
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
  };
  if (rng.chance(0.3)) style.gap = randomSmallPx(rng, 2, 20);

  // Add flex properties to children
  for (const child of children) {
    if (!child.style) child.style = {};
    if (rng.chance(0.6)) child.style["flex-grow"] = String(rng.int(0, 3));
    if (rng.chance(0.3)) child.style["flex-shrink"] = String(rng.int(0, 3));
    if (rng.chance(0.4)) child.style["flex-basis"] = rng.chance(0.5) ? randomPx(rng, 0, 200) : "0";
    Object.assign(child.style, maybeMinMax(rng, "width"));
  }

  return { style, children };
}

function buildFlexCol(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    display: "flex",
    "flex-direction": "column",
    height: randomPx(rng, 200, 800),
    overflow: "hidden",
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
  };
  if (rng.chance(0.3)) style.gap = randomSmallPx(rng, 2, 20);

  for (const child of children) {
    if (!child.style) child.style = {};
    if (rng.chance(0.6)) child.style["flex-grow"] = String(rng.int(0, 3));
    if (rng.chance(0.3)) child.style["flex-shrink"] = String(rng.int(0, 3));
    if (rng.chance(0.4)) child.style["flex-basis"] = rng.chance(0.5) ? randomPx(rng, 0, 200) : "0";
    Object.assign(child.style, maybeMinMax(rng, "height"));
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
    overflow: "hidden",
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
  };
  if (rng.chance(0.3)) style.gap = randomSmallPx(rng, 2, 20);

  return { style, children };
}

function buildBlockExplicit(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    overflow: "hidden",
    ...maybePadding(rng),
    ...maybeBorder(rng),
    ...maybeBoxSizing(rng),
  };
  if (rng.chance(0.7)) style.width = randomPx(rng, 100, 600);
  if (rng.chance(0.5)) style.height = randomPx(rng, 100, 600);

  return { style, children };
}

function buildBlockAuto(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  return {
    style: {
      overflow: "hidden",
      ...maybePadding(rng),
      ...maybeBorder(rng),
    },
    children,
  };
}

function buildPositioned(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const style: Record<string, string> = {
    position: "relative",
    width: randomPx(rng, 200, 600),
    height: randomPx(rng, 200, 600),
    overflow: "hidden",
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
      // Horizontal offsets → width from offsets
      absChild.style.left = randomSmallPx(rng, 0, 30);
      absChild.style.right = randomSmallPx(rng, 0, 30);
      delete absChild.style.width;
    } else {
      // Vertical offsets → height from offsets
      absChild.style.top = randomSmallPx(rng, 0, 30);
      absChild.style.bottom = randomSmallPx(rng, 0, 30);
      delete absChild.style.height;
    }
  }

  return { style, children };
}

function buildPercentage(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  const parentW = rng.int(200, 600);
  const parentH = rng.int(200, 600);
  const style: Record<string, string> = {
    width: `${parentW}px`,
    height: `${parentH}px`,
    overflow: "hidden",
    ...maybePadding(rng),
    ...maybeBoxSizing(rng),
  };

  // Give children percentage sizes
  for (const child of children) {
    if (!child.style) child.style = {};
    if (rng.chance(0.7)) child.style.width = `${rng.int(20, 100)}%`;
    if (rng.chance(0.5)) child.style.height = `${rng.int(20, 100)}%`;
  }

  return { style, children };
}

function buildInlineBlock(rng: Rng, children: LayoutSpec[]): LayoutSpec {
  // Wrap children in inline-block elements
  const wrappedChildren = children.map((child) => {
    if (!child.style) child.style = {};
    child.style.display = "inline-block";
    if (rng.chance(0.5)) child.style.width = randomPx(rng, 50, 200);
    if (rng.chance(0.5)) child.style.height = randomPx(rng, 30, 100);
    return child;
  });

  return {
    style: {
      width: randomPx(rng, 300, 800),
      overflow: "hidden",
      ...maybePadding(rng),
    },
    children: wrappedChildren,
  };
}

function buildScenario(
  scenario: Scenario, rng: Rng, children: LayoutSpec[],
): LayoutSpec {
  switch (scenario) {
    case "flex-row": return buildFlexRow(rng, children);
    case "flex-col": return buildFlexCol(rng, children);
    case "grid": return buildGrid(rng, children);
    case "block-explicit": return buildBlockExplicit(rng, children);
    case "block-auto": return buildBlockAuto(rng, children);
    case "positioned": return buildPositioned(rng, children);
    case "percentage": return buildPercentage(rng, children);
    case "inline-block": return buildInlineBlock(rng, children);
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

  // Decide number of children (1–4)
  const numChildren = rng.int(1, Math.min(4, remaining.count));
  remaining.count -= numChildren;

  // Build children: some are leaves, some may be subtrees
  const children: LayoutSpec[] = [];
  for (let i = 0; i < numChildren; i++) {
    if (depth + 1 < maxDepth && remaining.count > 0 && rng.chance(0.3)) {
      // Nested container
      children.push(buildTree(rng, depth + 1, maxDepth, remaining));
    } else {
      children.push(makeLeaf(rng));
    }
  }

  // Pick scenario for this container
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
  const remaining = { count: maxElements - 1 }; // -1 for root

  const tree = buildTree(rng, 0, maxDepth, remaining);

  // Pick a target element: either root or a random descendant
  assignTarget(tree, rng);

  return tree;
}

/** Walk the tree and mark exactly one node as the target. */
function assignTarget(spec: LayoutSpec, rng: Rng): void {
  // Collect all nodes
  const nodes: LayoutSpec[] = [];
  function walk(node: LayoutSpec): void {
    nodes.push(node);
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  }
  walk(spec);

  // Pick a random node (biased toward non-root to test more interesting cases)
  const idx = nodes.length > 1 ? rng.int(1, nodes.length - 1) : 0;
  nodes[idx].target = true;
}
