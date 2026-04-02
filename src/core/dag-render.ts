/**
 * DAG renderer: linearizes a DagResult for display.
 *
 * Uses DFS pre-order so the "main chain" (first dependency of each node)
 * appears immediately below its parent — like git log --first-parent.
 */
import type { DagResult, LayoutNode } from "./dag";
import { describeElement } from "./utils";

/** A segment of a calculation string: either plain text or a value linked to a node. */
export interface CalcSegment {
  text: string;
  /** If set, this segment is a value that came from the node with this ID. */
  refId?: string;
}

export interface RenderNode {
  id: string;
  element: Element;
  elementDesc: string;
  kind: string;
  axis: "width" | "height";
  result: number;
  /** One-line context: why this node type is relevant. */
  description: string;
  /** Detailed calculation with values tagged by source node ID (for hover). */
  calculation: CalcSegment[];
  expression: string;
  cssProperties: Record<string, string | undefined>;
  dependsOn: string[];
}

export interface AxisRender {
  axis: "width" | "height";
  result: number;
  nodes: RenderNode[];
}

export interface DagRenderResult {
  element: Element;
  elementDesc: string;
  width: AxisRender;
  height: AxisRender;
}

export function renderDag(dag: DagResult): DagRenderResult {
  return {
    element: dag.element,
    elementDesc: describeElement(dag.element),
    width: renderAxis(dag.width, "width"),
    height: renderAxis(dag.height, "height"),
  };
}

function renderAxis(root: LayoutNode, axis: "width" | "height"): AxisRender {
  // DFS pre-order: visit node, then first dep (main chain), then other deps.
  // This produces a linearization where the main chain is contiguous.
  const visited = new Map<LayoutNode, string>();
  const order: LayoutNode[] = [];

  /**
   * Input keys that refer to "local" computations (same element) should be
   * visited first (main line), while keys that refer to parent/container
   * dependencies should branch off.
   *
   * Lower number = visited first = main line (column 0).
   * Higher number = visited later = branches right.
   */
  /**
   * Lower = main line (column 0, visited first).
   * Higher = branches right (visited later).
   *
   * The main line follows the parent/container chain — that's the primary
   * "where does this size come from?" story. Same-element detail nodes
   * (basis, min-content) are secondary and branch off.
   */
  const INPUT_ORDER: Record<string, number> = {
    // Parent/container chain — main line (follows "where does this come from?")
    containingBlockContent: 0,
    containingBlock: 0,
    containerCross: 0,
    containerContent: 0,
    container: 0,     // grid container
    freeSpace: 0,
    borderBox: 0,
    input: 0,         // clamped → unclamped value
    growShare: 0,      // flex: share depends on container free space
    otherAxis: 0,      // aspect-ratio: derived from other axis

    // Same-element detail / content children — branches right
    baseSize: 10,
    basis: 10,
    minContent: 10,
    content: 10,       // flex-cross-content, positioned-shrink-to-fit → content
  };

  function inputPriority(key: string): number {
    if (key in INPUT_ORDER) return INPUT_ORDER[key];
    if (key.startsWith("child")) return 10; // content children branch right
    return 5; // unknown — middle
  }

  function visit(node: LayoutNode): void {
    if (visited.has(node)) return;
    visited.set(node, "");
    order.push(node);

    // Sort inputs for DFS visit order:
    // - Side branches (higher priority) visited first → appear right after parent
    // - Main chain (lower priority) visited last → continues below branches
    // - When equal priority, visit later entries first (reverse insertion order)
    //   so the first entry (dependsOn[0] = main column) continues last on the left
    const entries = Object.entries(node.inputs).filter(([, v]) => v) as [string, LayoutNode][];
    entries.sort((a, b) => {
      const pa = inputPriority(a[0]);
      const pb = inputPriority(b[0]);
      if (pa !== pb) return pb - pa; // higher priority first
      return entries.indexOf(b) - entries.indexOf(a); // reverse insertion order
    });
    for (const [, dep] of entries) {
      visit(dep);
    }
  }

  visit(root);

  // Assign sequential IDs in display order
  order.forEach((node, i) => visited.set(node, `${axis[0]}${i}`));

  const nodes: RenderNode[] = order.map((node) => {
    const id = visited.get(node)!;
    return {
      id,
      element: node.element,
      elementDesc: describeElement(node.element),
      kind: node.kind,
      axis: node.axis,
      result: node.result,
      description: nodeDescription(node),
      calculation: nodeCalculation(node, visited),
      expression: node.expr,
      cssProperties: node.cssProperties,
      dependsOn: (Object.entries(node.inputs).filter(([, v]) => v) as [string, LayoutNode][])
        .sort((a, b) => inputPriority(a[0]) - inputPriority(b[0]))
        .map(([, dep]) => visited.get(dep)!),
    };
  });

  return { axis, result: root.result, nodes };
}

