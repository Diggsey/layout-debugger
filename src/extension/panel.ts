const resultEl = document.getElementById("result")!;
const emptyEl = document.getElementById("empty-state")!;
const errorEl = document.getElementById("error")!;
const analyzeBtn = document.getElementById("analyze-btn")!;

interface CalcSegment { text: string; refId?: string; }
interface RenderNode {
  id: string; elementPath: string; elementDesc: string; kind: string;
  axis: string; result: number; description: string; calculation: CalcSegment[];
  expression: string; cssProperties: Record<string, string>; dependsOn: string[];
}
interface AxisRender { axis: string; result: number; nodes: RenderNode[]; }
interface DagRender { elementPath: string; elementDesc: string; width: AxisRender; height: AxisRender; }

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

// --- Graph rendering with inline SVG gutters ---
//
// Each row gets a small SVG that draws:
// - Vertical line segments for active rails (top to bottom of the row)
// - A dot for this node's column
// - Horizontal + vertical curved connectors for new branches

const COL_W = 16;   // px per column
const ROW_H = 28;   // matches .graph-row height
const LINE_COLOR = "#30363d";
const DOT_COLOR = "#58a6ff";
const DOT_R = 4;
const LINE_W = 2;
const CURVE_R = 5;  // radius for rounded branch corners

