// Panel entry point: devtools integration, axis rendering, collapse/expand.

import { layoutDag, renderAscii, type DagInput } from "../core/dag-layout";
import type { DagRender, AxisRender, RenderNode } from "./panel-types";
import { COL_W, DOT_R, LINE_COLOR, LINE_W, cx, esc, formatKind } from "./panel-types";
import { type RowInfo, buildRowInfos, colsBelow, renderRowSvg } from "./panel-gutter";
import {
  highlightGraph, clearGraphHighlight,
  highlightRef, clearRefHighlight,
  highlightInPage, clearHighlightInPage,
} from "./panel-highlight";

// ---------------------------------------------------------------------------
// Devtools integration
// ---------------------------------------------------------------------------

const resultEl = document.getElementById("result")!;
const emptyEl = document.getElementById("empty-state")!;
const errorEl = document.getElementById("error")!;
const analyzeBtn = document.getElementById("analyze-btn")!;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function runAnalysis(): void {
  analyzeBtn.textContent = "Analyzing\u2026";
  analyzeBtn.setAttribute("disabled", "");
  chrome.devtools.inspectedWindow.eval(
    `(function() {
      if (!window.__layoutDebugger) return { error: "Layout Debugger engine not loaded. Refresh the page." };
      if (!$0) return { error: "No element selected." };
      try { return window.__layoutDebugger.analyze($0); }
      catch (e) { return { error: String(e && e.stack || e) }; }
    })()`,
    (result: any, error: any) => {
      analyzeBtn.textContent = "Analyze $0";
      analyzeBtn.removeAttribute("disabled");
      if (error) return showError(error.message || String(error));
      if (result && result.error) return showError(result.error);
      showResult(result as DagRender);
    },
  );
}

analyzeBtn.addEventListener("click", runAnalysis);
chrome.devtools.panels.elements.onSelectionChanged.addListener(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runAnalysis, 150);
});

function showError(msg: string): void {
  emptyEl.style.display = "none"; resultEl.style.display = "none";
  errorEl.style.display = "block"; errorEl.textContent = msg;
}

function showResult(dag: DagRender): void {
  emptyEl.style.display = "none"; errorEl.style.display = "none";
  resultEl.style.display = "block"; resultEl.innerHTML = "";
  const header = document.createElement("div");
  header.className = "result-header";
  header.innerHTML =
    `Why is <span class="el-ref">${esc(dag.elementDesc)}</span> ` +
    `<span class="val">${dag.width.result}px \u00d7 ${dag.height.result}px</span>?`;
  resultEl.appendChild(header);
  resultEl.appendChild(renderAxis(dag.width, "Width"));
  resultEl.appendChild(renderAxis(dag.height, "Height"));
}

// ---------------------------------------------------------------------------
// Axis rendering
// ---------------------------------------------------------------------------

function renderAxis(axis: AxisRender, title: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "axis-section";
  const hdr = document.createElement("div");
  hdr.className = "axis-header";
  hdr.innerHTML = `<span class="axis-title">${title}</span>: <span class="val">${axis.result}px</span>`;
  section.appendChild(hdr);
  if (axis.nodes.length === 0) return section;

  // Compute layout
  const nodeSet = new Set(axis.nodes.map((n) => n.id));
  const dagInput: DagInput[] = axis.nodes.map((n) => ({
    id: n.id,
    children: n.dependsOn.filter((id) => nodeSet.has(id)),
  }));
  const layout = layoutDag(dagInput);
  const nodeMap = new Map(axis.nodes.map((n) => [n.id, n]));
  const rowInfos = buildRowInfos(layout);

  // ASCII debug view (collapsed by default)
  const asciiToggle = document.createElement("div");
  asciiToggle.className = "ascii-toggle";
  asciiToggle.textContent = "\u25b6 ASCII debug";
  const asciiPre = document.createElement("pre");
  asciiPre.className = "ascii-debug";
  asciiPre.textContent = renderAscii(dagInput);
  asciiToggle.addEventListener("click", () => {
    asciiPre.classList.toggle("open");
    asciiToggle.textContent = asciiPre.classList.contains("open")
      ? "\u25bc ASCII debug" : "\u25b6 ASCII debug";
  });
  section.appendChild(asciiToggle);
  section.appendChild(asciiPre);

  // Build rows
  const svgW = layout.numCols * COL_W + 4;
  for (const id of layout.order) {
    const node = nodeMap.get(id)!;
    const info = rowInfos.get(id)!;
    const deps = node.dependsOn.filter((d) => nodeSet.has(d));

    const svg = renderRowSvg(info, layout.numCols);
    const row = buildRow(node, svg, deps, section);
    const detail = buildDetail(node, info, svgW, nodeMap, nodeSet, section);

    summary(row).addEventListener("click", () => detail.classList.toggle("open"));
    row.addEventListener("mouseenter", () => {
      highlightInPage(node.elementPath);
      highlightGraph(section, node.id, deps);
    });
    row.addEventListener("mouseleave", () => {
      clearHighlightInPage();
      clearGraphHighlight(section);
    });

    section.appendChild(row);
    section.appendChild(detail);
  }

  return section;
}

