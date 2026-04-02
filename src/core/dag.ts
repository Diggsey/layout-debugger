/**
 * Layout Computation DAG — v4
 *
 * Every meaningful value is a node. Each node's result is computed from
 * a CalcExpr tree — the same tree is used for both the actual computation
 * and the UI presentation, so they can never get out of sync.
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
  | "flex-grow-factor"    // a sibling's flex-grow value
  | "flex-shrink-share"
  | "flex-scaled-shrink"  // flex-shrink × inner basis (shrink weighting)
  | "flex-no-change"
  | "flex-outer-hypo"     // sibling's outer hypothetical size (hypo + margin)
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
// CalcExpr — the computation tree
// ---------------------------------------------------------------------------

/**
 * Enforces that a number is a literal type (0, 1, 2, etc.) at compile time.
 * Rejects `number` but accepts `0 as const`, `1 as const`, etc.
 */
type LiteralNumber<T extends number> = number extends T ? never : T;

/** Unit of a CalcExpr value: "px" for dimensions, "" for unitless quantities. */
export type CalcUnit = "px" | "";

export type CalcExpr =
  | { op: "ref"; node: LayoutNode }                          // another node's result
  | { op: "constant"; value: number; unit: CalcUnit }        // spec-defined literal
  | { op: "property"; name: string; value: number; unit: CalcUnit } // CSS property
  | { op: "measured"; label: string; value: number; unit: CalcUnit } // browser measurement
  | { op: "add"; args: CalcExpr[] }                          // a + b + ...
  | { op: "sub"; left: CalcExpr; right: CalcExpr }           // a - b
  | { op: "mul"; left: CalcExpr; right: CalcExpr }           // a × b
  | { op: "div"; left: CalcExpr; right: CalcExpr }           // a ÷ b
  | { op: "max"; args: CalcExpr[] }                          // max(a, b, ...)
  | { op: "min"; args: CalcExpr[] };                         // min(a, b, ...)

/** Evaluate a CalcExpr tree to produce a number. */
export function evaluate(expr: CalcExpr): number {
  switch (expr.op) {
    case "ref": return expr.node.result;
    case "constant": return expr.value;
    case "property": return expr.value;
    case "measured": return expr.value;
    case "add": return expr.args.reduce((s, a) => s + evaluate(a), 0);
    case "sub": return evaluate(expr.left) - evaluate(expr.right);
    case "mul": return evaluate(expr.left) * evaluate(expr.right);
    case "div": {
      const d = evaluate(expr.right);
      return d === 0 ? 0 : evaluate(expr.left) / d;
    }
    case "max": return Math.max(...expr.args.map(evaluate));
    case "min": return Math.min(...expr.args.map(evaluate));
  }
}

/** Derive the unit of a CalcExpr from its structure. Throws on unit mismatches. */
export function calcUnit(expr: CalcExpr): CalcUnit {
  switch (expr.op) {
    case "ref": return calcUnit(expr.node.calc);
    case "constant": return expr.unit;
    case "property": return expr.unit;
    case "measured": return expr.unit;
    case "add": case "max": case "min": {
      const args = expr.op === "add" ? expr.args : expr.args;
      if (args.length === 0) return "";
      const first = calcUnit(args[0]);
      for (let i = 1; i < args.length; i++) {
        const u = calcUnit(args[i]);
        if (u !== first) throw new Error(`Unit mismatch in ${expr.op}: "${first}" vs "${u}"`);
      }
      return first;
    }
    case "sub": {
      const lu = calcUnit(expr.left), ru = calcUnit(expr.right);
      if (lu !== ru) throw new Error(`Unit mismatch in sub: "${lu}" vs "${ru}"`);
      return lu;
    }
    case "mul": {
      const lu = calcUnit(expr.left), ru = calcUnit(expr.right);
      if (lu === "px" && ru === "px") throw new Error("Cannot multiply px × px");
      return (lu === "px" || ru === "px") ? "px" : "";
    }
    case "div": {
      const lu = calcUnit(expr.left), ru = calcUnit(expr.right);
      if (lu === "" && ru === "px") throw new Error("Cannot divide unitless by px");
      return (lu === "px" && ru === "px") ? "" : lu;
    }
  }
}

/** Collect all CSS property names referenced in a CalcExpr tree. */
export function collectProperties(expr: CalcExpr): Record<string, string> {
  const props: Record<string, string> = {};
  function walk(e: CalcExpr): void {
    switch (e.op) {
      case "property": props[e.name] = e.unit ? `${e.value}${e.unit}` : String(e.value); break;
      case "measured": break;
      case "ref": break;
      case "constant": break;
      case "add": case "max": case "min": e.args.forEach(walk); break;
      case "sub": walk(e.left); walk(e.right); break;
      case "mul": walk(e.left); walk(e.right); break;
      case "div": walk(e.left); walk(e.right); break;
    }
  }
  walk(expr);
  return props;
}

// Unitless CSS properties (everything else is assumed px)
const UNITLESS_PROPS = new Set(["flex-grow", "flex-shrink", "aspect-ratio"]);

// Builder helpers
export const ref = (node: LayoutNode): CalcExpr => ({ op: "ref", node });
export function constant<T extends number>(n: LiteralNumber<T>, unit: CalcUnit = ""): CalcExpr { return { op: "constant", value: n, unit }; }
export function prop(el: Element, name: string): CalcExpr {
  const raw = getComputedStyle(el).getPropertyValue(name);
  const unit: CalcUnit = UNITLESS_PROPS.has(name) ? "" : "px";
  let value: number;
  if (raw.endsWith("px")) {
    value = parseFloat(raw);
  } else if (raw.includes("/")) {
    const parts = raw.split("/").map(s => parseFloat(s.trim()));
    value = parts.length === 2 && parts[1] !== 0 ? parts[0] / parts[1] : parseFloat(raw) || 0;
  } else {
    value = parseFloat(raw) || 0;
  }
  return { op: "property", name, value, unit };
}
export const measured = (label: string, value: number, unit: CalcUnit = "px"): CalcExpr =>
  ({ op: "measured", label, value, unit });
export const add = (...args: CalcExpr[]): CalcExpr => ({ op: "add", args });
export const sub = (left: CalcExpr, right: CalcExpr): CalcExpr => ({ op: "sub", left, right });
export const mul = (left: CalcExpr, right: CalcExpr): CalcExpr => ({ op: "mul", left, right });
export const div = (left: CalcExpr, right: CalcExpr): CalcExpr => ({ op: "div", left, right });
export const cmax = (...args: CalcExpr[]): CalcExpr => ({ op: "max", args });
export const cmin = (...args: CalcExpr[]): CalcExpr => ({ op: "min", args });

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export interface LayoutNode {
  kind: NodeKind;
  element: Element;
  axis: Axis;
  /** Cached result from evaluate(calc), rounded to 2dp. */
  result: number;
  /** One-line description of why this node type is relevant. */
  description: string;
  /** The computation tree — the sole source of truth for the result. */
  calc: CalcExpr;
  /** Named references to other nodes (the DAG edges for graph display). */
  inputs: Partial<Record<string, LayoutNode>>;
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
  /** CalcExpr for an element's border-box size (accounts for box-sizing). */
  borderBoxCalc(el: Element, axis: Axis): CalcExpr;
  make(
    kind: NodeKind, el: Element, axis: Axis,
    description: string, calc: CalcExpr,
    inputs: LayoutNode["inputs"],
    cssProperties?: LayoutNode["cssProperties"],
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
