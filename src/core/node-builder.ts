/**
 * NodeBuilder — fluent builder populated inside DagBuilder.create() callbacks.
 *
 * CSS reads delegate to the internal ElementProxy for automatic tracking.
 * Compute methods (computeSize, computeIntrinsicSize, etc.) delegate to
 * the layout module for recursive DAG construction.
 */
import type { NodeKind, NodeMode, Axis, CalcExpr, LayoutNode } from "./types";
import { ElementProxy, type CssPropertyName } from "./element-proxy";
import { evaluate, prop, propVal, add, cmax, cmin } from "./calc";
import type { DagBuilder } from "./dag-builder";
// Circular import — safe because these are only called at runtime, not during module init.
import { computeSize, computeIntrinsicSize } from "./layout";
import { containerContentArea, borderBoxCalc } from "./box-model";
import { round } from "./utils";

function pxParse(v: string): number { return parseFloat(v) || 0; }

function constraintCalc(proxy: ElementProxy, axis: Axis, constraintProp: CssPropertyName, boxSizing: string, resolvedPx?: number): CalcExpr {
  const base = resolvedPx !== undefined ? propVal(constraintProp, resolvedPx) : prop(proxy, constraintProp);
  if (boxSizing === "border-box") return base;
  if (axis === "width") {
    return add(base, prop(proxy, "padding-left"), prop(proxy, "padding-right"),
      prop(proxy, "border-left-width"), prop(proxy, "border-right-width"));
  }
  return add(base, prop(proxy, "padding-top"), prop(proxy, "padding-bottom"),
    prop(proxy, "border-top-width"), prop(proxy, "border-bottom-width"));
}

export class NodeBuilder {
  readonly element: Element;
  readonly proxy: ElementProxy;
  readonly depth: number;
  private _kind: NodeKind;
  private _mode: NodeMode = "terminal";
  private _builder: DagBuilder;
  private _inputs: LayoutNode["inputs"] = {};
  private _description = "";
  private _calc: CalcExpr | null = null;
  private _resultOverride: number | null = null;

  constructor(builder: DagBuilder, kind: NodeKind, element: Element, depth: number, proxy?: ElementProxy) {
    this._builder = builder;
    this._kind = kind;
    this.element = element;
    this.depth = depth;
    this.proxy = proxy ?? new ElementProxy(element);
  }

  // --- CSS property reads ---

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

  // --- Node description and calculation ---

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

  // --- Inputs ---

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

  // --- Sub-node creation ---

  /** Create a sub-node (delegates to DagBuilder). */
  create(kind: NodeKind, element: Element, cb: (nb: NodeBuilder) => void): LayoutNode {
    return this._builder.create(kind, element, this.depth, cb);
  }

  /** Check if a node is currently being built (cycle detection). */
  isBuilding(kind: NodeKind, element: Element): boolean {
    return this._builder.isBuilding(kind, element);
  }

  // --- Recursive computation methods ---

  /** Compute the size of an element on the given axis. Depth decrements automatically. */
  computeSize(el: Element, axis: Axis, depth = this.depth - 1): LayoutNode {
    return computeSize(this._builder, el, axis, depth);
  }

  /** Compute the intrinsic (content-based) size of an element. */
  computeIntrinsicSize(el: Element, axis: Axis, depth = this.depth - 1): LayoutNode {
    return computeIntrinsicSize(this._builder, el, axis, depth);
  }

  /** Compute the content-area node for a container (border-box minus padding/border). */
  containerContentArea(container: Element, axis: Axis, borderBoxNode: LayoutNode): LayoutNode {
    return containerContentArea(this, container, axis, borderBoxNode);
  }

  /** Build a CalcExpr for an element's border-box size. */
  borderBoxCalc(proxy: ElementProxy, axis: Axis): CalcExpr {
    return borderBoxCalc(proxy, axis);
  }

  // --- Post-processing ---

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

    // Resolve percentage constraints via the containing block DAG node
    let cbNode: LayoutNode | null = null;
    const getCbNode = (): LayoutNode => {
      if (!cbNode) {
        const cb = this.proxy.getContainingBlock();
        cbNode = this.computeSize(cb.element, axis);
      }
      return cbNode;
    };

    const resolveConstraint = (val: string, fallback: number): number => {
      if (val.endsWith("px")) return pxParse(val) + padBorder;
      if (val.endsWith("%")) {
        return (parseFloat(val) / 100) * getCbNode().result + padBorder;
      }
      return fallback;
    };

    const minPx = minVal === "auto" || minVal === "0px" || minVal === "0"
      ? 0 : resolveConstraint(minVal, 0);
    const maxPx = maxVal === "none" ? Infinity : resolveConstraint(maxVal, Infinity);

    if (result >= minPx && (maxPx === Infinity || result <= maxPx)) return;

    // Record the containing block as an input if we used it
    if (cbNode) this._inputs["constraintCB"] = cbNode;

    // Wrap calc with clamp — pass resolved px for percentage constraints
    const resolvedMax = maxVal.endsWith("%") ? round(maxPx - padBorder) : undefined;
    const resolvedMin = minVal.endsWith("%") ? round(minPx - padBorder) : undefined;
    if (maxPx !== Infinity && result > maxPx) {
      this._calc = cmin(constraintCalc(p, axis, maxPropName, boxSizing, resolvedMax), this._calc);
      this._mode = "clamped";
    } else {
      this._calc = cmax(constraintCalc(p, axis, minPropName, boxSizing, resolvedMin), this._calc);
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
