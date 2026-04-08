/**
 * Standard JSON serialization for DAG results and browser measurements.
 *
 * Used by: extension communication, fuzz oracle output, test helpers.
 * All types are JSON-safe (no live DOM references).
 */
import type { LayoutNode, DagResult, Axis, CalcExpr } from "./dag";
import { formatUnits } from "./units";
import { describeElement, round } from "./utils";

// ---------------------------------------------------------------------------
// Element path (CSS selector for DOM reconstruction)
// ---------------------------------------------------------------------------

export function getElementPath(el: Element): string {
  if (el === document.documentElement) return "html";
  if (el === document.body) return "body";
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break; }
    const parent: Element | null = current.parentElement;
    if (!parent) { parts.unshift(current.tagName.toLowerCase()); break; }
    const siblings = Array.from(parent.children);
    const index = siblings.indexOf(current) + 1;
    parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
    current = parent;
  }
  return parts.join(" > ");
}

// ---------------------------------------------------------------------------
// Serialized DAG types
// ---------------------------------------------------------------------------

/** A single node in the serialized DAG — flat references by ID. */
export interface SerializedNode {
  id: string;
  kind: string;
  mode: string;
  elementPath: string;
  elementDesc: string;
  axis: Axis;
  result: number;
  /** Input name → node ID (flat, not nested). */
  inputs: Record<string, string>;
  description: string;
  /** Serialized CalcExpr (refs converted to node ID strings). */
  calc: SerializedCalcExpr;
  /** Text expression derived from calc. */
  expr: string;
  cssProperties: Record<string, string>;
}

/** Full serialized DAG: flat node map with root references. */
export interface SerializedDag {
  target: { path: string; desc: string };
  rootWidth: string;
  rootHeight: string;
  nodes: Record<string, SerializedNode>;
}

// ---------------------------------------------------------------------------
// Browser measurements
// ---------------------------------------------------------------------------

export interface ElementMeasurement {
  path: string;
  desc: string;
  width: number;
  height: number;
}

/** Map of element path → actual browser measurement. */
export type BrowserMeasurements = Record<string, ElementMeasurement>;

// ---------------------------------------------------------------------------
// Verification result
// ---------------------------------------------------------------------------

export interface VerifyError {
  nodeId: string;
  kind: string;
  elementPath: string;
  axis: string;
  dagResult: number;
  actual: number;
  delta: number;
  /** Optional message for non-delta errors (e.g. terminal nodes). */
  message?: string;
}

