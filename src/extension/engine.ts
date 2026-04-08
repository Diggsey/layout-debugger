import { buildDag } from "../core/build-dag";
import { renderDag, type CalcSegment } from "../core/dag-render";
import { getElementPath } from "../core/serialize";
import type { RenderNode } from "../core/dag-render";

declare global {
  interface Window {
    __layoutDebugger?: { analyze: typeof analyze; getElementPath: typeof getElementPath };
  }
}

function serializeNode(node: RenderNode) {
  return {
    id: node.id,
    elementPath: getElementPath(node.element),
    elementDesc: node.elementDesc,
    kind: node.kind,
    mode: node.mode,
    axis: node.axis,
    result: node.result,
    resultUnit: node.resultUnit,
    description: node.description,
    calculation: node.calculation.map((seg: CalcSegment) => ({
      text: seg.text,
      refId: seg.refId,
      label: seg.label,
    })),
    expression: node.expression,
    cssProperties: node.cssProperties,
    cssReasons: node.cssReasons,
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

window.__layoutDebugger = { analyze, getElementPath };
