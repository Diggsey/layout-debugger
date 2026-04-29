/**
 * NodeBuilder — fluent builder populated inside DagBuilder.create() callbacks.
 *
 * CSS reads delegate to the internal ElementProxy for automatic tracking.
 * Compute methods (computeSize, computeIntrinsicSize, etc.) delegate to
 * the layout module for recursive DAG construction.
 */
import type { NodeKind, NodeMode, Axis, CalcExpr, LayoutNode } from "./types";
import { ElementProxy, type CssPropertyName } from "./element-proxy";
import { evaluate, prop, propVal, add, sub, ref, cmax, cmin } from "./calc";
import type { DagBuilder } from "./dag-builder";
// Circular import — safe because these are only called at runtime, not during module init.
import { computeSize, computeIntrinsicSize } from "./layout";
import { containerContentArea, borderBoxCalc, isNodeDefinite } from "./box-model";
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

    // Tables size to fit their content: the table's min-content (sum of cell
    // min-widths) is a hard floor that overrides max-width per CSS §17.5.2.
    // getComputedStyle on a display:table element already returns the
    // content-adjusted used value, so applying max-width again would clamp
    // below what the browser actually laid out.
    const display = p.readProperty("display");
    if (display === "table" || display === "inline-table") return;

    // Orphan table-cells (display:table-cell whose layout parent isn't a
    // proper table-row context) get wrapped in anonymous tables. Percentage
    // min/max-width on the cell don't resolve against the inline-block or
    // block parent it visually appears in — Chrome treats them as auto
    // because the anonymous table's size is layout-dependent. Drop %
    // min/max-* on such orphan cells.
    if (display === "table-cell") {
      const lpForCell = this.proxy.getLayoutParent();
      const lpDisp = lpForCell.readProperty("display");
      const isProperTableContext =
        lpDisp === "table-row" || lpDisp === "table-row-group" ||
        lpDisp === "table-header-group" || lpDisp === "table-footer-group";
      if (!isProperTableContext) {
        const minIsPct = minVal.includes("%");
        const maxIsPct = maxVal.includes("%");
        if (minIsPct || maxIsPct) {
          // If only one of min/max is %, we could still apply the other.
          // But the simpler choice is to skip the clamp entirely for orphan
          // table-cells — Chrome's reported computed value already reflects
          // its actual layout decisions.
          if (minIsPct && maxVal === "none") return;
          if (maxIsPct && (minVal === "auto" || minVal === "0px" || minVal === "0")) return;
          // Mixed: bail to be safe.
          return;
        }
      }
    }

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

    // For grid items, the percentage CB is the grid area (one track). For
    // single-track grids or grids where every track is the same px size, we
    // can use the track size directly. Otherwise we can't determine which
    // track the item is in without modeling grid placement.
    //
    // grid-template-columns controls the inline axis of the grid, which in
    // vertical writing modes is the vertical (height) physical axis. We
    // need to pick the track property that matches the grid's block axis
    // for the element's physical axis.
    let gridTrackSize: number | null = null;
    if (isGridItem) {
      const gridWm = lp.readProperty("writing-mode");
      const gridIsVertical = gridWm === "vertical-rl" || gridWm === "vertical-lr"
        || gridWm === "sideways-rl" || gridWm === "sideways-lr";
      // In horizontal grid: columns → horizontal (width), rows → vertical (height).
      // In vertical grid: columns → vertical (height), rows → horizontal (width).
      const trackProp = gridIsVertical
        ? (axis === "width" ? "grid-template-rows" : "grid-template-columns")
        : (axis === "width" ? "grid-template-columns" : "grid-template-rows");
      const tracks = lp.readProperty(trackProp);
      const parts = tracks.trim().split(/\s+/).filter(Boolean);
      if (parts.length > 0 && parts.every(p => p.endsWith("px"))) {
        const sizes = parts.map(p => parseFloat(p));
        // All tracks equal → any track's size works as the CB.
        if (sizes.every(s => Math.abs(s - sizes[0]) < 0.01)) {
          gridTrackSize = sizes[0];
        }
      }
    }
    const gridSingleTrack = isGridItem && gridTrackSize !== null;

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
          // A percentage size is only definite if its own CB is definite.
          // Walk the chain to find a content-sized terminus (e.g. flex/grid
          // container with no explicit size, standalone table-cell whose
          // percentage height doesn't resolve).
          if (!isNodeDefinite(cbBorderBox)) {
            cbDefinite = false;
          }
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
          } else if (gridTrackSize !== null) {
            // Grid item with a known track size — use the track as CB.
            cbRefNode = this._builder.create(`padding-area:${axis}`, cb.element, this.depth, (cnb) => {
              cnb.setMode("content-area")
                .describe("Grid track size (for grid item percentage resolution)")
                .calc(propVal(axis, round(gridTrackSize)))
                .input("borderBox", cbBorderBox);
            });
          } else {
            cbRefNode = containerContentArea(this, cb.element, axis, cbBorderBox);
          }
        }
      }
      return cbRefNode;
    };

    // resolveConstraint returns either the resolved px, or null if the value
    // couldn't be resolved (e.g. percentage against an indefinite CB).
    const resolveConstraint = (val: string): number | null => {
      if (val.endsWith("px")) return pxParse(val) + padBorder;
      if (val.includes("%")) {
        const cbRef = getCbRef();
        if (!cbRef) return null;
        const resolved = resolveCssLength(val, cbRef.result);
        return resolved === null ? null : resolved + padBorder;
      }
      const resolved = resolveCssLength(val, 0);
      return resolved === null ? null : resolved + padBorder;
    };

    const minResolved = minVal === "auto" || minVal === "0px" || minVal === "0"
      ? 0 : resolveConstraint(minVal);
    const maxResolved = maxVal === "none" ? Infinity : resolveConstraint(maxVal);

    // If either bound is unresolved (e.g. percentage against an indefinite
    // CB), skip clamping: browsers resolve these against layout-dependent
    // sizes, and clamping with just the other bound could be wrong if
    // min > max. The computed value we already have reflects the browser's
    // real clamped result.
    if (minResolved === null || maxResolved === null) return;

    const minPx = minResolved;
    const maxPx = maxResolved;

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
    const pbProps = axis === "width"
      ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
      : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
    const pbFloor = totalPadBorder;
    if (maxCalc && minCalc) {
      // Both constraints: max(min, min(max, value))
      this._calc = cmax(minCalc, cmin(maxCalc, this._calc));
    } else if (maxCalc) {
      // Per CSS §10.4, when max < min, the result is min (default 0).
      // Additionally floor the border-box at its padding+border sum.
      this._calc = maxPx < pbFloor
        ? cmax(add(...pbProps.map(pr => prop(p, pr))), cmin(maxCalc, this._calc))
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