// ---------------------------------------------------------------------------
// Human-readable descriptions and calculations
// ---------------------------------------------------------------------------

/** One-line description: why is this node type relevant? */
function nodeDescription(node: LayoutNode): string {
  const el = describeElement(node.element);
  const ax = node.axis;
  switch (node.kind) {
    case "explicit":
      return `${ax} is set explicitly in CSS`;
    case "percentage":
      return `${ax} is a percentage of the containing block`;
    case "block-fill":
      return `Block element — ${ax} fills the available space in its parent`;
    case "content-area":
      return `Usable space inside ${el} after subtracting padding and border`;
    case "content-sum": {
      const hasChildren = Object.keys(node.inputs).some((k) => k.startsWith("child"));
      return hasChildren
        ? `${ax} is determined by stacking its children`
        : `${ax} is determined by its text/inline content`;
    }
    case "content-max": {
      const hasChildren = Object.keys(node.inputs).some((k) => k.startsWith("child"));
      return hasChildren
        ? `${ax} is determined by its tallest/widest child`
        : `${ax} is determined by its content`;
    }
    case "flex-item-main":
      return `Flex item — ${ax} determined by the flex layout algorithm`;
    case "flex-basis":
      return `Starting size before flex grow/shrink is applied`;
    case "min-content":
      return `Minimum ${ax} the element can be without overflowing its content`;
    case "flex-base-size":
      return `Effective starting size — the larger of the basis and min-content`;
    case "flex-free-space":
      return `Space remaining in the flex container after all items are placed at their base size`;
    case "flex-grow-share":
      return `Portion of free space allocated to this item by flex-grow`;
    case "flex-shrink-share":
      return `Amount this item shrinks to fit in the container`;
    case "flex-no-change":
      return `This item does not grow or shrink`;
    case "flex-cross-stretch":
      return `Flex item stretches on the cross axis to fill the container`;
    case "flex-cross-content":
      return `Flex item cross-axis size is determined by its content`;
    case "grid-item":
      return `Grid item — ${ax} determined by the grid track it occupies`;
    case "positioned-offset":
      return `Absolutely positioned — ${ax} derived from opposing offsets`;
    case "positioned-shrink-to-fit":
      return `Absolutely positioned — ${ax} shrinks to fit content`;
    case "aspect-ratio":
      return `${ax} derived from the other axis via aspect-ratio`;
    case "clamped":
      return `Constrained by min/max`;
    case "viewport":
      return `Size of the browser viewport`;
    case "intrinsic":
      return `${ax} uses an intrinsic sizing keyword`;
    case "display-none":
      return `Element is hidden (display: none)`;
    case "display-contents":
      return `Element has no box (display: contents)`;
    case "table-cell":
      return `Table cell — ${ax} determined by the table layout algorithm`;
    case "intrinsic-content": {
      const display = node.cssProperties.display ?? "block";
      let method = "content";
      if (display === "flex" || display === "inline-flex") {
        const dir = getComputedStyle(node.element).flexDirection;
        method = ax === (dir.startsWith("column") ? "height" : "width")
          ? "sum of flex items on main axis"
          : "tallest flex item on cross axis";
      } else if (display === "grid" || display === "inline-grid") {
        method = "grid track sizes";
      } else {
        method = "stacked block children";
      }
      return `Intrinsic ${ax} (display: ${display}) — content-based size from ${method}, before stretching`;
    }
    case "terminal":
      return `Measured size (computation depth limit reached)`;
    default:
      return "";
  }
}

