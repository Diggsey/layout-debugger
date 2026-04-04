// SVG gutter tile rendering — one tile per row, matching the ASCII tile structure.

import type { LayoutResult } from "../core/dag-layout";
import {
  COL_W, ROW_H, LINE_COLOR, DOT_COLOR, DOT_R, LINE_W, CURVE_R, CROSS_GAP,
  cx, edgeId,
} from "./panel-types";

// ---------------------------------------------------------------------------
// RowInfo: per-row rendering data derived from layout edges
// ---------------------------------------------------------------------------

export interface RowInfo {
  nodeId: string;
  col: number;
  passingCols: Set<number>;
  arrivedFromAbove: boolean;
  continuesBelow: boolean;
  branchCols: number[];
  mergeCols: number[];
  passingEdges: Map<number, string[]>;
  mainInEdgeIds: string[];
  mergeEdgeId: Map<number, string>;
  mainOutEdgeIds: string[];
  branchEdgeId: Map<number, string>;
}

export function buildRowInfos(layout: LayoutResult): Map<string, RowInfo> {
  const infos = new Map<string, RowInfo>();

  for (const id of layout.order) {
    infos.set(id, {
      nodeId: id,
      col: layout.columns.get(id)!,
      passingCols: new Set(),
      arrivedFromAbove: false,
      continuesBelow: false,
      branchCols: [],
      mergeCols: [],
      passingEdges: new Map(),
      mainInEdgeIds: [],
      mergeEdgeId: new Map(),
      mainOutEdgeIds: [],
      branchEdgeId: new Map(),
    });
  }

  function addPassingEdge(fromRow: number, toRow: number, col: number, eid: string): void {
    for (let r = fromRow + 1; r < toRow; r++) {
      const midInfo = infos.get(layout.order[r])!;
      midInfo.passingCols.add(col);
      if (!midInfo.passingEdges.has(col)) midInfo.passingEdges.set(col, []);
      midInfo.passingEdges.get(col)!.push(eid);
    }
  }

  for (const edge of layout.edges) {
    const fromRow = layout.rows.get(edge.fromId)!;
    const toRow = layout.rows.get(edge.toId)!;
    const fromInfo = infos.get(edge.fromId)!;
    const toInfo = infos.get(edge.toId)!;
    const eid = edgeId(edge.fromId, edge.toId);

    if (edge.type === "main") {
      fromInfo.continuesBelow = true;
      fromInfo.mainOutEdgeIds.push(eid);
      toInfo.arrivedFromAbove = true;
      toInfo.mainInEdgeIds.push(eid);
      addPassingEdge(fromRow, toRow, edge.fromCol, eid);
    } else if (edge.type === "branch") {
      fromInfo.branchCols.push(edge.toCol);
      fromInfo.branchEdgeId.set(edge.toCol, eid);
      toInfo.arrivedFromAbove = true;
      toInfo.mainInEdgeIds.push(eid);
      addPassingEdge(fromRow, toRow, edge.toCol, eid);
    } else if (edge.type === "merge") {
      toInfo.mergeCols.push(edge.fromCol);
      toInfo.mergeEdgeId.set(edge.fromCol, eid);
      fromInfo.continuesBelow = true;
      fromInfo.mainOutEdgeIds.push(eid);
      addPassingEdge(fromRow, toRow, edge.fromCol, eid);
    }
  }

  return infos;
}

/** Columns with active vertical rails at the bottom of this row. */
export function colsBelow(info: RowInfo): Set<number> {
  const cols = new Set(info.passingCols);
  if (info.continuesBelow) cols.add(info.col);
  for (const bc of info.branchCols) cols.add(bc);
  return cols;
}

// ---------------------------------------------------------------------------
// SVG tile rendering
// ---------------------------------------------------------------------------

function svgLine(svg: SVGSVGElement, x1: number, y1: number, x2: number, y2: number, cls?: string, edges?: string): void {
  const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
  l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1));
  l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
  l.setAttribute("stroke", LINE_COLOR); l.setAttribute("stroke-width", String(LINE_W));
  if (cls) for (const c of cls.split(" ")) l.classList.add(c);
  if (edges) l.dataset.edges = edges;
  svg.appendChild(l);
}

function svgPath(svg: SVGSVGElement, d: string, cls?: string, edges?: string): void {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", LINE_COLOR);
  p.setAttribute("stroke-width", String(LINE_W));
  if (cls) for (const c of cls.split(" ")) p.classList.add(c);
  if (edges) p.dataset.edges = edges;
  svg.appendChild(p);
}

