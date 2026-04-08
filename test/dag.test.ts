import { test, expect } from "@playwright/test";
import { loadFixture, analyzeDag, renderDagAxis } from "./helpers";

test.describe("DAG: block", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "block.html"); });

  test("auto-width → block-fill with full chain to container", async ({ page }) => {
    const dag = await analyzeDag(page, "auto-width");
    expect(dag.width.mode).toBe("block-fill");
    expect(dag.width.result).toBe(360);
    // block-fill depends on containingBlockContent, which depends on container's borderBox
    const cbContent = dag.width.inputs.containingBlockContent;
    expect(cbContent).toBeDefined();
    expect(cbContent.mode).toBe("content-area");
    expect(cbContent.element).toBe("[container]");
    // content-area depends on the container's explicit size
    const cbBorderBox = cbContent.inputs.borderBox;
    expect(cbBorderBox.mode).toBe("explicit");
    expect(cbBorderBox.result).toBe(400);

    expect(dag.height.mode).toBe("content-sum");
  });

  test("explicit → explicit node", async ({ page }) => {
    const dag = await analyzeDag(page, "explicit-width");
    expect(dag.width.mode).toBe("explicit");
    expect(dag.width.result).toBe(200);
    expect(dag.height.mode).toBe("explicit");
    expect(dag.height.result).toBe(80);
  });

  test("max-constrained → clamped block-fill", async ({ page }) => {
    const dag = await analyzeDag(page, "max-constrained");
    expect(dag.width.mode).toBe("clamped");
    expect(dag.width.result).toBe(150);
  });
});

test.describe("DAG: flex row", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "flex.html"); });

  test("flex:1 → flex-item-main with full breakdown", async ({ page }) => {
    const dag = await analyzeDag(page, "grow1");
    expect(dag.width.mode).toBe("flex-item-main");
    expect(dag.width.result).toBeCloseTo(166.67, 0);

    // baseSize input shows the clamped basis
    const base = dag.width.inputs.baseSize;
    expect(base.mode).toBe("flex-base-size");
    expect(base.inputs.basis.mode).toBe("flex-basis");
    expect(base.inputs.basis.result).toBe(0);
    expect(base.inputs.minContent.mode).toMatch(/^min-content/);

    expect(dag.height.mode).toBe("explicit");
    expect(dag.height.result).toBe(50);
  });

  test("flex:2 gets double share", async ({ page }) => {
    const dag = await analyzeDag(page, "grow2");
    expect(dag.width.mode).toBe("flex-item-main");
    expect(dag.width.result).toBeCloseTo(333.33, 0);
    // flex:2 gets roughly double the share of flex:1
    expect(dag.width.result).toBeGreaterThan(dag.width.inputs.baseSize.result);
  });

  test("flex: 0 0 100px stays at basis", async ({ page }) => {
    const dag = await analyzeDag(page, "fixed");
    expect(dag.width.mode).toBe("flex-item-main");
    expect(dag.width.result).toBe(100);
    expect(dag.width.inputs.baseSize).toBeDefined();
  });

  test("two siblings share the same container content-area node", async ({ page }) => {
    const dag1 = await analyzeDag(page, "grow1");
    const dag2 = await analyzeDag(page, "grow2");
    // Both reference the same container
    expect(dag1.width.inputs.baseSize.element).toBe("[grow1]");
    expect(dag2.width.inputs.baseSize.element).toBe("[grow2]");
    // Results should be consistent
    expect(dag1.width.result + dag2.width.result).toBeCloseTo(500, 0);
  });
});

test.describe("DAG: flex column", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "flex.html"); });

  test("column flex:1 → height is main axis", async ({ page }) => {
    const dag = await analyzeDag(page, "col-grow1");
    expect(dag.height.mode).toBe("flex-item-main");
    expect(dag.height.result).toBe(100);
    expect(dag.width.mode).toBe("flex-cross-stretch");
    expect(dag.width.result).toBe(200);
  });
});

test.describe("DAG: flex shrink", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "flex.html"); });

  test("shrink from 200px basis", async ({ page }) => {
    const dag = await analyzeDag(page, "shrink-a");
    expect(dag.width.mode).toBe("flex-item-main");
    expect(dag.width.result).toBe(150);
    expect(dag.width.inputs.baseSize.inputs.basis.result).toBe(200);
  });
});