/**
 * Detailed calculation with values tagged by their source node ID.
 * Each segment is either plain text or a value that can be hovered
 * to highlight the node it came from.
 */
function nodeCalculation(
  node: LayoutNode,
  nodeIds: Map<LayoutNode, string>,
): CalcSegment[] {
  // Helper: create a tagged value segment
  function val(n: LayoutNode): CalcSegment {
    return { text: `${n.result}px`, refId: nodeIds.get(n) };
  }
  function lit(v: number, suffix = "px"): CalcSegment {
    return { text: `${v}${suffix}` };
  }
  function txt(s: string): CalcSegment {
    return { text: s };
  }

  const inputs = node.inputs;
  const lits = node.literals;

  switch (node.kind) {
    case "block-fill": {
      const cb = inputs.containingBlockContent;
      const margin = (lits.marginStart ?? 0) + (lits.marginEnd ?? 0);
      if (!cb) return [txt(node.expr)];
      return [
        val(cb), txt(" − "), lit(margin), txt(" margins = "), lit(node.result),
      ];
    }
    case "content-area": {
      const bb = inputs.borderBox;
      if (!bb) return [txt(node.expr)];
      return [
        val(bb), txt(" − "), lit(lits.paddingBorder ?? 0), txt(" padding+border = "), lit(node.result),
      ];
    }
    case "percentage": {
      const cb = inputs.containingBlock;
      if (!cb) return [txt(node.expr)];
      const pct = node.cssProperties[node.axis] ?? "?%";
      return [
        val(cb), txt(` × ${pct} = `), lit(node.result),
      ];
    }
    case "flex-item-main": {
      const base = inputs.baseSize;
      const share = inputs.growShare;
      if (!base || !share) return [txt(node.expr)];
      return [
        val(base), txt(" + "), val(share), txt(" = "), lit(node.result),
      ];
    }
    case "flex-base-size": {
      const basis = inputs.basis;
      const mc = inputs.minContent;
      if (!basis || !mc) return [txt(node.expr)];
      return [
        txt("max("), val(basis), txt(", "), val(mc), txt(") = "), lit(node.result),
      ];
    }
    case "flex-grow-share": {
      const fs = inputs.freeSpace;
      const grow = lits.growFactor ?? 0;
      const total = lits.totalGrowFactors ?? 0;
      if (!fs) return [txt(node.expr)];
      return [
        lit(grow, ""), txt("/"), lit(total, ""), txt(" × "), val(fs), txt(" = "), lit(node.result),
      ];
    }
    case "flex-shrink-share": {
      const fs = inputs.freeSpace;
      if (!fs) return [txt(node.expr)];
      return [txt("shrink share from "), val(fs), txt(` = ${node.result}px`)];
    }
    case "flex-free-space": {
      const cc = inputs.containerContent;
      if (!cc) return [txt(node.expr)];
      return [
        val(cc), txt(" − "), lit(lits.totalItemBases ?? 0), txt(" items − "),
        lit(lits.totalGaps ?? 0), txt(" gaps = "), lit(node.result),
      ];
    }
    case "clamped": {
      const inp = inputs.input;
      if (!inp) return [txt(node.expr)];
      return [
        txt("clamp("), lit(lits.min ?? 0), txt(", "), val(inp),
        txt(", "), lit(lits.max ?? Infinity), txt(") = "), lit(node.result),
      ];
    }
    case "positioned-offset": {
      const cb = inputs.containingBlock;
      if (!cb) return [txt(node.expr)];
      const start = Object.entries(lits).find(([k]) => k === "left" || k === "top");
      const end = Object.entries(lits).find(([k]) => k === "right" || k === "bottom");
      return [
        val(cb),
        txt(` − ${start ? start[1] : "?"}px (${start ? start[0] : "?"}) − ${end ? end[1] : "?"}px (${end ? end[0] : "?"}) − spacing = `),
        lit(node.result),
      ];
    }
    case "aspect-ratio": {
      const other = inputs.otherAxis;
      if (!other) return [txt(node.expr)];
      return [
        val(other), txt(` × ${lits.ratio ?? "?"} = `), lit(node.result),
      ];
    }
    case "flex-cross-stretch": {
      const cc = inputs.containerCross;
      if (!cc) return [txt(node.expr)];
      return [txt("stretches to "), val(cc)];
    }
    case "flex-cross-content": {
      const c = inputs.content;
      if (!c) return [txt(node.expr)];
      return [txt("from content: "), val(c)];
    }
    case "positioned-shrink-to-fit": {
      const c = inputs.content;
      if (!c) return [txt(node.expr)];
      return [txt("shrink-to-fit from content: "), val(c)];
    }
    case "grid-item": {
      const c = inputs.container;
      if (!c) return [txt(node.expr)];
      return [txt("grid tracks in "), val(c), txt(` → ${node.result}px`)];
    }
    case "content-sum":
    case "content-max": {
      const children = Object.entries(inputs)
        .filter(([k, v]) => k.startsWith("child") && v) as [string, LayoutNode][];
      children.sort(([a], [b]) => a.localeCompare(b));
      if (children.length === 0) return [txt(node.expr)];
      const segs: CalcSegment[] = [];
      const op = node.kind === "content-sum" ? " + " : ", ";
      for (let i = 0; i < children.length; i++) {
        if (i > 0) segs.push(txt(op));
        segs.push(val(children[i][1]));
      }
      const gapTotal = lits.totalGap ?? 0;
      if (gapTotal > 0) { segs.push(txt(` + ${gapTotal}px gaps`)); }
      segs.push(txt(` = ${node.result}px`));
      return segs;
    }
    case "intrinsic-content": {
      const c = inputs.content;
      if (!c) return [txt(node.expr)];
      return [txt("intrinsic size from content: "), val(c)];
    }
    default:
      return [txt(node.expr)];
  }
}

