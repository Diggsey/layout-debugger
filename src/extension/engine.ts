import { buildDag } from "../core/build-dag";
import { renderDag } from "../core/dag-render";
import { getElementPath } from "../core/serialize";
import type { RenderNode } from "../core/dag-render";

function serializeNode(node: RenderNode) {
  return {
    id: node.id,
    elementPath: getElementPath(node.element),
    elementDesc: node.elementDesc,
    kind: node.kind,
    axis: node.axis,
    result: node.result,
    resultUnit: node.resultUnit,
    description: node.description,
    calculation: node.calculation.map((seg: any) => ({
      text: seg.text,
      refId: seg.refId,
    })),
    expression: node.expression,
    cssProperties: node.cssProperties,
    dependsOn: node.dependsOn,
  };
}

function analyze(el: Element) {
  const dag = buildDag(el);
  const rendered = renderDag(dag);
  return {
    elementPath: getElementPath(rendered.element),
    elementDesc: rendered.elementDesc,
    width: {
      axis: rendered.width.axis,
      result: rendered.width.result,
      nodes: rendered.width.nodes.map(serializeNode),
    },
    height: {
      axis: rendered.height.axis,
      result: rendered.height.result,
      nodes: rendered.height.nodes.map(serializeNode),
    },
  };
}

(window as any).__layoutDebugger = { analyze, getElementPath };
