/**
 * DAG renderer: linearizes a DagResult for display.
 *
 * Uses topological sort (via layoutDag) so shared dependencies appear
 * below all their parents. Side branches are placed before the main line.
 */
import type { DagResult, LayoutNode, CalcExpr } from "./dag";
import { layoutDag, type DagInput } from "./dag-layout";
import { formatUnits } from "./units";
import { describeElement } from "./utils";

/** A segment of a calculation string: either plain text or a value linked to a node. */
export interface CalcSegment {
  text: string;
  /** If set, this segment is a value that came from the node with this ID. */
  refId?: string;
  /** If set, this is a CSS property or measured value with this label. */
  label?: string;
}

export interface RenderNode {
  id: string;
  element: Element;
  elementDesc: string;
  kind: string;
  mode: string;
  axis: "width" | "height";
  result: number;
  /** Formatted unit suffix for the result (e.g. "px", "", "px²"). */
  resultUnit: string;
  /** One-line context: why this node type is relevant. */
  description: string;
  /** Detailed calculation with values tagged by source node ID (for hover). */
  calculation: CalcSegment[];
  expression: string;
  cssProperties: Record<string, string | undefined>;
  cssReasons: Record<string, string | undefined>;
  dependsOn: string[];
}

export interface AxisRender {
  axis: "width" | "height";
  result: number;
  nodes: RenderNode[];
}

export interface DagRenderResult {
  element: Element;
  elementDesc: string;
  width: AxisRender;
  height: AxisRender;
}

export function renderDag(dag: DagResult): DagRenderResult {
  return {
    element: dag.element,
    elementDesc: describeElement(dag.element),
    width: renderAxis(dag.width, "width"),
    height: renderAxis(dag.height, "height"),
  };
}

/** Priority for input keys — lower = main line, higher = side branch. */
const INPUT_ORDER: Record<string, number> = {
  containingBlockContent: 0, containingBlock: 0, containerCross: 0,
  containerContent: 0, container: 0, freeSpace: 0, borderBox: 0,
  input: 0, growShare: 0, otherAxis: 0,
  baseSize: 10, basis: 10, minContent: 10, content: 10,
};

function inputPriority(key: string): number {
  if (key in INPUT_ORDER) return INPUT_ORDER[key];
  if (key.startsWith("child")) return 10;
  return 5;
}

/** Get a node's dependencies sorted by input priority (main line first). */
function sortedInputs(node: LayoutNode): [string, LayoutNode][] {
  return Object.entries(node.inputs)
    .filter((entry): entry is [string, LayoutNode] => entry[1] !== undefined)
    .sort((a, b) => inputPriority(a[0]) - inputPriority(b[0]));
}

function renderAxis(root: LayoutNode, axis: "width" | "height"): AxisRender {
  // Step 1: Collect all reachable nodes
  const allNodes: LayoutNode[] = [];
  const seen = new Set<LayoutNode>();
  function collect(n: LayoutNode): void {
    if (seen.has(n)) return;
    seen.add(n);
    allNodes.push(n);
    for (const v of Object.values(n.inputs)) if (v) collect(v);
  }
  collect(root);

  // Step 2: Map LayoutNode ↔ temporary index
  const nodeToIdx = new Map<LayoutNode, number>();
  allNodes.forEach((n, i) => nodeToIdx.set(n, i));

  // Step 3: Build DagInput (children sorted by input priority)
  const dagInput: DagInput[] = allNodes.map((n) => ({
    id: String(nodeToIdx.get(n)!),
    children: sortedInputs(n).map(([, dep]) => String(nodeToIdx.get(dep)!)),
  }));

  // Step 4: Compute topological order via layoutDag
  const layout = layoutDag(dagInput);

  // Step 5: Map back to LayoutNodes in topological order, assign display IDs
  const order = layout.order.map(id => allNodes[parseInt(id)]);
  const nodeIds = new Map<LayoutNode, string>();
  order.forEach((node, i) => nodeIds.set(node, `${axis[0]}${i}`));

  // Step 6: Build RenderNodes
  const nodes: RenderNode[] = order.map((node) => {
    const id = nodeIds.get(node)!;
    const calculation = calcToSegments(node.calc, nodeIds);
    const expression = calculation.map((s) => s.text).join("");

    // Extract axis from kind (e.g. "size:width" → "width")
    const nodeAxis = node.kind.split(":")[1] as "width" | "height";

    return {
      id,
      element: node.element,
      elementDesc: describeElement(node.element),
      kind: node.kind,
      mode: node.mode,
      axis: nodeAxis,
      result: node.result,
      resultUnit: formatUnits(node.calc.unit),
      description: node.description,
      calculation,
      expression,
      cssProperties: node.cssProperties,
      cssReasons: node.cssReasons,
      dependsOn: sortedInputs(node).map(([, dep]) => nodeIds.get(dep)!),
    };
  });

  return { axis, result: root.result, nodes };
}