/**
 * Render one row's SVG gutter tile.
 *
 * Edges always leave/arrive vertically from the dot, then curve into
 * horizontal lines in the border zone between rows. Passing-through
 * rails are broken with a gap where horizontals cross.
 */
export function renderRowSvg(info: RowInfo, numCols: number): SVGSVGElement {
  const svgW = numCols * COL_W + 4;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(svgW));
  svg.setAttribute("height", String(ROW_H));
  svg.setAttribute("class", "gutter-svg");
  // Slight overflow so lines at tile boundaries overlap, preventing sub-pixel gaps
  svg.style.overflow = "visible";

  const midY = ROW_H / 2;
  const branchY = midY + ROW_H / 4;
  const mergeY = midY - ROW_H / 4;
  const col = info.col;
  const nodeX = cx(col);
  // Extend lines past tile edges to prevent sub-pixel gaps between rows
  const TOP = -0.5;
  const BOT = ROW_H + 0.5;

  // --- Crossing points: where horizontal branch/merge lines cross vertical rails ---
  const crossingYs = new Map<number, number[]>();

  if (info.branchCols.length > 0) {
    const sorted = [...info.branchCols].sort((a, b) => a - b);
    const leftX = nodeX + CURVE_R;
    const rightX = cx(sorted[sorted.length - 1]) - CURVE_R;
    for (const c of info.passingCols) {
      const cX = cx(c);
      if (cX > leftX && cX < rightX) {
        if (!crossingYs.has(c)) crossingYs.set(c, []);
        crossingYs.get(c)!.push(branchY);
      }
    }
  }
  for (const mc of info.mergeCols) {
    const mcX = cx(mc);
    const leftX = Math.min(mcX, nodeX) + CURVE_R;
    const rightX = Math.max(mcX, nodeX) - CURVE_R;
    for (const c of info.passingCols) {
      const cX = cx(c);
      if (cX > leftX && cX < rightX) {
        if (!crossingYs.has(c)) crossingYs.set(c, []);
        crossingYs.get(c)!.push(mergeY);
      }
    }
  }

  // 1. Passing-through vertical rails, with gaps at crossings
  for (const c of info.passingCols) {
    const cX = cx(c);
    const edgeTag = (info.passingEdges.get(c) ?? []).join(" ");
    const gaps = crossingYs.get(c);
    if (!gaps || gaps.length === 0) {
      svgLine(svg, cX, TOP, cX, BOT, undefined, edgeTag);
    } else {
      const sorted = [...gaps].sort((a, b) => a - b);
      let y = TOP;
      for (const gapY of sorted) {
        if (y < gapY - CROSS_GAP / 2) {
          svgLine(svg, cX, y, cX, gapY - CROSS_GAP / 2, undefined, edgeTag);
        }
        y = gapY + CROSS_GAP / 2;
      }
      if (y < ROW_H) {
        svgLine(svg, cX, y, cX, BOT, undefined, edgeTag);
      }
    }
  }

  const mainInTag = info.mainInEdgeIds.join(" ");
  const mainOutTag = info.mainOutEdgeIds.join(" ");
  const allBranchTag = [...info.branchEdgeId.values()].join(" ");

  // 2. This node's column verticals
  if (info.arrivedFromAbove) {
    svgLine(svg, nodeX, TOP, nodeX, midY - DOT_R, "incoming", mainInTag);
  }
  if (info.continuesBelow) {
    svgLine(svg, nodeX, midY + DOT_R, nodeX, BOT, "outgoing", mainOutTag);
  }

  // 3. Branch connectors: vertical down → curve right → horizontal segments → per-target curve + vertical
  if (info.branchCols.length > 0) {
    const sorted = [...info.branchCols].sort((a, b) => a - b);

    if (!info.continuesBelow) {
      svgLine(svg, nodeX, midY + DOT_R, nodeX, branchY - CURVE_R, "outgoing", allBranchTag);
    }

    svgPath(svg, `M ${nodeX} ${branchY - CURVE_R} Q ${nodeX} ${branchY} ${nodeX + CURVE_R} ${branchY}`, "outgoing", allBranchTag);

    let segStartX = nodeX + CURVE_R;
    for (let i = 0; i < sorted.length; i++) {
      const bcX = cx(sorted[i]);
      const segTag = sorted.slice(i).map(c => info.branchEdgeId.get(c) ?? "").filter(Boolean).join(" ");
      if (segStartX < bcX - CURVE_R) {
        svgLine(svg, segStartX, branchY, bcX - CURVE_R, branchY, "outgoing", segTag);
      }
      const bcTag = info.branchEdgeId.get(sorted[i]) ?? "";
      svgPath(svg, `M ${bcX - CURVE_R} ${branchY} Q ${bcX} ${branchY} ${bcX} ${branchY + CURVE_R}`, "outgoing", bcTag);
      if (branchY + CURVE_R < ROW_H) {
        svgLine(svg, bcX, branchY + CURVE_R, bcX, BOT, "outgoing", bcTag);
      }
      segStartX = bcX - CURVE_R;
    }
  }

  // 4. Merge connectors: each tagged with its specific merge edge ID
  for (const mc of info.mergeCols) {
    const mcX = cx(mc);
    const mcTag = info.mergeEdgeId.get(mc) ?? "";
    if (mcX < nodeX) {
      svgLine(svg, mcX, TOP, mcX, mergeY - CURVE_R, "incoming", mcTag);
      svgPath(svg, `M ${mcX} ${mergeY - CURVE_R} Q ${mcX} ${mergeY} ${mcX + CURVE_R} ${mergeY}`, "incoming", mcTag);
      if (mcX + CURVE_R < nodeX - CURVE_R) {
        svgLine(svg, mcX + CURVE_R, mergeY, nodeX - CURVE_R, mergeY, "incoming", mcTag);
      }
      svgPath(svg, `M ${nodeX - CURVE_R} ${mergeY} Q ${nodeX} ${mergeY} ${nodeX} ${mergeY + CURVE_R}`, "incoming", mcTag);
      if (mergeY + CURVE_R < midY - DOT_R) {
        svgLine(svg, nodeX, mergeY + CURVE_R, nodeX, midY - DOT_R, "incoming", mcTag);
      }
    } else {
      svgLine(svg, mcX, TOP, mcX, mergeY - CURVE_R, "incoming", mcTag);
      svgPath(svg, `M ${mcX} ${mergeY - CURVE_R} Q ${mcX} ${mergeY} ${mcX - CURVE_R} ${mergeY}`, "incoming", mcTag);
      if (mcX - CURVE_R > nodeX + CURVE_R) {
        svgLine(svg, nodeX + CURVE_R, mergeY, mcX - CURVE_R, mergeY, "incoming", mcTag);
      }
      svgPath(svg, `M ${nodeX + CURVE_R} ${mergeY} Q ${nodeX} ${mergeY} ${nodeX} ${mergeY + CURVE_R}`, "incoming", mcTag);
      if (mergeY + CURVE_R < midY - DOT_R) {
        svgLine(svg, nodeX, mergeY + CURVE_R, nodeX, midY - DOT_R, "incoming", mcTag);
      }
    }
  }

  // 5. Node dot + collapse ring (grouped; both use currentColor so
  //    changing `color` on the group recolors dot and ring together)
  const dotGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  dotGroup.dataset.dot = info.nodeId;
  dotGroup.setAttribute("color", DOT_COLOR);
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  ring.setAttribute("cx", String(nodeX));
  ring.setAttribute("cy", String(midY));
  ring.setAttribute("r", String(DOT_R + 3));
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "currentColor");
  ring.setAttribute("stroke-width", "1.5");
  ring.classList.add("collapse-ring");
  dotGroup.appendChild(ring);
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", String(nodeX));
  dot.setAttribute("cy", String(midY));
  dot.setAttribute("r", String(DOT_R));
  dot.setAttribute("fill", "currentColor");
  dotGroup.appendChild(dot);
  svg.appendChild(dotGroup);

  // 6. Highlight overlay: duplicate edge-tagged elements with transparent stroke/fill.
  //    Drawn last (on top). CSS transitions interpolate between transparent and highlight colors.
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlay.classList.add("hl-layer");
  overlay.setAttribute("pointer-events", "none");
  for (const el of svg.querySelectorAll("[data-edges]")) {
    const clone = el.cloneNode(false) as SVGElement;
    clone.removeAttribute("class");
    clone.classList.add("hl");
    clone.setAttribute("stroke", "transparent");
    overlay.appendChild(clone);
  }
  const dotGroupClone = dotGroup.cloneNode(true) as SVGElement;
  dotGroupClone.classList.add("hl");
  dotGroupClone.setAttribute("color", "transparent");
  dotGroupClone.dataset.dot = info.nodeId;
  overlay.appendChild(dotGroupClone);
  svg.appendChild(overlay);

  return svg;
}
