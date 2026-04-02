/**
 * Layout Computation DAG — v4
 *
 * Every meaningful value is a node. Each node's result is computed from
 * a CalcExpr tree — the same tree is used for both the actual computation
 * and the UI presentation, so they can never get out of sync.
 */

import { type Units, UNITLESS, PX, unitsMul, unitsDiv, unitsAssertEqual, formatUnits } from "./units";

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
  | "intrinsic"
  // Block
  | "content-area"
  | "block-fill"
  // Content-driven
  | "content-sum"
  | "content-max"
  | "intrinsic-content"
  // Flex
  | "flex-basis"
  | "min-content"
  | "flex-base-size"
  | "flex-free-space"
  | "flex-grow-share"
  | "flex-grow-factor"
  | "flex-shrink-share"
  | "flex-scaled-shrink"
  | "flex-no-change"
  | "flex-outer-hypo"
  | "flex-item-main"
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

type LiteralNumber<T extends number> = number extends T ? never : T;

/**
 * Every CalcExpr variant carries a `unit: Units` computed at construction.
 * CalcExprs are immutable — the unit is fixed when the node is built.
 */
export type CalcExpr =
  | { op: "ref"; node: LayoutNode; unit: Units }
  | { op: "constant"; value: number; unit: Units }
  | { op: "property"; name: string; value: number; unit: Units }
  | { op: "measured"; label: string; value: number; unit: Units }
  | { op: "add"; args: CalcExpr[]; unit: Units }
  | { op: "sub"; left: CalcExpr; right: CalcExpr; unit: Units }
  | { op: "mul"; left: CalcExpr; right: CalcExpr; unit: Units }
  | { op: "div"; left: CalcExpr; right: CalcExpr; unit: Units }
  | { op: "max"; args: CalcExpr[]; unit: Units }
  | { op: "min"; args: CalcExpr[]; unit: Units };

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

/** Get the unit of a CalcExpr (already computed at construction). */
export function calcUnit(expr: CalcExpr): Units {
  return expr.unit;
}

/** Collect all CSS property names referenced in a CalcExpr tree. */
export function collectProperties(expr: CalcExpr): Record<string, string> {
  const props: Record<string, string> = {};
  function walk(e: CalcExpr): void {
    switch (e.op) {
      case "property": {
        const suffix = formatUnits(e.unit);
        props[e.name] = suffix ? `${e.value}${suffix}` : String(e.value);
        break;
      }
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

// ---------------------------------------------------------------------------
// Builder helpers — each computes and stores the unit at construction time
// ---------------------------------------------------------------------------

export function ref(node: LayoutNode): CalcExpr {
  return { op: "ref", node, unit: calcUnit(node.calc) };
}

export function constant<T extends number>(n: LiteralNumber<T>, unit: Units = UNITLESS): CalcExpr {
  return { op: "constant", value: n, unit };
}

export function prop(el: Element, name: string): CalcExpr {
  const raw = getComputedStyle(el).getPropertyValue(name);
  const unit: Units = UNITLESS_PROPS.has(name) ? UNITLESS : PX;
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

export function measured(label: string, value: number, unit: Units = PX): CalcExpr {
  return { op: "measured", label, value, unit };
}

export function add(...args: CalcExpr[]): CalcExpr {
  if (args.length === 0) return { op: "add", args, unit: UNITLESS };
  const unit = args[0].unit;
  for (let i = 1; i < args.length; i++) {
    unitsAssertEqual(unit, args[i].unit, "add");
  }
  return { op: "add", args, unit };
}

export function sub(left: CalcExpr, right: CalcExpr): CalcExpr {
  unitsAssertEqual(left.unit, right.unit, "sub");
  return { op: "sub", left, right, unit: left.unit };
}

export function mul(left: CalcExpr, right: CalcExpr): CalcExpr {
  return { op: "mul", left, right, unit: unitsMul(left.unit, right.unit) };
}

export function div(left: CalcExpr, right: CalcExpr): CalcExpr {
  return { op: "div", left, right, unit: unitsDiv(left.unit, right.unit) };
}

export function cmax(...args: CalcExpr[]): CalcExpr {
  if (args.length === 0) return { op: "max", args, unit: UNITLESS };
  const unit = args[0].unit;
  for (let i = 1; i < args.length; i++) {
    unitsAssertEqual(unit, args[i].unit, "max");
  }
  return { op: "max", args, unit };
}

export function cmin(...args: CalcExpr[]): CalcExpr {
  if (args.length === 0) return { op: "min", args, unit: UNITLESS };
  const unit = args[0].unit;
  for (let i = 1; i < args.length; i++) {
    unitsAssertEqual(unit, args[i].unit, "min");
  }
  return { op: "min", args, unit };
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export interface LayoutNode {
  kind: NodeKind;
  element: Element;
  axis: Axis;
  result: number;
  description: string;
  calc: CalcExpr;
  inputs: Partial<Record<string, LayoutNode>>;
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

export interface SizeFns {
  computeSize(el: Element, axis: Axis, depth: number): LayoutNode;
  computeIntrinsicSize(el: Element, axis: Axis, depth: number): LayoutNode;
  contentSize(el: Element, axis: Axis, depth: number, intrinsic?: boolean): LayoutNode;
  containerContentArea(container: Element, axis: Axis, borderBoxNode: LayoutNode): LayoutNode;
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

  get(kind: NodeKind, element: Element, axis: Axis): LayoutNode | undefined {
    return this.nodes.get(this.key(kind, element, axis));
  }

  isBuilding(kind: NodeKind, element: Element, axis: Axis): boolean {
    return this.building.has(this.key(kind, element, axis));
  }

  begin(kind: NodeKind, element: Element, axis: Axis): void {
    this.building.add(this.key(kind, element, axis));
  }

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
