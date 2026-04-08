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

// ---------------------------------------------------------------------------
// Builder helpers — each computes and stores the unit at construction time
// ---------------------------------------------------------------------------

export function ref(node: LayoutNode): CalcExpr {
  return { op: "ref", node, unit: calcUnit(node.calc) };
}

export function constant<T extends number>(n: LiteralNumber<T>, unit: Units = UNITLESS): CalcExpr {
  return { op: "constant", value: n, unit };
}

/** Create a property CalcExpr with an explicit value (when getComputedStyle returns the wrong value). */
export function propVal(name: string, value: number, unit: Units = PX): CalcExpr {
  return { op: "property", name, value, unit };
}

export function prop(el: Element, name: string): CalcExpr {
  const raw = getComputedStyle(el).getPropertyValue(name);
  let value: number;
  let unit: Units;
  if (raw.endsWith("px")) {
    value = parseFloat(raw);
    unit = PX;
  } else if (raw.includes("/")) {
    // Ratio value like "16 / 9" → unitless
    const parts = raw.split("/").map(s => parseFloat(s.trim()));
    value = parts.length === 2 && parts[1] !== 0 ? parts[0] / parts[1] : parseFloat(raw) || 0;
    unit = UNITLESS;
  } else {
    value = parseFloat(raw) || 0;
    unit = UNITLESS;
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
  /** Reason why each contextual CSS property was read (not part of the calculation). */
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
  borderBoxCalc(el: Element, axis: Axis): CalcExpr;
  measured(el: Element, axis: Axis, kind: NodeKind): LayoutNode;
  get(kind: NodeKind, element: Element, axis: Axis): LayoutNode | undefined;
  begin(kind: NodeKind, element: Element, axis: Axis): NodeBuilder | undefined;
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

  /** Create a NodeBuilder without registering a kind (set lazily via setKind). */
  create(element: Element, axis: Axis): NodeBuilder {
    return new NodeBuilder(this, element, axis);
  }

  /** Create a NodeBuilder with a known kind (registers for cycle detection). */
  begin(kind: NodeKind, element: Element, axis: Axis): NodeBuilder {
    const nb = this.create(element, axis);
    nb.setKind(kind);
    return nb;
  }

  /** Register a kind as building (cycle guard). */
  markBuilding(kind: NodeKind, element: Element, axis: Axis): void {
    this.building.add(this.key(kind, element, axis));
  }

  /** Register a completed node. Prefer NodeBuilder.finish() instead. */
  finish(node: LayoutNode): LayoutNode {
    // Auto-collect CSS properties from all prop() nodes in the CalcExpr.
    // Manual cssProperties entries take precedence (spread order).
    node.cssProperties = { ...collectProperties(node.calc), ...node.cssProperties };
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

// ---------------------------------------------------------------------------
// Auto-reason generation for CSS property reads
// ---------------------------------------------------------------------------

const REASON_TABLE: Record<string, string> = {
  "display":          "Determines box generation and layout mode",
  "position":         "Determines positioning scheme",
  "flex-basis":       "Starting size before flex distribution",
  "flex-grow":        "Growth factor relative to siblings",
  "flex-shrink":      "Shrink factor relative to siblings",
  "flex-direction":   "Determines main vs cross axis",
  "flex-wrap":        "Single-line vs multi-line flex",
  "align-self":       "Cross-axis alignment of this item",
  "align-items":      "Container default for cross-axis alignment",
  "box-sizing":       "Whether padding/border are included in size",
  "overflow":         "Affects minimum size calculation",
  "aspect-ratio":     "Ratio between width and height",
  "writing-mode":     "Determines inline vs block axis direction",
  "min-width":        "Minimum width constraint",
  "max-width":        "Maximum width constraint",
  "min-height":       "Minimum height constraint",
  "max-height":       "Maximum height constraint",
  "left":             "Left offset from containing block",
  "right":            "Right offset from containing block",
  "top":              "Top offset from containing block",
  "bottom":           "Bottom offset from containing block",
};

function autoReason(key: string): string {
  const prop = key.startsWith("parent.") ? key.slice(7) : key;
  return REASON_TABLE[prop] ?? "";
}

// ---------------------------------------------------------------------------
// ElementProxy — tracks CSS property reads on an element
// ---------------------------------------------------------------------------

/**
 * Wraps an element for tracked CSS reads. Every `readProperty()` call
 * records the property name + value. Use `getParent()` to create a
 * proxy for the parent element whose reads are prefixed with "parent.".
 */
export class ElementProxy {
  readonly element: Element;
  private _style: CSSStyleDeclaration;
  private _prefix: string;
  private _records: [key: string, value: string][];

  constructor(element: Element, records?: [string, string][], prefix = "") {
    this.element = element;
    this._style = getComputedStyle(element);
    this._prefix = prefix;
    this._records = records ?? [];
  }

  /** Read a CSS property, record it, and return the value. */
  readProperty(name: string): string {
    const val = this._style.getPropertyValue(name);
    const key = this._prefix ? `${this._prefix}.${name}` : name;
    this._records.push([key, val]);
    return val;
  }

  /** Create a proxy for the parent element. Reads are prefixed with "parent.". */
  getParent(): ElementProxy {
    return new ElementProxy(this.element.parentElement!, this._records, "parent");
  }

  /** Record a synthetic CSS property (e.g. "auto" when computed style differs). */
  record(name: string, value: string): void {
    const key = this._prefix ? `${this._prefix}.${name}` : name;
    this._records.push([key, value]);
  }

  /** Drain recorded reads into target maps. Existing keys are not overwritten. */
  drainInto(props: Record<string, string>, reasons: Record<string, string>): void {
    for (const [key, value] of this._records) {
      if (!(key in props)) {
        props[key] = value;
        const reason = autoReason(key);
        if (reason) reasons[key] = reason;
      }
    }
    this._records = [];
  }
}

// ---------------------------------------------------------------------------
// NodeBuilder — builds a LayoutNode with automatic CSS property tracking
// ---------------------------------------------------------------------------

function round(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Fluent builder for a LayoutNode. CSS reads delegate to the internal
 * ElementProxy for automatic tracking with generated reasons.
 * Kind can be set lazily via setKind() after construction.
 */
export class NodeBuilder {
  readonly element: Element;
  readonly axis: Axis;
  readonly proxy: ElementProxy;
  private _kind: NodeKind | null = null;
  private _builder: DagBuilder;
  private _inputs: LayoutNode["inputs"] = {};
  private _description = "";
  private _calc: CalcExpr | null = null;

  constructor(builder: DagBuilder, element: Element, axis: Axis) {
    this._builder = builder;
    this.element = element;
    this.axis = axis;
    this.proxy = new ElementProxy(element);
  }

  /** Set the node kind (registers with DagBuilder for cycle detection). */
  setKind(kind: NodeKind): this {
    this._kind = kind;
    this._builder.markBuilding(kind, this.element, this.axis);
    return this;
  }

  /** Read a CSS property value (string) on this element, auto-recorded. */
  css(name: string): string {
    return this.proxy.readProperty(name);
  }

  /** Read a CSS property as a pixel number on this element, auto-recorded. */
  cssPx(name: string): number {
    return parseFloat(this.css(name)) || 0;
  }

  /** Create a CalcExpr property node for this element's CSS property. */
  prop(name: string): CalcExpr {
    return prop(this.element, name);
  }

  /** Record a CSS property with a synthetic value (e.g. "auto" when computed style differs). */
  setCss(name: string, value: string): this {
    this.proxy.record(name, value);
    return this;
  }

  /** Set the human-readable description. */
  describe(description: string): this {
    this._description = description;
    return this;
  }

  /** Look up a cached node. */
  get(kind: NodeKind, element: Element, axis: Axis): LayoutNode | undefined {
    return this._builder.get(kind, element, axis);
  }

  /** Check if a node is currently being built (cycle detection). */
  isBuilding(kind: NodeKind, element: Element, axis: Axis): boolean {
    return this._builder.isBuilding(kind, element, axis);
  }

  /** Create a sub-node builder with a known kind. */
  begin(kind: NodeKind, element: Element, axis: Axis): NodeBuilder {
    return this._builder.begin(kind, element, axis);
  }

  /** Set the CalcExpr for the node. */
  calc(calc: CalcExpr): this {
    this._calc = calc;
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

  private _build(result: number): LayoutNode {
    if (!this._kind) throw new Error("NodeBuilder: kind must be set before finish()");
    if (!this._calc) throw new Error("NodeBuilder: calc must be set before finish()");
    const cssProperties: Record<string, string> = {};
    const cssReasons: Record<string, string> = {};
    this.proxy.drainInto(cssProperties, cssReasons);
    return this._builder.finish({
      kind: this._kind, element: this.element, axis: this.axis,
      result,
      description: this._description, calc: this._calc,
      inputs: this._inputs, cssProperties, cssReasons,
    });
  }

  /** Build the LayoutNode. Result is computed from the CalcExpr. */
  finish(): LayoutNode {
    return this._build(round(evaluate(this._calc!)));
  }

  /** Build the LayoutNode with an explicit result (when calc doesn't exactly match the measured value). */
  finishWithResult(result: number): LayoutNode {
    return this._build(result);
  }
}
