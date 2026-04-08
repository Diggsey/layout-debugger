/**
 * Layout Computation DAG — v5
 *
 * Every meaningful value is a node. Each node's result is computed from
 * a CalcExpr tree — the same tree is used for both the actual computation
 * and the UI presentation, so they can never get out of sync.
 */

import { type Units, UNITLESS, PX, unitsMul, unitsDiv, unitsAssertEqual, formatUnits } from "./units";
import { ElementProxy, type CssPropertyName } from "./element-proxy";

export { ElementProxy } from "./element-proxy";
export type { ExplicitSize, CssPropertyName } from "./element-proxy";

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

/** Base kind — what the node represents, independent of axis. */
export type BaseKind =
  | "size"             // top-level element size
  | "content-area"     // container padding-box content area
  | "content"          // content-driven size (mode distinguishes sum vs max)
  | "intrinsic"        // intrinsic/content-based size
  | "flex-basis"       // flex starting size
  | "flex-base-size"   // hypothetical main size (clamped basis)
  | "flex-free-space"  // remaining space in flex container
  | "flex-share"       // grow or shrink share
  | "flex-outer-hypo"  // outer hypothetical (+ margins)
  | "flex-grow-factor"  // flex-grow factor
  | "flex-shrink-factor" // scaled shrink factor
  | "min-content"      // minimum content size
  | "max-constraint"   // max-width/height constraint node
  | "measured";        // browser-measured terminal node

export type Axis = "width" | "height";

/** Dedup key — one node per (NodeKind, Element). Axis is baked in. */
export type NodeKind = `${BaseKind}:${Axis}`;

/** Describes the calculation approach. Purely descriptive metadata. */
export type NodeMode =
  | "viewport" | "display-none" | "display-contents"
  | "explicit" | "percentage" | "intrinsic-keyword" | "aspect-ratio"
  | "block-fill" | "flex-item-main" | "flex-cross-stretch" | "flex-cross-content"
  | "grid-item" | "positioned-offset" | "positioned-shrink-to-fit"
  | "table-cell" | "content-sum" | "content-max" | "clamped"
  | "terminal" | "intrinsic-content"
  | "flex-basis" | "flex-grow-share" | "flex-shrink-share" | "flex-no-change"
  | "min-content-auto" | "min-content-explicit"
  | "flex-base-size" | "flex-free-space" | "flex-outer-hypo"
  | "flex-grow-factor" | "flex-scaled-shrink"
  | "content-area"
  | "content-driven";

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

// ---------------------------------------------------------------------------
// Builder helpers — each computes and stores the unit at construction time
// ---------------------------------------------------------------------------

export function ref(node: LayoutNode): CalcExpr {
  return { op: "ref", node, unit: calcUnit(node.calc) };
}

export function constant<T extends number>(n: LiteralNumber<T>, unit: Units = UNITLESS): CalcExpr {
  return { op: "constant", value: n, unit };
}

/** Create a CalcExpr property node by reading a CSS property via an ElementProxy. */
export function prop(proxy: ElementProxy, name: CssPropertyName): CalcExpr {
  const raw = proxy.readProperty(name);
  let value: number;
  let unit: Units;
  if (raw.endsWith("px")) {
    value = parseFloat(raw);
    unit = PX;
  } else if (raw.includes("/")) {
    const parts = raw.split("/").map(s => parseFloat(s.trim()));
    value = parts.length === 2 && parts[1] !== 0 ? parts[0] / parts[1] : parseFloat(raw) || 0;
    unit = UNITLESS;
  } else {
    value = parseFloat(raw) || 0;
    unit = UNITLESS;
  }
  return { op: "property", name, value, unit };
}

/** Create a property CalcExpr with an explicit value (when computed style returns the wrong value). */
export function propVal(name: CssPropertyName, value: number, unit: Units = PX): CalcExpr {
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
  mode: NodeMode;
  element: Element;
  result: number;
  description: string;
  calc: CalcExpr;
  inputs: Partial<Record<string, LayoutNode>>;
  cssProperties: Partial<Record<string, string>>;
  cssReasons: Partial<Record<string, string>>;
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
  borderBoxCalc(proxy: ElementProxy, axis: Axis): CalcExpr;
  create(kind: NodeKind, element: Element, cb: (nb: NodeBuilder) => void): LayoutNode;
}