function renderAxis(axis: AxisRender, title: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "axis-section";
  const hdr = document.createElement("div");
  hdr.className = "axis-header";
  hdr.innerHTML = `<span class="axis-title">${title}</span>: <span class="val">${axis.result}px</span>`;
  section.appendChild(hdr);
  if (axis.nodes.length === 0) return section;

  const nodeSet = new Set(axis.nodes.map((n) => n.id));

  interface Rail { targetId: string; col: number }
  const rails: Rail[] = [];

  /** Allocate a new column to the right of all existing rails and the given node column.
   *  This prevents horizontal branch connectors from crossing existing vertical rails. */
  function allocBranchCol(nodeCol: number): number {
    let max = nodeCol;
    for (const r of rails) if (r.col > max) max = r.col;
    return max + 1;
  }

  /** Allocate the lowest free column (for root or arriving-rail-less nodes). */
  function allocCol(): number {
    const occupied = new Set(rails.map((r) => r.col));
    for (let c = 0; ; c++) if (!occupied.has(c)) return c;
  }

  for (const node of axis.nodes) {
    const deps = node.dependsOn.filter((id) => nodeSet.has(id));

    // Consume arriving rail
    const arrIdx = rails.findIndex((r) => r.targetId === node.id);
    let col: number;
    if (arrIdx >= 0) {
      col = rails[arrIdx].col;
      rails.splice(arrIdx, 1);
    } else {
      col = allocCol();
    }

    // Columns with rails passing through (before spawning new ones)
    const passingCols = new Set(rails.map((r) => r.col));

    // Did a rail arrive from above on this column?
    const arrivedFromAbove = arrIdx >= 0;

    // Spawn new rails.
    // First dep inherits this column (straight down). Others branch right
    // of all existing rails to avoid crossings.
    const branches: number[] = [];
    for (let i = 0; i < deps.length; i++) {
      if (i === 0) {
        rails.push({ targetId: deps[i], col });
      } else {
        const bc = allocBranchCol(col);
        rails.push({ targetId: deps[i], col: bc });
        branches.push(bc);
      }
    }

    // Columns with rails going below (after spawning)
    const belowCols = new Set(rails.map((r) => r.col));

    // Determine SVG width
    const allCols = new Set([col, ...passingCols, ...belowCols]);
    const numCols = Math.max(...allCols) + 1;
    const svgW = numCols * COL_W + 4; // +4 for padding

    // Build SVG
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(svgW));
    svg.setAttribute("height", String(ROW_H));
    svg.setAttribute("class", "gutter-svg");

    const cx = (c: number) => c * COL_W + COL_W / 2; // center x of column c
    const midY = ROW_H / 2;

    // 1. Draw vertical lines for passing-through rails
    for (const c of passingCols) {
      // Full height — passes through this row
      if (belowCols.has(c)) {
        line(svg, cx(c), 0, cx(c), ROW_H);
      } else {
        // Rail ends here (but not at this node — it's a different column)
        line(svg, cx(c), 0, cx(c), midY);
      }
    }

    // 2. Draw vertical line for this node's column
    //    Above the dot: if a rail arrived from above
    //    Below the dot: if a rail continues below on this column
    if (arrivedFromAbove) {
      line(svg, cx(col), 0, cx(col), midY - DOT_R);
    }
    if (belowCols.has(col)) {
      line(svg, cx(col), midY + DOT_R, cx(col), ROW_H, "outgoing");
    }

    // 3. Draw branch connectors: from the dot, go right then down with a rounded corner
    for (const bc of branches) {
      const fromX = cx(col) + DOT_R;
      const toX = cx(bc);
      const toY = ROW_H;
      if (toX - fromX > CURVE_R) {
        line(svg, fromX, midY, toX - CURVE_R, midY, "outgoing");
      }
      const arc = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const arcStartX = Math.max(fromX, toX - CURVE_R);
      arc.setAttribute("d",
        `M ${arcStartX} ${midY} Q ${toX} ${midY} ${toX} ${midY + CURVE_R}`);
      arc.setAttribute("fill", "none");
      arc.setAttribute("stroke", LINE_COLOR);
      arc.setAttribute("stroke-width", String(LINE_W));
      arc.classList.add("outgoing");
      svg.appendChild(arc);
      if (midY + CURVE_R < toY) {
        line(svg, toX, midY + CURVE_R, toX, toY, "outgoing");
      }
    }

    // 4. Draw the dot
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(cx(col)));
    dot.setAttribute("cy", String(midY));
    dot.setAttribute("r", String(DOT_R));
    dot.setAttribute("fill", DOT_COLOR);
    svg.appendChild(dot);

    // 5. Invisible larger hit area for collapse/expand click
    if (deps.length > 0) {
      const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      hitArea.setAttribute("cx", String(cx(col)));
      hitArea.setAttribute("cy", String(midY));
      hitArea.setAttribute("r", String(DOT_R + 6));
      hitArea.setAttribute("fill", "transparent");
      hitArea.style.cursor = "pointer";
      hitArea.style.pointerEvents = "all";
      svg.appendChild(hitArea);

      hitArea.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSubtree(section, node.id, row, svg);
      });
    }

    // Build row
    const row = document.createElement("div");
    row.className = "graph-row";
    row.dataset.nodeId = node.id;
    row.dataset.deps = node.dependsOn.join(",");
    row.appendChild(svg);

    // Collapse badge (shown only when collapsed)
    if (deps.length > 0) {
      const badge = document.createElement("span");
      badge.className = "collapse-badge";
      badge.textContent = `+${deps.length}`;
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSubtree(section, node.id, row, svg);
      });
      row.appendChild(badge);
    }

    // Summary: id, result, description
    const summary = document.createElement("div");
    summary.className = "node-summary";
    summary.innerHTML =
      `<span class="nid">${node.id}</span> ` +
      `<span class="val">${node.result}${node.resultUnit}</span> ` +
      `<span class="ndesc">${esc(node.description)}</span> ` +
      `<span class="el-ref">${esc(node.elementDesc)}</span>`;
    row.appendChild(summary);

    // Expanded detail: calculation with hoverable refs, then CSS properties
    const detail = document.createElement("div");
    detail.className = "node-detail";

    // Calculation line with hoverable value segments
    const calcLine = document.createElement("div");
    calcLine.className = "detail-calc";
    for (const seg of node.calculation) {
      if (seg.refId) {
        const span = document.createElement("span");
        span.className = "calc-ref";
        span.textContent = seg.text;
        span.dataset.refId = seg.refId;
        span.addEventListener("mouseenter", () => highlightNode(section, seg.refId!));
        span.addEventListener("mouseleave", () => unhighlightNode(section));
        calcLine.appendChild(span);
      } else {
        calcLine.appendChild(document.createTextNode(seg.text));
      }
    }
    detail.appendChild(calcLine);

    // CSS properties
    const props = Object.entries(node.cssProperties).filter(([, v]) => v != null);
    if (props.length > 0) {
      const grid = document.createElement("div");
      grid.className = "detail-props";
      for (const [k, v] of props) {
        const ke = document.createElement("span"); ke.className = "pk"; ke.textContent = k;
        const ve = document.createElement("span"); ve.className = "pv"; ve.textContent = v;
        grid.appendChild(ke); grid.appendChild(ve);
      }
      detail.appendChild(grid);
    }

    summary.addEventListener("click", () => detail.classList.toggle("open"));
    row.addEventListener("mouseenter", () => highlightInPage(node.elementPath));
    row.addEventListener("mouseleave", () => clearHighlightInPage());

    section.appendChild(row);
    section.appendChild(detail);
  }
  return section;
}