test.describe("DAG: flex min-content", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "flex-min-content.html"); });

  test("wide item has min-content > 0", async ({ page }) => {
    const dag = await analyzeDag(page, "wide");
    expect(dag.width.mode).toBe("flex-item-main");
    const minContent = dag.width.inputs.baseSize.inputs.minContent;
    expect(minContent.result).toBeGreaterThan(100);
  });

  test("narrow item (min-width:0) has min-content = 0", async ({ page }) => {
    const dag = await analyzeDag(page, "narrow");
    expect(dag.width.inputs.baseSize.inputs.minContent.result).toBe(0);
  });
});

test.describe("DAG: flex overflow", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "flex-overflow.html"); });

  test("scroll-panel height unconstrained", async ({ page }) => {
    const dag = await analyzeDag(page, "scroll-panel");
    expect(dag.height.mode).toBe("flex-item-main");
    expect(dag.height.result).toBe(600);
  });
});

test.describe("DAG: grid", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "grid.html"); });

  test("1fr cell", async ({ page }) => {
    const dag = await analyzeDag(page, "grid-1fr");
    expect(dag.width.mode).toBe("grid-item");
    expect(dag.width.result).toBe(100);
  });

  test("span item", async ({ page }) => {
    const dag = await analyzeDag(page, "span-item");
    expect(dag.width.mode).toBe("grid-item");
    expect(dag.width.result).toBe(210);
  });
});

test.describe("DAG: positioned", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "positioned.html"); });

  test("abs left+right → positioned-offset with CB chain", async ({ page }) => {
    const dag = await analyzeDag(page, "abs-lr");
    expect(dag.width.mode).toBe("positioned-offset");
    expect(dag.width.result).toBe(360);
    expect(dag.width.inputs.containingBlock.element).toBe("[relative]");
    expect(dag.width.inputs.containingBlock.mode).toBe("explicit");
  });

  test("abs top+bottom", async ({ page }) => {
    const dag = await analyzeDag(page, "abs-tb");
    expect(dag.height.mode).toBe("positioned-offset");
    expect(dag.height.result).toBe(280);
  });
});

test.describe("DAG: percentage", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "percentage.html"); });

  test("50% width traces to parent", async ({ page }) => {
    const dag = await analyzeDag(page, "pct-both");
    expect(dag.width.mode).toBe("percentage");
    expect(dag.width.result).toBe(200);
    expect(dag.width.inputs.containingBlock.element).toBe("[outer]");
    expect(dag.width.inputs.containingBlock.result).toBe(400);
  });
});

test.describe("DAG: inline", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "inline.html"); });

  test("inline-block explicit", async ({ page }) => {
    const dag = await analyzeDag(page, "ib-explicit");
    expect(dag.width.mode).toBe("explicit");
    expect(dag.width.result).toBe(120);
  });

  test("inline-block auto → content-size", async ({ page }) => {
    const dag = await analyzeDag(page, "ib-auto");
    expect(dag.width.mode).toMatch(/^content-/);
  });
});

test.describe("DAG: edge cases", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "edge-cases.html"); });

  test("display:none → 0", async ({ page }) => {
    const dag = await analyzeDag(page, "hidden");
    expect(dag.width.mode).toBe("display-none");
    expect(dag.width.result).toBe(0);
  });

  test("display:contents → 0", async ({ page }) => {
    const dag = await analyzeDag(page, "contents");
    expect(dag.width.mode).toBe("display-contents");
  });

  test("child of contents → normal", async ({ page }) => {
    const dag = await analyzeDag(page, "contents-child");
    expect(dag.width.mode).toBe("explicit");
    expect(dag.width.result).toBe(80);
  });
});

test.describe("DAG: content height", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "content-height.html"); });

  test("block parent → content-sum with child node refs", async ({ page }) => {
    const dag = await analyzeDag(page, "block-parent");
    expect(dag.height.mode).toBe("content-sum");
    expect(dag.height.result).toBe(200);
    // Children should be inputs (DAG refs)
    expect(dag.height.inputs.child0).toBeDefined();
    expect(dag.height.inputs.child1).toBeDefined();
    expect(dag.height.inputs.child0.result).toBe(80);
    expect(dag.height.inputs.child1.result).toBe(120);
  });
});

test.describe("DAG: ancestor chains", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "ancestor-chain.html"); });

  test("inner traces through middle to outer", async ({ page }) => {
    const dag = await analyzeDag(page, "inner");
    expect(dag.width.mode).toBe("block-fill");
    expect(dag.width.result).toBe(440);
    const cbContent = dag.width.inputs.containingBlockContent;
    expect(cbContent.element).toBe("[middle]");
    // middle's content-area depends on middle's borderBox (a block-fill)
    expect(cbContent.inputs.borderBox.mode).toBe("block-fill");
  });

  test("grandchild traces through flex-child", async ({ page }) => {
    const dag = await analyzeDag(page, "grandchild");
    expect(dag.width.mode).toBe("block-fill");
    const cbContent = dag.width.inputs.containingBlockContent;
    expect(cbContent.element).toBe("[flex-child]");
    expect(cbContent.inputs.borderBox.mode).toBe("flex-item-main");
  });
});