// ---------------------------------------------------------------------------
// CalcExpr → CalcSegment[] conversion
// ---------------------------------------------------------------------------

/** Operator precedence levels for parenthesization. */
function precedence(op: string): number {
  switch (op) {
    case "add": case "sub": return 1;
    case "mul": case "div": return 2;
    default: return 3; // leaf, max, min — no parens needed
  }
}

/** Format a number with its unit suffix. */
function fmtValue(value: number, unit: string): string {
  return unit ? `${value}${unit}` : String(value);
}

/**
 * Convert a CalcExpr tree into a flat array of CalcSegments for display.
 * Handles operator precedence with parentheses and proper unit display.
 */
function calcToSegments(
  expr: CalcExpr,
  nodeIds: Map<LayoutNode, string>,
  parentPrec = 0,
  isRightOfNonAssoc = false,
): CalcSegment[] {
  const myPrec = precedence(expr.op);
  // Need parens if parent binds tighter, or if we're the right operand
  // of a non-associative op (sub, div) at the same precedence
  const needParens = myPrec < parentPrec || (isRightOfNonAssoc && myPrec === parentPrec);

  let segs: CalcSegment[];
  switch (expr.op) {
    case "ref": {
      const u = formatUnits(expr.unit);
      return [{ text: fmtValue(expr.node.result, u), refId: nodeIds.get(expr.node) }];
    }

    case "constant":
      return [{ text: fmtValue(expr.value, formatUnits(expr.unit)) }];

    case "property":
      return [{ text: fmtValue(expr.value, formatUnits(expr.unit)), label: expr.name }];

    case "measured":
      return [{ text: fmtValue(expr.value, formatUnits(expr.unit)), label: expr.label }];

    case "add":
      segs = [];
      for (let i = 0; i < expr.args.length; i++) {
        if (i > 0) segs.push({ text: " + " });
        segs.push(...calcToSegments(expr.args[i], nodeIds, myPrec, false));
      }
      break;

    case "sub":
      segs = [
        ...calcToSegments(expr.left, nodeIds, myPrec, false),
        { text: " \u2212 " },
        ...calcToSegments(expr.right, nodeIds, myPrec, true),
      ];
      break;

    case "mul":
      segs = [
        ...calcToSegments(expr.left, nodeIds, myPrec, false),
        { text: " \u00d7 " },
        ...calcToSegments(expr.right, nodeIds, myPrec, false),
      ];
      break;

    case "div":
      segs = [
        ...calcToSegments(expr.left, nodeIds, myPrec, false),
        { text: " / " },
        ...calcToSegments(expr.right, nodeIds, myPrec, true),
      ];
      break;

    case "max": {
      segs = [{ text: "max(" }];
      for (let i = 0; i < expr.args.length; i++) {
        if (i > 0) segs.push({ text: ", " });
        segs.push(...calcToSegments(expr.args[i], nodeIds, 0, false));
      }
      segs.push({ text: ")" });
      return segs; // max/min have their own parens, never need outer parens
    }

    case "min": {
      segs = [{ text: "min(" }];
      for (let i = 0; i < expr.args.length; i++) {
        if (i > 0) segs.push({ text: ", " });
        segs.push(...calcToSegments(expr.args[i], nodeIds, 0, false));
      }
      segs.push({ text: ")" });
      return segs;
    }
  }

  if (needParens) {
    return [{ text: "(" }, ...segs, { text: ")" }];
  }
  return segs;
}

// --- Console renderer ---

export function renderDagToConsole(dag: DagResult): void {
  const rendered = renderDag(dag);

  console.group(
    `%cWhy is %o %s × %s?`,
    "font-size: 13px; font-weight: bold",
    dag.element,
    `${rendered.width.result}px`,
    `${rendered.height.result}px`,
  );

  console.group("%cWidth: %s", "font-weight: bold; color: #8ab4f8", `${rendered.width.result}px`);
  for (const node of rendered.width.nodes) logNode(node);
  console.groupEnd();

  console.group("%cHeight: %s", "font-weight: bold; color: #81c995", `${rendered.height.result}px`);
  for (const node of rendered.height.nodes) logNode(node);
  console.groupEnd();

  console.groupEnd();
}

function logNode(node: RenderNode): void {
  const deps = node.dependsOn.length > 0 ? ` ← ${node.dependsOn.join(", ")}` : "";
  console.groupCollapsed(
    `%c[${node.id}]%c ${node.mode} %c${node.result}${node.resultUnit}%c ${node.elementDesc}%c${deps}`,
    "color: #9aa0a6",
    "color: #d2a8ff",
    "color: #7ee787; font-weight: bold",
    "color: #58a6ff",
    "color: #484f58",
  );
  console.log(node.expression);
  const props = Object.entries(node.cssProperties).filter(([, v]) => v != null);
  if (props.length > 0) console.table(Object.fromEntries(props));
  console.log("%o", node.element);
  console.groupEnd();
}