// --- Console renderer ---

export function renderDagToConsole(dag: DagResult): void {
  const rendered = renderDag(dag);

  console.group(
    `%cWhy is %o %s × %s?`,
    "font-size: 13px; font-weight: bold",
    dag.element,
    `${rendered.width.result}px`,
    `${rendered.height.result}px`,
  );

  console.group("%cWidth: %s", "font-weight: bold; color: #8ab4f8", `${rendered.width.result}px`);
  for (const node of rendered.width.nodes) logNode(node);
  console.groupEnd();

  console.group("%cHeight: %s", "font-weight: bold; color: #81c995", `${rendered.height.result}px`);
  for (const node of rendered.height.nodes) logNode(node);
  console.groupEnd();

  console.groupEnd();
}

function logNode(node: RenderNode): void {
  const deps = node.dependsOn.length > 0 ? ` ← ${node.dependsOn.join(", ")}` : "";
  console.groupCollapsed(
    `%c[${node.id}]%c ${node.kind} %c${node.result}px%c ${node.elementDesc}%c${deps}`,
    "color: #9aa0a6",
    "color: #d2a8ff",
    "color: #7ee787; font-weight: bold",
    "color: #58a6ff",
    "color: #484f58",
  );
  console.log(node.expression);
  const props = Object.entries(node.cssProperties).filter(([, v]) => v != null);
  if (props.length > 0) console.table(Object.fromEntries(props));
  console.log("%o", node.element);
  console.groupEnd();
}