// ---------------------------------------------------------------------------
// DagBuilder — node cache with deduplication
// ---------------------------------------------------------------------------

function round(n: number): number { return Math.round(n * 100) / 100; }

export class CycleError extends Error {
  constructor(public kind: NodeKind, public element: Element) {
    super(`Cycle detected for ${kind}`);
  }
}

type NodeKey = `${number}:${NodeKind}`;

export class DagBuilder {
  private nodes = new Map<NodeKey, LayoutNode>();
  private building = new Set<NodeKey>();
  private elIds = new WeakMap<Element, number>();
  private nextElId = 0;

  /**
   * The single node creation path. Returns cached node if it exists,
   * otherwise calls cb to build it.
   *
   * cb receives a NodeBuilder to populate (describe, calc, inputs, etc.)
   * and returns nothing. The node is finished automatically after cb returns.
   */
  create(kind: NodeKind, element: Element, cb: (nb: NodeBuilder) => void): LayoutNode {
    const key = this.key(kind, element);
    const cached = this.nodes.get(key);
    if (cached) return cached;

    if (this.building.has(key)) {
      throw new CycleError(kind, element);
    }
    this.building.add(key);
    const nb = new NodeBuilder(this, kind, element);
    try {
      cb(nb);
      return nb._finish();
    } catch (e) {
      // Clean up building state if cb throws (e.g. CycleError from a sub-node)
      this.building.delete(key);
      throw e;
    }
  }

  /** Check if a node is currently being built (cycle detection). */
  isBuilding(kind: NodeKind, element: Element): boolean {
    return this.building.has(this.key(kind, element));
  }

  /** Register a completed node (called by NodeBuilder._finish). */
  _register(kind: NodeKind, node: LayoutNode): void {
    node.cssProperties = { ...collectProperties(node.calc), ...node.cssProperties };
    const key = this.key(node.kind, node.element);
    this.building.delete(key);
    this.nodes.set(key, node);
  }

  private elementId(element: Element): number {
    let id = this.elIds.get(element);
    if (id === undefined) {
      id = this.nextElId++;
      this.elIds.set(element, id);
    }
    return id;
  }

  private key(kind: NodeKind, element: Element): NodeKey {
    return `${this.elementId(element)}:${kind}`;
  }
}

// ---------------------------------------------------------------------------
// NodeBuilder — fluent builder populated inside DagBuilder.create() callbacks
// ---------------------------------------------------------------------------

/**
 * Fluent builder for a LayoutNode. CSS reads delegate to the internal
 * ElementProxy for automatic tracking with generated reasons.
 *
 * Created by DagBuilder.create() — populated inside the callback,
 * then finished automatically.
 */
export class NodeBuilder {
  readonly element: Element;
  readonly proxy: ElementProxy;
  private _kind: NodeKind;
  private _mode: NodeMode = "terminal";
  private _builder: DagBuilder;
  private _inputs: LayoutNode["inputs"] = {};
  private _description = "";
  private _calc: CalcExpr | null = null;
  private _resultOverride: number | null = null;

  constructor(builder: DagBuilder, kind: NodeKind, element: Element, proxy?: ElementProxy) {
    this._builder = builder;
    this._kind = kind;
    this.element = element;
    this.proxy = proxy ?? new ElementProxy(element);
  }

  /** Set the mode (calculation approach). */
  setMode(mode: NodeMode): this {
    this._mode = mode;
    return this;
  }

  /** Read a CSS property value (string) on this element, auto-recorded. */
  css(name: CssPropertyName): string {
    return this.proxy.readProperty(name);
  }

  /** Read a CSS property as a pixel number on this element, auto-recorded. */
  cssPx(name: CssPropertyName): number {
    return parseFloat(this.css(name)) || 0;
  }

  /** Create a CalcExpr property node for this element's CSS property. */
  prop(name: CssPropertyName): CalcExpr {
    return prop(this.proxy, name);
  }

