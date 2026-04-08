// Panel entry point: devtools integration, axis rendering, collapse/expand.

import { layoutDag, renderAscii, type DagInput, type LayoutResult, type VisualEdge } from "../core/dag-layout";
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
      catch (e) { return { error: e instanceof Error ? (e.stack || e.message) : String(e) }; }
    })()`,
    (result: DagRender & { error?: string }, error: chrome.devtools.inspectedWindow.EvaluationExceptionInfo) => {
      analyzeBtn.textContent = "Analyze $0";
      analyzeBtn.removeAttribute("disabled");
      if (error && error.isException) return showError(error.value || "Unknown error");
      if (result && result.error) return showError(result.error);
      showResult(result);
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
// Axis state — persists across re-renders within an axis section
// ---------------------------------------------------------------------------

interface AxisState {
  axis: AxisRender;
  nodeMap: Map<string, RenderNode>;
  /** Full set of all node IDs (never changes). */
  allNodeIds: Set<string>;
  /** Full-graph DagInput (never changes). */
  fullDagInput: DagInput[];
  /** Layout computed from the full graph (stable columns/order). */
  fullLayout: LayoutResult;
  /** Node IDs currently collapsed by the user. */
  collapsedSet: Set<string>;
  /** Node IDs whose detail panels are open. */
  openDetails: Set<string>;
  /** Stable DOM containers. */
  section: HTMLElement;
  rowContainer: HTMLElement;
  asciiPre: HTMLElement;
}

// ---------------------------------------------------------------------------
// Visible node computation
// ---------------------------------------------------------------------------

/** BFS from the root, skipping children of collapsed nodes. */
function getVisibleNodes(state: AxisState): Set<string> {
  const visible = new Set<string>();
  const root = state.axis.nodes[0];
  if (!root) return visible;

  const queue = [root.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visible.has(id)) continue;
    visible.add(id);

    if (state.collapsedSet.has(id)) continue;

    const node = state.nodeMap.get(id)!;
    for (const dep of node.dependsOn) {
      if (state.allNodeIds.has(dep) && !visible.has(dep)) queue.push(dep);
    }
  }
  return visible;
}

/**
 * Count nodes that would become visible if this node were expanded.
 * Simulates a BFS with this node uncollapsed (but other collapses intact),
 * then counts how many of the newly reachable nodes aren't currently visible.
 */
function countHiddenDescendants(state: AxisState, nodeId: string, visibleSet: Set<string>): number {
  // Compute what would be visible if only this node were uncollapsed
  const hypothetical = new Set<string>();
  const root = state.axis.nodes[0];
  if (!root) return 0;

  const queue = [root.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (hypothetical.has(id)) continue;
    hypothetical.add(id);

    // Skip children of collapsed nodes, EXCEPT for the node we're testing
    if (id !== nodeId && state.collapsedSet.has(id)) continue;

    const node = state.nodeMap.get(id);
    if (node) {
      for (const dep of node.dependsOn) {
        if (state.allNodeIds.has(dep) && !hypothetical.has(dep)) queue.push(dep);
      }
    }
  }

  // Count nodes that would be newly visible
  let count = 0;
  for (const id of hypothetical) {
    if (!visibleSet.has(id)) count++;
  }
  return count;
}

/**
 * Filter a full-graph LayoutResult to only visible nodes.
 * Keeps the same column assignments (stable positions) but
 * produces new contiguous row indices and filters edges.
 */
function filterLayout(full: LayoutResult, visibleSet: Set<string>): LayoutResult {
  const order = full.order.filter((id) => visibleSet.has(id));
  const rows = new Map<string, number>();
  order.forEach((id, i) => rows.set(id, i));

  const edges: VisualEdge[] = full.edges.filter(
    (e) => visibleSet.has(e.fromId) && visibleSet.has(e.toId),
  );

  return {
    order,
    columns: full.columns, // stable — same columns as full graph
    rows,
    edges,
    numCols: full.numCols, // stable — same width as full graph
  };
}

// ---------------------------------------------------------------------------
// Axis rendering — one-time setup
// ---------------------------------------------------------------------------

function renderAxis(axis: AxisRender, title: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "axis-section";
  const hdr = document.createElement("div");
  hdr.className = "axis-header";
  hdr.innerHTML = `<span class="axis-title">${title}</span>: <span class="val">${axis.result}px</span>`;
  section.appendChild(hdr);
  if (axis.nodes.length === 0) return section;

  const nodeMap = new Map(axis.nodes.map((n) => [n.id, n]));
  const allNodeIds = new Set(axis.nodes.map((n) => n.id));

  // Compute layout once from the full graph
  const fullDagInput: DagInput[] = axis.nodes.map((n) => ({
    id: n.id,
    children: n.dependsOn.filter((id) => allNodeIds.has(id)),
  }));
  const fullLayout = layoutDag(fullDagInput);

  // ASCII debug view (collapsed by default)
  const asciiToggle = document.createElement("div");
  asciiToggle.className = "ascii-toggle";
  asciiToggle.textContent = "\u25b6 ASCII debug";
  const asciiPre = document.createElement("pre");
  asciiPre.className = "ascii-debug";
  asciiPre.textContent = renderAscii(fullDagInput);
  asciiToggle.addEventListener("click", () => {
    asciiPre.classList.toggle("open");
    asciiToggle.textContent = asciiPre.classList.contains("open")
      ? "\u25bc ASCII debug" : "\u25b6 ASCII debug";
  });
  section.appendChild(asciiToggle);
  section.appendChild(asciiPre);

  // Row container — rebuilt on every collapse/expand
  const rowContainer = document.createElement("div");
  rowContainer.className = "row-container";
  section.appendChild(rowContainer);

  const state: AxisState = {
    axis,
    nodeMap,
    allNodeIds,
    fullDagInput,
    fullLayout,
    collapsedSet: new Set(),
    openDetails: new Set(),
    section,
    rowContainer,
    asciiPre,
  };

  // Event delegation on rowContainer (survives re-renders)
  attachDelegation(state);

  // Initial render
  renderRows(state);

  return section;
}

// ---------------------------------------------------------------------------
// Row rendering — called on init and every collapse/expand
// ---------------------------------------------------------------------------

function renderRows(state: AxisState): void {
  const visibleSet = getVisibleNodes(state);
  const layout = filterLayout(state.fullLayout, visibleSet);
  const rowInfos = buildRowInfos(layout);
  const svgW = layout.numCols * COL_W + 4;

  // Clear and rebuild rows
  state.rowContainer.innerHTML = "";
  const isRoot = layout.order.length > 0 ? layout.order[0] : null;

  for (const id of layout.order) {
    const node = state.nodeMap.get(id)!;
    const info = rowInfos.get(id)!;

    const svg = renderRowSvg(info, layout.numCols);
    const row = buildRow(node, svg, state, visibleSet, id !== isRoot);
    const detail = buildDetail(node, info, svgW, state.nodeMap, state.section);

    // Restore open detail state
    if (state.openDetails.has(id)) detail.classList.add("open");

    state.rowContainer.appendChild(row);
    state.rowContainer.appendChild(detail);
  }
}

// ---------------------------------------------------------------------------
// Animated collapse/expand
// ---------------------------------------------------------------------------

const ANIM_DURATION = 200; // ms

/**
 * Check if an SVG element should fade: true if ALL edges in its data-edges
 * have at least one endpoint that is not in the visible set.
 * If any edge has both endpoints visible, the element stays (shared line).
 */
function shouldFade(edgeAttr: string, visibleSet: Set<string>): boolean {
  for (const eid of edgeAttr.split(" ")) {
    const sep = eid.indexOf(">");
    if (sep < 0) continue;
    const from = eid.slice(0, sep);
    const to = eid.slice(sep + 1);
    // This edge has both endpoints visible — the element is needed
    if (visibleSet.has(from) && visibleSet.has(to)) return false;
  }
  return true;
}

/** Set opacity on edge elements that connect to non-visible nodes (no transition). */
function setEdgeOpacity(container: HTMLElement, visibleSet: Set<string>, opacity: string): void {
  for (const el of container.querySelectorAll<SVGElement>("[data-edges]")) {
    if (shouldFade(el.dataset.edges!, visibleSet)) {
      el.style.opacity = opacity;
    }
  }
}

/** Animate edge elements that connect to non-visible nodes. */
function fadeEdges(container: HTMLElement, visibleSet: Set<string>, opacity: string): void {
  for (const el of container.querySelectorAll<SVGElement>("[data-edges]")) {
    if (shouldFade(el.dataset.edges!, visibleSet)) {
      el.style.transition = `opacity ${ANIM_DURATION}ms ease-out`;
      el.style.opacity = opacity;
    }
  }
}

function toggleCollapse(state: AxisState, nodeId: string): void {
  const isCollapsing = !state.collapsedSet.has(nodeId);

  if (isCollapsing) {
    // Collapsing: animate disappearing rows + connected edges out, then rebuild
    state.collapsedSet.add(nodeId);
    const futureVisible = getVisibleNodes(state);

    // Identify disappearing nodes
    const disappearingIds = new Set<string>();
    const disappearing: HTMLElement[] = [];
    for (const row of state.rowContainer.querySelectorAll<HTMLElement>(".graph-row")) {
      const id = row.dataset.nodeId!;
      if (!futureVisible.has(id)) {
        disappearingIds.add(id);
        disappearing.push(row);
        const detail = row.nextElementSibling as HTMLElement | null;
        if (detail?.classList.contains("node-detail")) disappearing.push(detail);
      }
    }

    if (disappearing.length === 0) {
      renderRows(state);
      return;
    }

    // Fade out all edge elements whose endpoints won't both be visible
    fadeEdges(state.rowContainer, futureVisible, "0");

    // Animate disappearing rows out (height shrinks, content fades)
    for (const el of disappearing) {
      const h = el.getBoundingClientRect().height;
      el.style.height = h + "px";
      el.style.overflow = "hidden";
      if (el.classList.contains("graph-row")) {
        // Fade dot in the SVG
        const dot = el.querySelector<SVGElement>(".gutter-svg [data-dot]");
        if (dot) { dot.style.transition = `opacity 0.15s ease-out`; dot.style.opacity = "0"; }
        el.classList.add("row-exit");
      } else {
        // Detail panels fade entirely
        el.classList.add("row-exit");
        el.style.opacity = "1";
        el.offsetHeight; // force reflow
        el.style.transition = `height 0.2s ease-out, opacity 0.15s ease-out`;
        el.style.opacity = "0";
      }
      el.offsetHeight; // force reflow
      el.style.height = "0";
    }

    // After animation, rebuild with correct layout (fresh elements, no stale styles)
    setTimeout(() => {
      snapshotOpenDetails(state);
      renderRows(state);
    }, ANIM_DURATION);

  } else {
    // Expanding: rebuild with new rows hidden, then animate everything in
    state.collapsedSet.delete(nodeId);
    const prevVisible = getVisibleNodes({ ...state, collapsedSet: new Set([...state.collapsedSet, nodeId]) });

    snapshotOpenDetails(state);
    renderRows(state);

    // Identify newly appearing nodes and rows
    const appearingIds = new Set<string>();
    const appearing: HTMLElement[] = [];
    for (const row of state.rowContainer.querySelectorAll<HTMLElement>(".graph-row")) {
      const id = row.dataset.nodeId!;
      if (!prevVisible.has(id)) {
        appearingIds.add(id);
        appearing.push(row);
        const detail = row.nextElementSibling as HTMLElement | null;
        if (detail?.classList.contains("node-detail") && detail.classList.contains("open")) {
          appearing.push(detail);
        }
      }
    }

    // Set initial hidden state WITHOUT transitions:
    // - Rows: zero height (gutter lines stay visible during expand)
    // - Row content (summary, dot, badge): invisible
    // - Edge elements where either endpoint wasn't previously visible: invisible
    setEdgeOpacity(state.rowContainer, prevVisible, "0");
    for (const el of appearing) {
      const h = el.getBoundingClientRect().height;
      el.style.height = "0";
      el.style.overflow = "hidden";
      el.dataset.naturalHeight = String(h);
      // Fade content only, not the gutter SVG lines
      if (el.classList.contains("graph-row")) {
        const summary = el.querySelector<HTMLElement>(".node-summary");
        const badge = el.querySelector<HTMLElement>(".collapse-badge");
        const dot = el.querySelector<SVGElement>(".gutter-svg [data-dot]");
        if (summary) summary.style.opacity = "0";
        if (badge) badge.style.opacity = "0";
        if (dot) dot.style.opacity = "0";
      } else {
        // Detail panels fade entirely
        el.style.opacity = "0";
      }
    }

    // Double-rAF ensures the browser paints the hidden state before we animate.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Fade in edge elements that weren't previously visible
      fadeEdges(state.rowContainer, prevVisible, "1");
      // Expand rows and fade in content
      for (const el of appearing) {
        el.style.transition = `height ${ANIM_DURATION}ms ease-out`;
        el.style.height = el.dataset.naturalHeight + "px";
        delete el.dataset.naturalHeight;
        if (el.classList.contains("graph-row")) {
          const summary = el.querySelector<HTMLElement>(".node-summary");
          const badge = el.querySelector<HTMLElement>(".collapse-badge");
          const dot = el.querySelector<SVGElement>(".gutter-svg [data-dot]");
          if (summary) { summary.style.transition = `opacity ${ANIM_DURATION}ms ease-out`; summary.style.opacity = "1"; }
          if (badge) { badge.style.transition = `opacity ${ANIM_DURATION}ms ease-out`; badge.style.opacity = "1"; }
          if (dot) { dot.style.transition = `opacity ${ANIM_DURATION}ms ease-out`; dot.style.opacity = "1"; }
        } else {
          el.style.transition = `height ${ANIM_DURATION}ms ease-out, opacity ${ANIM_DURATION}ms ease-out`;
          el.style.opacity = "1";
        }
      }

      setTimeout(() => {
        // Clean up all inline styles from animation
        for (const el of appearing) {
          el.style.transition = "";
          el.style.height = "";
          el.style.overflow = "";
          el.style.opacity = "";
          for (const child of el.querySelectorAll<HTMLElement>("[style]")) {
            child.style.transition = "";
            child.style.opacity = "";
          }
        }
        for (const el of state.rowContainer.querySelectorAll<SVGElement>("[data-edges][style]")) {
          el.style.transition = "";
          el.style.opacity = "";
        }
      }, ANIM_DURATION);
    }));
  }
}

/** Snapshot which detail panels are open before rebuilding. */
function snapshotOpenDetails(state: AxisState): void {
  state.openDetails.clear();
  for (const detail of state.rowContainer.querySelectorAll<HTMLElement>(".node-detail.open")) {
    const row = detail.previousElementSibling as HTMLElement | null;
    if (row?.dataset.nodeId) state.openDetails.add(row.dataset.nodeId);
  }
}

// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------

function attachDelegation(state: AxisState): void {
  const container = state.rowContainer;
  const section = state.section;

  // Click delegation
  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    // Collapse badge click
    const badge = target.closest(".collapse-badge");
    if (badge) {
      e.stopPropagation();
      const row = badge.closest<HTMLElement>(".graph-row");
      if (row?.dataset.nodeId) toggleCollapse(state, row.dataset.nodeId);
      return;
    }

    // SVG hit area click
    if (target instanceof SVGElement && target.classList.contains("collapse-hit")) {
      e.stopPropagation();
      const row = target.closest<HTMLElement>(".graph-row");
      if (row?.dataset.nodeId) toggleCollapse(state, row.dataset.nodeId);
      return;
    }

    // Summary click → toggle detail
    const summary = target.closest(".node-summary");
    if (summary) {
      const row = summary.closest<HTMLElement>(".graph-row");
      if (row) {
        const detail = row.nextElementSibling as HTMLElement | null;
        if (detail?.classList.contains("node-detail")) {
          detail.classList.toggle("open");
          const id = row.dataset.nodeId;
          if (id) {
            if (detail.classList.contains("open")) state.openDetails.add(id);
            else state.openDetails.delete(id);
          }
        }
      }
    }
  });

  // Hover delegation — use mouseover/mouseout (they bubble, unlike mouseenter/leave)
  let hoveredRowId: string | null = null;

  container.addEventListener("mouseover", (e) => {
    const target = e.target as HTMLElement;

    // Collapse dot hover
    if (target instanceof SVGElement && target.classList.contains("collapse-hit")) {
      target.closest<HTMLElement>(".graph-row")?.classList.add("dot-hover");
    }

    // Calc-ref hover
    const calcRef = target.closest<HTMLElement>(".calc-ref");
    if (calcRef) {
      const refId = calcRef.dataset.refId;
      const fromId = calcRef.dataset.fromId;
      if (refId && fromId) {
        highlightRef(section, fromId, refId);
        const refNode = state.nodeMap.get(refId);
        if (refNode) highlightInPage(refNode.elementPath);
      }
      return;
    }

    // Calc-prop hover
    const calcProp = target.closest<HTMLElement>(".calc-prop");
    if (calcProp) {
      const propName = calcProp.dataset.propName;
      const detailContent = calcProp.closest<HTMLElement>(".detail-content");
      if (propName && detailContent) {
        const propRow = detailContent.querySelector<HTMLElement>(`.pk[data-prop="${propName}"]`);
        if (propRow) {
          propRow.classList.add("pk-hl");
          (propRow.nextElementSibling as HTMLElement | null)?.classList.add("pv-hl");
        }
      }
      return;
    }

    // Row hover
    const graphRow = target.closest<HTMLElement>(".graph-row");
    if (graphRow && graphRow.dataset.nodeId !== hoveredRowId) {
      hoveredRowId = graphRow.dataset.nodeId!;
      const node = state.nodeMap.get(hoveredRowId);
      if (node) {
        const visibleSet = getVisibleNodes(state);
        const deps = node.dependsOn.filter((d) => visibleSet.has(d));
        highlightInPage(node.elementPath);
        highlightGraph(section, hoveredRowId, deps);
      }
    }
  });

  container.addEventListener("mouseout", (e) => {
    const target = e.target as HTMLElement;

    // Collapse dot un-hover
    if (target instanceof SVGElement && target.classList.contains("collapse-hit")) {
      target.closest<HTMLElement>(".graph-row")?.classList.remove("dot-hover");
    }

    // Calc-ref un-hover
    const calcRef = target.closest<HTMLElement>(".calc-ref");
    if (calcRef) {
      clearRefHighlight(section);
      clearHighlightInPage();
      return;
    }

    // Calc-prop un-hover
    const calcProp = target.closest<HTMLElement>(".calc-prop");
    if (calcProp) {
      const detailContent = calcProp.closest<HTMLElement>(".detail-content");
      if (detailContent) {
        detailContent.querySelectorAll(".pk-hl").forEach(el => el.classList.remove("pk-hl"));
        detailContent.querySelectorAll(".pv-hl").forEach(el => el.classList.remove("pv-hl"));
      }
      return;
    }

    // Row un-hover: check if we're leaving the row container entirely
    const relatedRow = (e.relatedTarget as HTMLElement | null)?.closest<HTMLElement>(".graph-row");
    if (!relatedRow || relatedRow.dataset.nodeId !== hoveredRowId) {
      hoveredRowId = null;
      clearHighlightInPage();
      clearGraphHighlight(section);
    }
  });
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

function buildRow(
  node: RenderNode, svg: SVGSVGElement,
  state: AxisState, visibleSet: Set<string>, canCollapse: boolean,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "graph-row";
  if (state.collapsedSet.has(node.id)) row.classList.add("collapsed");
  row.dataset.nodeId = node.id;
  row.dataset.deps = node.dependsOn.join(",");
  row.appendChild(svg);

  const hasDeps = node.dependsOn.some((d) => state.allNodeIds.has(d));
  if (hasDeps && canCollapse) {
    // Hit area for click — transparent, on top of everything
    const dotCircle = svg.querySelector("[data-dot] circle")!;
    const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    hitArea.setAttribute("cx", dotCircle.getAttribute("cx")!);
    hitArea.setAttribute("cy", dotCircle.getAttribute("cy")!);
    hitArea.setAttribute("r", String(DOT_R + 6));
    hitArea.setAttribute("fill", "transparent");
    hitArea.style.cursor = "pointer";
    hitArea.classList.add("collapse-hit");
    svg.appendChild(hitArea);

    const badge = document.createElement("span");
    badge.className = "collapse-badge";
    if (state.collapsedSet.has(node.id)) {
      const hidden = countHiddenDescendants(state, node.id, visibleSet);
      badge.textContent = `+${hidden}`;
    } else {
      badge.textContent = `+${node.dependsOn.filter(d => state.allNodeIds.has(d)).length}`;
    }
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
  svgW: number, nodeMap: Map<string, RenderNode>,
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
  content.appendChild(buildCalcDisplay(node, nodeMap, section));

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
  node: RenderNode, nodeMap: Map<string, RenderNode>,
  section: HTMLElement,
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
      calcExpr.appendChild(buildRefSegment(seg, node, nodeMap));
    } else if (seg.label) {
      calcExpr.appendChild(buildPropSegment(seg));
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
): HTMLElement {
  const refNode = nodeMap.get(seg.refId!);
  const span = document.createElement("span");
  span.className = "calc-ref";
  span.dataset.refId = seg.refId!;
  span.dataset.fromId = node.id;

  const valEl = document.createElement("span");
  valEl.className = "calc-val";
  valEl.textContent = seg.text;
  span.appendChild(valEl);

  const labelEl = document.createElement("span");
  labelEl.className = "calc-label";
  labelEl.textContent = refNode ? formatKind(refNode.kind) : seg.refId!;
  span.appendChild(labelEl);

  return span;
}

function buildPropSegment(
  seg: { text: string; label?: string },
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

  return span;
}
