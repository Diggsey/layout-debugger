/**
 * Core types for the layout computation DAG.
 *
 * Pure type definitions — no runtime code, no imports beyond Units.
 */
import type { Units } from "./units";

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