/** Get all descendant node IDs reachable from a node's deps. */
function getDescendants(nodeId: string, section: HTMLElement): Set<string> {
  const descendants = new Set<string>();
  const stack: string[] = [];
  const rootRow = section.querySelector(`.graph-row[data-node-id="${nodeId}"]`) as HTMLElement | null;
  if (!rootRow) return descendants;
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
  return descendants;
}

function toggleSubtree(
  section: HTMLElement, nodeId: string, row: HTMLElement, svg: SVGSVGElement,
): void {
  const isCollapsed = row.classList.toggle("collapsed");
  const descendants = getDescendants(nodeId, section);

  for (const descId of descendants) {
    const descRow = section.querySelector(`.graph-row[data-node-id="${descId}"]`) as HTMLElement | null;
    if (descRow) {
      descRow.style.display = isCollapsed ? "none" : "";
      const detail = descRow.nextElementSibling as HTMLElement | null;
      if (detail?.classList.contains("node-detail")) {
        detail.style.display = isCollapsed ? "none" : "";
      }
    }
  }

  // Hide/show outgoing edges
  svg.querySelectorAll(".outgoing").forEach((el) => {
    (el as SVGElement).style.display = isCollapsed ? "none" : "";
  });

  // Update badge with descendant count
  const badge = row.querySelector(".collapse-badge");
  if (badge) badge.textContent = `+${descendants.size}`;
}

function line(svg: SVGSVGElement, x1: number, y1: number, x2: number, y2: number, cls?: string): void {
  const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
  l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1));
  l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
  l.setAttribute("stroke", LINE_COLOR); l.setAttribute("stroke-width", String(LINE_W));
  if (cls) l.classList.add(cls);
  svg.appendChild(l);
}

function highlightInPage(path: string): void {
  const escaped = path.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  chrome.devtools.inspectedWindow.eval(`(function() {
    var el = document.querySelector('${escaped}');
    if (!el) return;
    var r = el.getBoundingClientRect();
    var w = Math.round(r.width * 100) / 100;
    var h = Math.round(r.height * 100) / 100;

    // Overlay
    var ov = document.getElementById('__layout-debugger-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = '__layout-debugger-overlay';
      document.body.appendChild(ov);
    }
    ov.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
      'background:rgba(37,99,235,0.12);border:1px solid rgba(37,99,235,0.5);' +
      'top:' + r.top + 'px;left:' + r.left + 'px;' +
      'width:' + r.width + 'px;height:' + r.height + 'px;display:block';

    // Dimension label
    var lbl = document.getElementById('__layout-debugger-label');
    if (!lbl) {
      lbl = document.createElement('div');
      lbl.id = '__layout-debugger-label';
      document.body.appendChild(lbl);
    }
    lbl.textContent = w + ' \\u00d7 ' + h;
    lbl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
      'background:#1a1a2e;color:#7ee787;font:600 11px/1 system-ui,sans-serif;' +
      'padding:3px 6px;border-radius:3px;white-space:nowrap;display:block;' +
      'left:' + r.left + 'px;top:' + (r.bottom + 4) + 'px';
    // If label would go below viewport, put it above
    if (r.bottom + 24 > window.innerHeight) {
      lbl.style.top = (r.top - 20) + 'px';
    }
    // If label would go off right edge, align to right
    if (r.left + lbl.offsetWidth > window.innerWidth) {
      lbl.style.left = (window.innerWidth - lbl.offsetWidth - 4) + 'px';
    }
  })()`);
}

function clearHighlightInPage(): void {
  chrome.devtools.inspectedWindow.eval(`(function() {
    var ov = document.getElementById('__layout-debugger-overlay');
    if (ov) ov.style.display = 'none';
    var lbl = document.getElementById('__layout-debugger-label');
    if (lbl) lbl.style.display = 'none';
  })()`);
}

/** Highlight a node row in the graph when hovering a calc-ref. */
function highlightNode(section: HTMLElement, nodeId: string): void {
  const row = section.querySelector(`.graph-row[data-node-id="${nodeId}"]`);
  if (row) row.classList.add("highlighted");
}

function unhighlightNode(section: HTMLElement): void {
  section.querySelectorAll(".graph-row.highlighted").forEach((el) => el.classList.remove("highlighted"));
}

function esc(s: string): string {
  const d = document.createElement("span"); d.textContent = s; return d.innerHTML;
}