export interface VerifyResult {
  ok: boolean;
  errors: VerifyError[];
  dag: SerializedDag;
  measurements: BrowserMeasurements;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Serialize a live DagResult into a JSON-safe flat structure. */
export function serializeDag(dag: DagResult): SerializedDag {
  const nodes: Record<string, SerializedNode> = {};
  const ids = new Map<LayoutNode, string>();
  let nextId = 0;

  function assignId(node: LayoutNode): string {
    const existing = ids.get(node);
    if (existing) return existing;
    const axis = node.kind.split(":")[1];
    const id = `${axis[0]}${nextId++}`;
    ids.set(node, id);
    return id;
  }

  function walk(node: LayoutNode): string {
    const existing = ids.get(node);
    if (existing) return existing;

    const id = assignId(node);
    const serializedInputs: Record<string, string> = {};
    for (const [key, dep] of Object.entries(node.inputs)) {
      if (dep) serializedInputs[key] = walk(dep);
    }

    nodes[id] = {
      id,
      kind: node.kind,
      mode: node.mode,
      elementPath: getElementPath(node.element),
      elementDesc: describeElement(node.element),
      axis: node.kind.split(":")[1] as Axis,
      result: node.result,
      inputs: serializedInputs,
      description: node.description,
      calc: serializeCalcExpr(node.calc, ids),
      expr: calcToText(node.calc),
      cssProperties: Object.fromEntries(
        Object.entries(node.cssProperties).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    };
    return id;
  }

  const rootWidth = walk(dag.width);
  const rootHeight = walk(dag.height);

  return {
    target: {
      path: getElementPath(dag.element),
      desc: describeElement(dag.element),
    },
    rootWidth,
    rootHeight,
    nodes,
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Measure all unique elements that appear in the DAG. */
export function measureElements(dag: DagResult): BrowserMeasurements {
  const measurements: BrowserMeasurements = {};
  const visited = new Set<Element>();

  const walkedNodes = new Set<LayoutNode>();
  function walk(node: LayoutNode): void {
    if (!node || walkedNodes.has(node)) return;
    walkedNodes.add(node);

    if (!visited.has(node.element)) {
      visited.add(node.element);
      const path = getElementPath(node.element);
      if (!measurements[path]) {
        const rect = node.element.getBoundingClientRect();
        measurements[path] = {
          path,
          desc: describeElement(node.element),
          width: round(rect.width),
          height: round(rect.height),
        };
      }
    }

    for (const dep of Object.values(node.inputs)) {
      if (dep) walk(dep);
    }
  }

  walk(dag.width);
  walk(dag.height);
  return measurements;
}

// ---------------------------------------------------------------------------
// Verification (oracle)
// ---------------------------------------------------------------------------

/** Modes whose results can be verified against browser measurements. */
const VERIFIABLE_MODES = new Set([
  "block-fill",
  "flex-item-main", "flex-cross-stretch", "flex-cross-content",
  "grid-item", "positioned-offset", "positioned-shrink-to-fit", "clamped",
]);

const TOLERANCE = 1;

export function verifyDag(dag: DagResult): VerifyResult {
  const serialized = serializeDag(dag);
  const measurements = measureElements(dag);
  const errors: VerifyError[] = [];

  const targetPath = serialized.target.path;
  const targetMeasurement = measurements[targetPath];
  if (targetMeasurement) {
    for (const axis of ["width", "height"] as const) {
      const rootId = axis === "width" ? serialized.rootWidth : serialized.rootHeight;
      const node = serialized.nodes[rootId];
      const actual = targetMeasurement[axis];
      if (actual > 0) {
        const delta = Math.abs(node.result - actual);
        if (delta > TOLERANCE) {
          errors.push({
            nodeId: rootId, kind: node.mode, elementPath: node.elementPath,
            axis, dagResult: node.result, actual, delta: round(delta),
          });
        }
      }
    }
  }

  const visited = new Set<string>();
  function checkNode(nodeId: string): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = serialized.nodes[nodeId];
    if (!node) return;

    // Terminal nodes from cycles or depth limits are errors (but measured
    // fallbacks from unmodeled layout modes like flex-wrap are expected)
    if (node.mode === "terminal" && node.description.includes("circular")) {
      errors.push({
        nodeId, kind: node.mode, elementPath: node.elementPath,
        axis: node.axis, dagResult: node.result, actual: node.result, delta: 0,
        message: node.description,
      });
    }

    if (VERIFIABLE_MODES.has(node.mode)) {
      const m = measurements[node.elementPath];
      if (m) {
        const actual = node.axis === "width" ? m.width : m.height;
        // Skip zero measurements (display:none ancestor, negative available space, etc.)
        if (actual > 0) {
          const delta = Math.abs(node.result - actual);
          if (delta > TOLERANCE) {
            const isRoot = nodeId === serialized.rootWidth || nodeId === serialized.rootHeight;
            if (!isRoot) {
              errors.push({
                nodeId, kind: node.mode, elementPath: node.elementPath,
                axis: node.axis, dagResult: node.result, actual, delta: round(delta),
              });
            }
          }
        }
      }
    }

    for (const depId of Object.values(node.inputs)) {
      checkNode(depId);
    }
  }

  checkNode(serialized.rootWidth);
  checkNode(serialized.rootHeight);

  return { ok: errors.length === 0, errors, dag: serialized, measurements };
}

// ---------------------------------------------------------------------------
// CalcExpr serialization helpers
// ---------------------------------------------------------------------------

export type SerializedCalcExpr =
  | { op: "ref"; nodeId: string }
  | { op: "constant"; value: number; unit: string }
  | { op: "property"; name: string; value: number; unit: string }
  | { op: "measured"; label: string; value: number; unit: string }
  | { op: "add"; args: SerializedCalcExpr[] }
  | { op: "sub"; left: SerializedCalcExpr; right: SerializedCalcExpr }
  | { op: "mul"; left: SerializedCalcExpr; right: SerializedCalcExpr }
  | { op: "div"; left: SerializedCalcExpr; right: SerializedCalcExpr }
  | { op: "max"; args: SerializedCalcExpr[] }
  | { op: "min"; args: SerializedCalcExpr[] };

function serializeCalcExpr(expr: CalcExpr, ids: Map<LayoutNode, string>): SerializedCalcExpr {
  switch (expr.op) {
    case "ref": return { op: "ref", nodeId: ids.get(expr.node) ?? "?" };
    case "constant": return { op: "constant", value: expr.value, unit: formatUnits(expr.unit) };
    case "property": return { op: "property", name: expr.name, value: expr.value, unit: formatUnits(expr.unit) };
    case "measured": return { op: "measured", label: expr.label, value: expr.value, unit: formatUnits(expr.unit) };
    case "add": return { op: "add", args: expr.args.map(a => serializeCalcExpr(a, ids)) };
    case "sub": return { op: "sub", left: serializeCalcExpr(expr.left, ids), right: serializeCalcExpr(expr.right, ids) };
    case "mul": return { op: "mul", left: serializeCalcExpr(expr.left, ids), right: serializeCalcExpr(expr.right, ids) };
    case "div": return { op: "div", left: serializeCalcExpr(expr.left, ids), right: serializeCalcExpr(expr.right, ids) };
    case "max": return { op: "max", args: expr.args.map(a => serializeCalcExpr(a, ids)) };
    case "min": return { op: "min", args: expr.args.map(a => serializeCalcExpr(a, ids)) };
  }
}

function fmtVal(value: number, unit: string): string {
  return unit ? `${value}${unit}` : String(value);
}

function calcToText(expr: CalcExpr): string {
  const u = formatUnits(expr.unit);
  switch (expr.op) {
    case "ref": return fmtVal(expr.node.result, u);
    case "constant": return fmtVal(expr.value, u);
    case "property": return `${fmtVal(expr.value, u)} (${expr.name})`;
    case "measured": return `${fmtVal(expr.value, u)} (${expr.label})`;
    case "add": return expr.args.map(calcToText).join(" + ");
    case "sub": return `${calcToText(expr.left)} \u2212 ${calcToText(expr.right)}`;
    case "mul": return `${calcToText(expr.left)} \u00d7 ${calcToText(expr.right)}`;
    case "div": return `${calcToText(expr.left)} / ${calcToText(expr.right)}`;
    case "max": return `max(${expr.args.map(calcToText).join(", ")})`;
    case "min": return `min(${expr.args.map(calcToText).join(", ")})`;
  }
}
