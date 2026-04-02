/**
 * Standard JSON serialization for DAG results and browser measurements.
 *
 * Used by: extension communication, fuzz oracle output, test helpers.
 * All types are JSON-safe (no live DOM references).
 */
import type { LayoutNode, DagResult, Axis } from "./dag";
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
  elementPath: string;
  elementDesc: string;
  axis: Axis;
  result: number;
  /** Input name → node ID (flat, not nested). */
  inputs: Record<string, string>;
  literals: Record<string, number>;
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
    const id = `${node.axis[0]}${nextId++}`;
    ids.set(node, id);
    return id;
  }

  function walk(node: LayoutNode): string {
    const existing = ids.get(node);
    if (existing) return existing;

    const id = assignId(node);
    // Walk inputs first (so child IDs are assigned)
    const serializedInputs: Record<string, string> = {};
    for (const [key, dep] of Object.entries(node.inputs)) {
      if (dep) serializedInputs[key] = walk(dep);
    }

    nodes[id] = {
      id,
      kind: node.kind,
      elementPath: getElementPath(node.element),
      elementDesc: describeElement(node.element),
      axis: node.axis,
      result: node.result,
      inputs: serializedInputs,
      literals: node.literals as Record<string, number>,
      expr: node.expr,
      cssProperties: node.cssProperties as Record<string, string>,
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

  function walk(node: LayoutNode): void {
    if (!node || visited.has(node.element)) {
      // Still walk inputs even if element was seen (different nodes, same element)
      if (node) {
        for (const dep of Object.values(node.inputs)) {
          if (dep) walk(dep);
        }
      }
      return;
    }
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

/** Kinds whose result is a computed border-box size that should match getBoundingClientRect. */
const VERIFIABLE_KINDS = new Set([
  "block-fill", "flex-item-main", "flex-cross-stretch", "flex-cross-content",
  "grid-item", "positioned-offset", "positioned-shrink-to-fit", "clamped",
]);

const TOLERANCE = 1;

/** Verify a DAG against the browser's actual layout. Returns structured results. */
export function verifyDag(dag: DagResult): VerifyResult {
  const serialized = serializeDag(dag);
  const measurements = measureElements(dag);
  const errors: VerifyError[] = [];

  // Check root results
  const targetPath = serialized.target.path;
  const targetMeasurement = measurements[targetPath];
  if (targetMeasurement) {
    for (const axis of ["width", "height"] as const) {
      const rootId = axis === "width" ? serialized.rootWidth : serialized.rootHeight;
      const node = serialized.nodes[rootId];
      const actual = targetMeasurement[axis];
      const delta = Math.abs(node.result - actual);
      if (delta > TOLERANCE) {
        errors.push({
          nodeId: rootId, kind: node.kind, elementPath: node.elementPath,
          axis, dagResult: node.result, actual, delta: round(delta),
        });
      }
    }
  }

  // Check all verifiable nodes
  const visited = new Set<string>();
  function checkNode(nodeId: string): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = serialized.nodes[nodeId];
    if (!node) return;

    if (VERIFIABLE_KINDS.has(node.kind)) {
      const m = measurements[node.elementPath];
      if (m) {
        const actual = node.axis === "width" ? m.width : m.height;
        const delta = Math.abs(node.result - actual);
        if (delta > TOLERANCE) {
          // Avoid duplicate with root check
          const isRoot = nodeId === serialized.rootWidth || nodeId === serialized.rootHeight;
          if (!isRoot) {
            errors.push({
              nodeId, kind: node.kind, elementPath: node.elementPath,
              axis: node.axis, dagResult: node.result, actual, delta: round(delta),
            });
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