  /** Set the human-readable description. */
  describe(description: string): this {
    this._description = description;
    return this;
  }

  /** Set the CalcExpr for the node. */
  calc(calc: CalcExpr): this {
    this._calc = calc;
    return this;
  }

  /** Override the computed result (when calc doesn't exactly match the measured value). */
  overrideResult(result: number): this {
    this._resultOverride = result;
    return this;
  }

  /** Add named input nodes. */
  inputs(inputs: LayoutNode["inputs"]): this {
    Object.assign(this._inputs, inputs);
    return this;
  }

  /** Add a single named input node. */
  input(name: string, node: LayoutNode): this {
    this._inputs[name] = node;
    return this;
  }

  /** Create a sub-node (delegates to DagBuilder). */
  create(kind: NodeKind, element: Element, cb: (nb: NodeBuilder) => void): LayoutNode {
    return this._builder.create(kind, element, cb);
  }

  /** Check if a node is currently being built (cycle detection). */
  isBuilding(kind: NodeKind, element: Element): boolean {
    return this._builder.isBuilding(kind, element);
  }

  /** Apply min/max constraints as a post-processing step. */
  maybeClamp(axis: Axis): void {
    if (!this._calc) return;
    const p = this.proxy;
    const minPropName = axis === "width" ? "min-width" : "min-height";
    const maxPropName = axis === "width" ? "max-width" : "max-height";
    const minVal = p.readProperty(minPropName);
    const maxVal = p.readProperty(maxPropName);

    const boxSizing = p.readProperty("box-sizing");
    const padBorder = boxSizing !== "border-box"
      ? (axis === "width"
        ? p.readPx("padding-left") + p.readPx("padding-right") + p.readPx("border-left-width") + p.readPx("border-right-width")
        : p.readPx("padding-top") + p.readPx("padding-bottom") + p.readPx("border-top-width") + p.readPx("border-bottom-width"))
      : 0;

    const result = this._resultOverride ?? round(evaluate(this._calc));
    const minPx = minVal === "auto" || minVal === "0px" ? 0 : px(minVal) + padBorder;
    const maxPx = maxVal === "none" ? Infinity : px(maxVal) + padBorder;

    if (result >= minPx && (maxPx === Infinity || result <= maxPx)) return;

    // Wrap calc with clamp
    if (maxPx !== Infinity && result > maxPx) {
      this._calc = cmin(constraintCalc(p, axis, maxPropName, boxSizing), this._calc);
      this._mode = "clamped";
    } else {
      this._calc = cmax(constraintCalc(p, axis, minPropName, boxSizing), this._calc);
      this._mode = "clamped";
    }
  }

  /** Finish building the node and register it. Called by DagBuilder.create(). */
  _finish(): LayoutNode {
    if (!this._calc) throw new Error("NodeBuilder: calc must be set before finish");
    const cssProperties: Record<string, string> = {};
    const cssReasons: Record<string, string> = {};
    this.proxy.drainInto(cssProperties, cssReasons);
    const result = this._resultOverride ?? round(evaluate(this._calc));
    const node: LayoutNode = {
      kind: this._kind, mode: this._mode, element: this.element,
      result,
      description: this._description, calc: this._calc,
      inputs: this._inputs, cssProperties, cssReasons,
    };
    this._builder._register(this._kind, node);
    return node;
  }
}

// ---------------------------------------------------------------------------
// Helpers for maybeClamp
// ---------------------------------------------------------------------------

function px(v: string): number { return parseFloat(v) || 0; }

function constraintCalc(proxy: ElementProxy, axis: Axis, constraintProp: CssPropertyName, boxSizing: string): CalcExpr {
  const base = prop(proxy, constraintProp);
  if (boxSizing === "border-box") return base;
  if (axis === "width") {
    return add(base, prop(proxy, "padding-left"), prop(proxy, "padding-right"),
      prop(proxy, "border-left-width"), prop(proxy, "border-right-width"));
  }
  return add(base, prop(proxy, "padding-top"), prop(proxy, "padding-bottom"),
    prop(proxy, "border-top-width"), prop(proxy, "border-bottom-width"));
}