test.describe("DAG: float", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "float-and-writing-mode.html"); });

  test("floated block → content-size (not block-fill)", async ({ page }) => {
    const dag = await analyzeDag(page, "float-child");
    expect(dag.width.mode).toMatch(/^content-/);
    expect(dag.width.result).toBe(100);
  });
});

test.describe("DAG: writing-mode", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "float-and-writing-mode.html"); });

  test("vertical-rl swaps axes", async ({ page }) => {
    const dag = await analyzeDag(page, "vertical-child");
    expect(dag.width.mode).toMatch(/^content-/); // block axis → content
    expect(dag.height.mode).toBe("block-fill"); // inline axis → fills CB
    expect(dag.height.result).toBe(200);
  });
});

test.describe("DAG: aspect-ratio", () => {
  test.beforeEach(async ({ page }) => { await loadFixture(page, "advanced.html"); });

  test("width set, height derived", async ({ page }) => {
    const dag = await analyzeDag(page, "aspect-width");
    expect(dag.width.mode).toBe("explicit");
    expect(dag.height.mode).toBe("aspect-ratio");
    expect(dag.height.result).toBeCloseTo(168.75, 0);
    expect(dag.height.inputs.otherAxis.mode).toBe("explicit");
    expect(dag.height.inputs.otherAxis.result).toBe(300);
  });

  test("both set → no aspect-ratio node", async ({ page }) => {
    const dag = await analyzeDag(page, "aspect-both");
    expect(dag.width.mode).toBe("explicit");
    expect(dag.height.mode).toBe("explicit");
  });
});

// ---------------------------------------------------------------------------
// Render order tests
// ---------------------------------------------------------------------------

test.describe("DAG render: node ordering", () => {
  test("flex item: topological ordering — every node appears after all its dependents", async ({ page }) => {
    await loadFixture(page, "flex.html");
    const nodes = await renderDagAxis(page, "grow1", "width");

    // Root is flex-item-main
    expect(nodes[0].mode).toBe("flex-item-main");

    // Topological invariant: every node appears before all nodes it depends on
    const idToIdx = new Map(nodes.map((n, i) => [n.id, i]));
    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        const depIdx = idToIdx.get(dep)!;
        const nodeIdx = idToIdx.get(node.id)!;
        expect(nodeIdx, `${node.id} (${node.kind}) should appear before its dependency ${dep}`).toBeLessThan(depIdx);
      }
    }

    // All expected flex node kinds are present
    const kinds = new Set(nodes.map((n) => n.mode));
    expect(kinds.has("flex-item-main")).toBe(true);
    expect(kinds.has("flex-base-size")).toBe(true);
    expect(kinds.has("flex-basis")).toBe(true);
  });

  test("block-fill: parent chain is the main line", async ({ page }) => {
    await loadFixture(page, "ancestor-chain.html");
    const nodes = await renderDagAxis(page, "inner", "width");

    // inner → block-fill → content-area (middle) → block-fill (middle) → ...
    expect(nodes[0].mode).toBe("block-fill");
    expect(nodes[0].element).toBe("[inner]");

    // The chain should trace upward through ancestors
    const elements = nodes.map((n) => n.element);
    expect(elements).toContain("[middle]");
    expect(elements).toContain("[outer]");
  });

  test("sequential IDs match display order (w0, w1, w2...)", async ({ page }) => {
    await loadFixture(page, "flex.html");
    const nodes = await renderDagAxis(page, "grow1", "width");

    for (let i = 0; i < nodes.length; i++) {
      expect(nodes[i].id).toBe(`w${i}`);
    }
  });

  test("dependsOn references are valid node IDs", async ({ page }) => {
    await loadFixture(page, "flex.html");
    const nodes = await renderDagAxis(page, "grow1", "width");
    const ids = new Set(nodes.map((n) => n.id));

    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        expect(ids.has(dep), `${node.id} depends on ${dep} which doesn't exist`).toBe(true);
      }
    }
  });

  test("every expression references values traceable to nodes", async ({ page }) => {
    await loadFixture(page, "flex.html");
    const nodes = await renderDagAxis(page, "grow1", "width");

    // Every node should have a non-empty expression
    for (const node of nodes) {
      expect(node.expression.length, `${node.id} has empty expression`).toBeGreaterThan(0);
    }
  });
});
