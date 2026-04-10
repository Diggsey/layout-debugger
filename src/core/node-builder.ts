/**
 * NodeBuilder — fluent builder populated inside DagBuilder.create() callbacks.
 *
 * CSS reads delegate to the internal ElementProxy for automatic tracking.
 * Compute methods (computeSize, computeIntrinsicSize, etc.) delegate to
 * the layout module for recursive DAG construction.
 */
import type { NodeKind, NodeMode, Axis, CalcExpr, LayoutNode } from "./types";
import { ElementProxy, type CssPropertyName } from "./element-proxy";
import { evaluate, prop, propVal, constant, add, sub, ref, cmax, cmin } from "./calc";
import { PX } from "./units";
import type { DagBuilder } from "./dag-builder";
// Circular import — safe because these are only called at runtime, not during module init.
import { computeSize, computeIntrinsicSize } from "./layout";
import { containerContentArea, borderBoxCalc } from "./box-model";
import { round, resolveCssLength } from "./utils";

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
    const totalPadBorder = axis === "width"
      ? p.readPx("padding-left") + p.readPx("padding-right") + p.readPx("border-left-width") + p.readPx("border-right-width")
      : p.readPx("padding-top") + p.readPx("padding-bottom") + p.readPx("border-top-width") + p.readPx("border-bottom-width");
    // For content-box, the dimension property is the content size, so
    // min/max in CSS px literals need padBorder added to get the border-box
    // value. For border-box, this is already 0.
    const padBorder = boxSizing !== "border-box" ? totalPadBorder : 0;

    const result = this._resultOverride ?? round(evaluate(this._calc));

    // Resolve percentage constraints via the containing block DAG node.
    // Per CSS spec, percentage min/max constraints only resolve against a
    // *definite* containing block size. If the CB is auto-sized, ignore them.
    // For grid items, the CB is the grid track — we don't model grid tracks
    // so skip percentage constraints there.
    //
    // The reference box for percentage resolution depends on position:
    // - Non-positioned (block/inline in normal flow): CB content box
    // - Absolutely positioned: CB padding box
    const position = p.readProperty("position");
    const isPositioned = position === "absolute" || position === "fixed";
    const lp = this.proxy.getLayoutParent();
    const lpDisplay = lp.readProperty("display");
    const isGridItem = !isPositioned && (lpDisplay === "grid" || lpDisplay === "inline-grid");

    // For single-track grids, the CB is the track which equals the container
    // content area. For multi-track grids, skip — we don't model track sizing.
    const gridSingleTrack = isGridItem && (() => {
      const trackProp = axis === "width" ? "grid-template-columns" : "grid-template-rows";
      const tracks = lp.readProperty(trackProp);
      // Computed value is a space-separated list of px lengths for each track.
      const parts = tracks.trim().split(/\s+/).filter(Boolean);
      return parts.length === 1 && parts[0].endsWith("px");
    })();

    let cbRefNode: LayoutNode | null = null;
    let cbDefinite: boolean | null = null;
    const getCbRef = (): LayoutNode | null => {
      if (cbDefinite === null) {
        if (isGridItem && !gridSingleTrack) {
          cbDefinite = false;
        } else {
          const cb = this.proxy.getContainingBlock();
          cbDefinite = axis === "width"
            || cb.element === document.documentElement
            || !!cb.getExplicitSize(axis);
        }
        if (cbDefinite) {
          const cb = this.proxy.getContainingBlock();
          const cbBorderBox = this.computeSize(cb.element, axis);
          if (isPositioned) {
            // Padding box = border box − border
            const borderProps = axis === "width"
              ? ["border-left-width", "border-right-width"] as const
              : ["border-top-width", "border-bottom-width"] as const;
            cbRefNode = this._builder.create(`padding-area:${axis}`, cb.element, this.depth, (cnb) => {
              cnb.setMode("content-area")
                .describe("Containing block padding box (for positioned percentage resolution)")
                .calc(sub(ref(cbBorderBox), add(...borderProps.map(pr => cnb.prop(pr)))))
                .input("borderBox", cbBorderBox);
            });
          } else {
            cbRefNode = containerContentArea(this, cb.element, axis, cbBorderBox);
          }
        }
      }
      return cbRefNode;
    };

    const resolveConstraint = (val: string, fallback: number): number => {
      if (val.endsWith("px")) return pxParse(val) + padBorder;
      // For anything involving percentages (including clamp/min/max), we need
      // the CB reference size.
      if (val.includes("%")) {
        const cbRef = getCbRef();
        if (!cbRef) return fallback;
        const resolved = resolveCssLength(val, cbRef.result);
        return resolved === null ? fallback : resolved + padBorder;
      }
      const resolved = resolveCssLength(val, 0);
      return resolved === null ? fallback : resolved + padBorder;
    };

    const minPx = minVal === "auto" || minVal === "0px" || minVal === "0"
      ? 0 : resolveConstraint(minVal, 0);
    const maxPx = maxVal === "none" ? Infinity : resolveConstraint(maxVal, Infinity);

    // CSS §10.4: clamped = max(min, min(max, value))
    const clamped = Math.max(minPx, Math.min(maxPx, result));
    if (Math.abs(clamped - result) <= 1) return; // Within tolerance

    // Record the containing block reference as an input if we used it
    if (cbRefNode) this._inputs["constraintCB"] = cbRefNode;

    // Wrap calc with clamp. For anything that's not a plain px literal
    // (percentages, calc/clamp/min/max functions), we need to pass the
    // resolved px explicitly — prop() would read computed style which for
    // CSS functions is the unresolved expression string.
    const needsResolvedMax = maxVal !== "none" && !maxVal.endsWith("px");
    const needsResolvedMin = minVal !== "auto" && minVal !== "0px" && minVal !== "0" && !minVal.endsWith("px");
    const resolvedMax = needsResolvedMax ? round(maxPx - padBorder) : undefined;
    const resolvedMin = needsResolvedMin ? round(minPx - padBorder) : undefined;
    const minCalc = minPx > 0 ? constraintCalc(p, axis, minPropName, boxSizing, resolvedMin) : null;
    const maxCalc = maxPx !== Infinity ? constraintCalc(p, axis, maxPropName, boxSizing, resolvedMax) : null;

    // The border-box can't shrink below its own padding+border sum.
    const pbFloor = totalPadBorder;
    if (maxCalc && minCalc) {
      // Both constraints: max(min, min(max, value))
      this._calc = cmax(minCalc, cmin(maxCalc, this._calc));
    } else if (maxCalc) {
      // Per CSS §10.4, when max < min, the result is min (default 0).
      // Additionally floor the border-box at its padding+border sum.
      this._calc = maxPx < pbFloor
        ? cmax(constant(pbFloor, PX), cmin(maxCalc, this._calc))
        : cmin(maxCalc, this._calc);
    } else if (minCalc) {
      this._calc = cmax(minCalc, this._calc);
    }
    this._mode = "clamped";
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