function summary(row: HTMLElement): HTMLElement {
  return row.querySelector(".node-summary")!;
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

function buildRow(
  node: RenderNode, svg: SVGSVGElement, deps: string[], section: HTMLElement,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "graph-row";
  row.dataset.nodeId = node.id;
  row.dataset.deps = node.dependsOn.join(",");
  row.appendChild(svg);

  if (deps.length > 0) {
    const dotEl = svg.querySelector("circle")!;
    const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    hitArea.setAttribute("cx", dotEl.getAttribute("cx")!);
    hitArea.setAttribute("cy", dotEl.getAttribute("cy")!);
    hitArea.setAttribute("r", String(DOT_R + 6));
    hitArea.setAttribute("fill", "transparent");
    hitArea.style.cursor = "pointer";
    hitArea.style.pointerEvents = "all";
    svg.appendChild(hitArea);

    const badge = document.createElement("span");
    badge.className = "collapse-badge";
    badge.textContent = `+${deps.length}`;

    const toggle = (e: Event) => {
      e.stopPropagation();
      toggleSubtree(section, node.id, row, svg);
    };
    badge.addEventListener("click", toggle);
    hitArea.addEventListener("click", toggle);
    row.appendChild(badge);
  }

  const sum = document.createElement("div");
  sum.className = "node-summary";
  sum.innerHTML =
    `<span class="nid">${node.id}</span> ` +
    `<span class="val">${node.result}${node.resultUnit}</span> ` +
    `<span class="ndesc">${esc(node.description)}</span> ` +
    `<span class="el-ref">${esc(node.elementDesc)}</span>`;
  row.appendChild(sum);

  return row;
}

// ---------------------------------------------------------------------------
// Detail panel building
// ---------------------------------------------------------------------------

function buildDetail(
  node: RenderNode, info: RowInfo,
  svgW: number, nodeMap: Map<string, RenderNode>, nodeSet: Set<string>,
  section: HTMLElement,
): HTMLElement {
  const detail = document.createElement("div");
  detail.className = "node-detail";

  // Gutter with rail continuation SVG
  const detailGutter = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  detailGutter.setAttribute("width", String(svgW));
  detailGutter.setAttribute("height", "100%");
  detailGutter.setAttribute("class", "detail-gutter");
  detailGutter.setAttribute("preserveAspectRatio", "none");
  for (const c of [...colsBelow(info)].sort((a, b) => a - b)) {
    const rail = document.createElementNS("http://www.w3.org/2000/svg", "line");
    rail.setAttribute("x1", String(cx(c)));
    rail.setAttribute("y1", "0");
    rail.setAttribute("x2", String(cx(c)));
    rail.setAttribute("y2", "100%");
    rail.setAttribute("stroke", LINE_COLOR);
    rail.setAttribute("stroke-width", String(LINE_W));
    rail.classList.add("detail-rail");
    const railEdges = [...(info.passingEdges.get(c) ?? [])];
    if (c === info.col) railEdges.push(...info.mainOutEdgeIds);
    const branchEid = info.branchEdgeId.get(c);
    if (branchEid) railEdges.push(branchEid);
    if (railEdges.length > 0) rail.dataset.edges = railEdges.join(" ");
    detailGutter.appendChild(rail);
  }
  detail.appendChild(detailGutter);

  // Content (indented past the gutter)
  const content = document.createElement("div");
  content.className = "detail-content";
  content.style.marginLeft = `${svgW}px`;
  detail.appendChild(content);

  // Description
  const descEl = document.createElement("div");
  descEl.className = "detail-desc";
  descEl.textContent = node.description;
  content.appendChild(descEl);

  // Calculation
  content.appendChild(buildCalcDisplay(node, nodeMap, nodeSet, section, content));

  // CSS properties
  const props = Object.entries(node.cssProperties).filter(([, v]) => v != null);
  if (props.length > 0) {
    const grid = document.createElement("div");
    grid.className = "detail-props";
    for (const [k, v] of props) {
      const ke = document.createElement("span"); ke.className = "pk"; ke.textContent = k;
      ke.dataset.prop = k;
      const ve = document.createElement("span"); ve.className = "pv";
      ve.textContent = v;
      const reason = node.cssReasons[k];
      if (reason) {
        const re = document.createElement("span");
        re.className = "pr";
        re.textContent = reason;
        ve.appendChild(re);
      }
      grid.appendChild(ke); grid.appendChild(ve);
    }
    content.appendChild(grid);
  }

  return detail;
}

function buildCalcDisplay(
  node: RenderNode, nodeMap: Map<string, RenderNode>, nodeSet: Set<string>,
  section: HTMLElement, detailContent: HTMLElement,
): HTMLElement {
  const calcLine = document.createElement("div");
  calcLine.className = "detail-calc";

  const resultLine = document.createElement("div");
  resultLine.className = "detail-result";
  resultLine.textContent = `= ${node.result}${node.resultUnit}`;

  const calcExpr = document.createElement("div");
  calcExpr.className = "detail-expr";

  for (const seg of node.calculation) {
    if (seg.refId) {
      calcExpr.appendChild(buildRefSegment(seg, node, nodeMap, section));
    } else if (seg.label) {
      calcExpr.appendChild(buildPropSegment(seg, detailContent));
    } else {
      const span = document.createElement("span");
      span.className = "calc-op";
      span.textContent = seg.text;
      calcExpr.appendChild(span);
    }
  }

  calcExpr.appendChild(resultLine);
  calcLine.appendChild(calcExpr);
  return calcLine;
}

function buildRefSegment(
  seg: { text: string; refId?: string },
  node: RenderNode, nodeMap: Map<string, RenderNode>,
  section: HTMLElement,
): HTMLElement {
  const refNode = nodeMap.get(seg.refId!);
  const span = document.createElement("span");
  span.className = "calc-ref";
  span.dataset.refId = seg.refId!;

  const valEl = document.createElement("span");
  valEl.className = "calc-val";
  valEl.textContent = seg.text;
  span.appendChild(valEl);

  const labelEl = document.createElement("span");
  labelEl.className = "calc-label";
  labelEl.textContent = refNode ? formatKind(refNode.kind) : seg.refId!;
  span.appendChild(labelEl);

  span.addEventListener("mouseenter", () => {
    highlightRef(section, node.id, seg.refId!);
    if (refNode) highlightInPage(refNode.elementPath);
  });
  span.addEventListener("mouseleave", () => {
    clearRefHighlight(section);
    if (refNode) clearHighlightInPage();
  });

  return span;
}

function buildPropSegment(
  seg: { text: string; label?: string },
  detailContent: HTMLElement,
): HTMLElement {
  const span = document.createElement("span");
  span.className = "calc-prop";
  span.dataset.propName = seg.label!;

  const valEl = document.createElement("span");
  valEl.className = "calc-val";
  valEl.textContent = seg.text;
  span.appendChild(valEl);

  const labelEl = document.createElement("span");
  labelEl.className = "calc-label";
  labelEl.textContent = seg.label!;
  span.appendChild(labelEl);

  span.addEventListener("mouseenter", () => {
    const propRow = detailContent.querySelector(`.pk[data-prop="${seg.label}"]`);
    if (propRow) {
      propRow.classList.add("pk-hl");
      (propRow.nextElementSibling as HTMLElement | null)?.classList.add("pv-hl");
    }
  });
  span.addEventListener("mouseleave", () => {
    detailContent.querySelectorAll(".pk-hl").forEach(el => el.classList.remove("pk-hl"));
    detailContent.querySelectorAll(".pv-hl").forEach(el => el.classList.remove("pv-hl"));
  });

  return span;
}

// ---------------------------------------------------------------------------
// Collapse / expand
// ---------------------------------------------------------------------------

function recomputeVisibility(section: HTMLElement): void {
  const allRows = [...section.querySelectorAll(".graph-row")] as HTMLElement[];
  if (allRows.length === 0) return;

  const visible = new Set<string>();
  const queue = [allRows[0].dataset.nodeId!];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visible.has(id)) continue;
    visible.add(id);

    const row = section.querySelector(`.graph-row[data-node-id="${id}"]`) as HTMLElement | null;
    if (!row || row.classList.contains("collapsed")) continue;

    for (const dep of (row.dataset.deps ?? "").split(",").filter(Boolean)) {
      if (!visible.has(dep)) queue.push(dep);
    }
  }

  for (const row of allRows) {
    const id = row.dataset.nodeId!;
    const show = visible.has(id);
    row.style.display = show ? "" : "none";
    const detail = row.nextElementSibling as HTMLElement | null;
    if (detail?.classList.contains("node-detail")) {
      detail.style.display = show ? "" : "none";
    }
  }
}

function countDescendants(nodeId: string, section: HTMLElement): number {
  const descendants = new Set<string>();
  const stack: string[] = [];
  const rootRow = section.querySelector(`.graph-row[data-node-id="${nodeId}"]`) as HTMLElement | null;
  if (!rootRow) return 0;
  for (const dep of (rootRow.dataset.deps ?? "").split(",").filter(Boolean)) stack.push(dep);

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    const row = section.querySelector(`.graph-row[data-node-id="${id}"]`) as HTMLElement | null;
    if (!row) continue;
    for (const dep of (row.dataset.deps ?? "").split(",").filter(Boolean)) {
      if (!descendants.has(dep)) stack.push(dep);
    }
  }
  return descendants.size;
}

function toggleSubtree(
  section: HTMLElement, nodeId: string, row: HTMLElement, svg: SVGSVGElement,
): void {
  row.classList.toggle("collapsed");

  const isCollapsed = row.classList.contains("collapsed");
  svg.querySelectorAll(".outgoing").forEach((el) => {
    (el as SVGElement).style.display = isCollapsed ? "none" : "";
  });

  recomputeVisibility(section);

  const badge = row.querySelector(".collapse-badge");
  if (badge) badge.textContent = `+${countDescendants(nodeId, section)}`;
}
