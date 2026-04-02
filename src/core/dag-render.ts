/**
 * DAG renderer: linearizes a DagResult for display.
 *
 * Uses DFS pre-order so the "main chain" (first dependency of each node)
 * appears immediately below its parent — like git log --first-parent.
 */
import type { DagResult, LayoutNode, CalcExpr } from "./dag";
import { describeElement } from "./utils";

/** A segment of a calculation string: either plain text or a value linked to a node. */
export interface CalcSegment {
  text: string;
  /** If set, this segment is a value that came from the node with this ID. */
  refId?: string;
}

export interface RenderNode {
  id: string;
  element: Element;
  elementDesc: string;
  kind: string;
  axis: "width" | "height";
  result: number;
  /** One-line context: why this node type is relevant. */
  description: string;
  /** Detailed calculation with values tagged by source node ID (for hover). */
  calculation: CalcSegment[];
  expression: string;
  cssProperties: Record<string, string | undefined>;
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

function renderAxis(root: LayoutNode, axis: "width" | "height"): AxisRender {
  const visited = new Map<LayoutNode, string>();
  const order: LayoutNode[] = [];

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

  function visit(node: LayoutNode): void {
    if (visited.has(node)) return;
    visited.set(node, "");
    order.push(node);

    const entries = Object.entries(node.inputs).filter(([, v]) => v) as [string, LayoutNode][];
    entries.sort((a, b) => {
      const pa = inputPriority(a[0]);
      const pb = inputPriority(b[0]);
      if (pa !== pb) return pb - pa;
      return entries.indexOf(b) - entries.indexOf(a);
    });
    for (const [, dep] of entries) {
      visit(dep);
    }
  }

  visit(root);

  order.forEach((node, i) => visited.set(node, `${axis[0]}${i}`));

  const nodes: RenderNode[] = order.map((node) => {
    const id = visited.get(node)!;
    const nodeIds = visited;
    const calculation = calcToSegments(node.calc, nodeIds);
    const expression = calculation.map((s) => s.text).join("");

    return {
      id,
      element: node.element,
      elementDesc: describeElement(node.element),
      kind: node.kind,
      axis: node.axis,
      result: node.result,
      description: node.description,
      calculation,
      expression,
      cssProperties: node.cssProperties,
      dependsOn: (Object.entries(node.inputs).filter(([, v]) => v) as [string, LayoutNode][])
        .sort((a, b) => inputPriority(a[0]) - inputPriority(b[0]))
        .map(([, dep]) => visited.get(dep)!),
    };
  });

  return { axis, result: root.result, nodes };
}

// ---------------------------------------------------------------------------
// CalcExpr → CalcSegment[] conversion
// ---------------------------------------------------------------------------

/**
 * Convert a CalcExpr tree into a flat array of CalcSegments for display.
 * Ref nodes become tagged values that can be hovered in the UI.
 */
function calcToSegments(
  expr: CalcExpr,
  nodeIds: Map<LayoutNode, string>,
): CalcSegment[] {
  switch (expr.op) {
    case "ref":
      return [{ text: `${expr.node.result}px`, refId: nodeIds.get(expr.node) }];

    case "value":
      if (expr.label) return [{ text: `${expr.value}${expr.label.match(/^[a-z%-]/) ? "" : "px "}${expr.label.match(/^[a-z%-]/) ? " (" + expr.label + ")" : expr.label}` }];
      return [{ text: `${expr.value}px` }];

    case "add": {
      const segs: CalcSegment[] = [];
      for (let i = 0; i < expr.args.length; i++) {
        if (i > 0) segs.push({ text: " + " });
        segs.push(...calcToSegments(expr.args[i], nodeIds));
      }
      return segs;
    }

    case "sub":
      return [
        ...calcToSegments(expr.left, nodeIds),
        { text: " \u2212 " },
        ...calcToSegments(expr.right, nodeIds),
      ];

    case "mul":
      return [
        ...calcToSegments(expr.left, nodeIds),
        { text: " \u00d7 " },
        ...calcToSegments(expr.right, nodeIds),
      ];

    case "div":
      return [
        ...calcToSegments(expr.left, nodeIds),
        { text: " / " },
        ...calcToSegments(expr.right, nodeIds),
      ];

    case "max": {
      const segs: CalcSegment[] = [{ text: "max(" }];
      for (let i = 0; i < expr.args.length; i++) {
        if (i > 0) segs.push({ text: ", " });
        segs.push(...calcToSegments(expr.args[i], nodeIds));
      }
      segs.push({ text: ")" });
      return segs;
    }

    case "min": {
      const segs: CalcSegment[] = [{ text: "min(" }];
      for (let i = 0; i < expr.args.length; i++) {
        if (i > 0) segs.push({ text: ", " });
        segs.push(...calcToSegments(expr.args[i], nodeIds));
      }
      segs.push({ text: ")" });
      return segs;
    }
  }
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
    `%c[${node.id}]%c ${node.kind} %c${node.result}px%c ${node.elementDesc}%c${deps}`,
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
