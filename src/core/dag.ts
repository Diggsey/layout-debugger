/**
 * Layout Computation DAG — v3
 *
 * Every meaningful value is a node. Nodes reference other nodes via `inputs`.
 * The DagBuilder deduplicates by (kind, element, axis) and serves as
 * the recursion guard — if a node is already being built, return early.
 */

// ---------------------------------------------------------------------------
// Node kinds — exhaustive union
// ---------------------------------------------------------------------------

export type NodeKind =
  // Terminals
  | "viewport"
  | "explicit"
  | "display-none"
  | "display-contents"
  | "terminal"
  | "intrinsic" // intrinsic sizing keyword (min-content, max-content, fit-content)
  // Block
  | "content-area" // container border-box minus padding/border
  | "block-fill" // auto-width block fills containing block content area
  // Content-driven
  | "content-sum" // size from stacked children
  | "content-max" // size from tallest/widest child
  | "intrinsic-content" // element's content-based size (ignoring stretch/fill/percentage)
  // Flex
  | "flex-basis"
  | "min-content"
  | "flex-base-size" // max(basis, min-content)
  | "flex-free-space" // container - items - gaps
  | "flex-grow-share"
  | "flex-shrink-share"
  | "flex-no-change"
  | "flex-item-main" // base + share
  | "flex-cross-stretch"
  | "flex-cross-content"
  // Grid
  | "grid-item"
  // Positioned
  | "positioned-offset"
  | "positioned-shrink-to-fit"
  // Percentage
  | "percentage"
  // Aspect ratio
  | "aspect-ratio"
  // Constraints
  | "clamped"
  // Table
  | "table-cell";

export type Axis = "width" | "height";

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export interface LayoutNode {
  kind: NodeKind;
  element: Element;
  axis: Axis;
  result: number;
  /** Named references to other nodes (the DAG edges). */
  inputs: Partial<Record<string, LayoutNode>>;
  /** Named literal values from CSS properties or constants. */
  literals: Partial<Record<string, number>>;
  /** Human-readable expression: how result = f(inputs, literals). */
  expr: string;
  /** Relevant CSS properties (including absent-but-relevant defaults). */
  cssProperties: Partial<Record<string, string>>;
}

export interface DagResult {
  element: Element;
  width: LayoutNode;
  height: LayoutNode;
}

// ---------------------------------------------------------------------------
// Callback interface for analyzer functions
// ---------------------------------------------------------------------------

/**
 * Functions passed to per-display-mode analyzer modules so they can recurse
 * into the DAG builder without importing build-dag.ts (avoids circular deps).
 */
export interface SizeFns {
  computeSize(el: Element, axis: Axis, depth: number): LayoutNode;
  computeIntrinsicSize(el: Element, axis: Axis, depth: number): LayoutNode;
  contentSize(el: Element, axis: Axis, depth: number, intrinsic?: boolean): LayoutNode;
  containerContentArea(container: Element, axis: Axis, borderBoxNode: LayoutNode): LayoutNode;
  make(
    kind: NodeKind, el: Element, axis: Axis, result: number,
    inputs: LayoutNode["inputs"], literals: LayoutNode["literals"],
    expr: string, cssProperties?: LayoutNode["cssProperties"],
  ): LayoutNode;
  measured(el: Element, axis: Axis, kind: NodeKind): LayoutNode;
}

// ---------------------------------------------------------------------------
// Builder with deduplication + recursion guard
// ---------------------------------------------------------------------------

type NodeKey = `${number}:${NodeKind}:${Axis}`;

export class DagBuilder {
  private nodes = new Map<NodeKey, LayoutNode>();
  private building = new Set<NodeKey>();
  private elIds = new WeakMap<Element, number>();
  private nextElId = 0;

  /** Get an existing node if already built. */
  get(kind: NodeKind, element: Element, axis: Axis): LayoutNode | undefined {
    return this.nodes.get(this.key(kind, element, axis));
  }

  /** Check if a node is currently being built (recursion guard). */
  isBuilding(kind: NodeKind, element: Element, axis: Axis): boolean {
    return this.building.has(this.key(kind, element, axis));
  }

  /** Mark a node as being built. Call `finish` when done. */
  begin(kind: NodeKind, element: Element, axis: Axis): void {
    this.building.add(this.key(kind, element, axis));
  }

  /** Store a finished node. */
  finish(node: LayoutNode): LayoutNode {
    const key = this.key(node.kind, node.element, node.axis);
    this.building.delete(key);
    this.nodes.set(key, node);
    return node;
  }

  private elementId(element: Element): number {
    let id = this.elIds.get(element);
    if (id === undefined) {
      id = this.nextElId++;
      this.elIds.set(element, id);
    }
    return id;
  }

  private key(kind: NodeKind, element: Element, axis: Axis): NodeKey {
    return `${this.elementId(element)}:${kind}:${axis}`;
  }
}
