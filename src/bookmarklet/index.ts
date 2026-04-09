import { buildDag } from "../core/layout";
import { renderDag, renderDagToConsole } from "../ui/dag-render";
import { verifyDag, serializeDag, measureElements } from "../core/serialize";
import type { DagResult } from "../core/types";

/**
 * Analyze why an element is its current size and log the explanation to the console.
 *
 * Usage: Select an element in DevTools Elements panel, then run:
 *   whyThisSize($0)
 */
function whyThisSize(el: Element): DagResult {
  if (!(el instanceof Element)) {
    console.error(
      "whyThisSize: argument must be a DOM Element. Select one in the Elements panel and pass $0.",
    );
    throw new Error("whyThisSize: argument must be a DOM Element");
  }

  const dag = buildDag(el);
  renderDagToConsole(dag);
  return dag;
}

declare global {
  interface Window { whyThisSize?: typeof whyThisSize; }
}

window.whyThisSize = whyThisSize;

console.log(
  "%c📐 Layout Debugger loaded%c\n" +
    "Usage: Select an element in the Elements panel, then run:\n" +
    "  %cwhyThisSize($0)%c",
  "font-size: 14px; font-weight: bold; color: #2563eb",
  "",
  "font-family: monospace; background: #f1f5f9; padding: 2px 6px; border-radius: 3px",
  "",
);

export { whyThisSize, buildDag, renderDag, verifyDag, serializeDag, measureElements };
