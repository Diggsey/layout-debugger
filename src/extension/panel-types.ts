// Shared types, constants, and small utilities for the panel.

import type { DagInput, LayoutResult } from "../core/dag-layout";

export interface CalcSegment { text: string; refId?: string; label?: string; }
export interface RenderNode {
  id: string; elementPath: string; elementDesc: string; kind: string;
  axis: string; result: number; resultUnit: string; description: string;
  calculation: CalcSegment[];
  expression: string; cssProperties: Record<string, string>;
  cssReasons: Record<string, string>; dependsOn: string[];
}
export interface AxisRender { axis: string; result: number; nodes: RenderNode[]; }
export interface DagRender { elementPath: string; elementDesc: string; width: AxisRender; height: AxisRender; }

/** Per-axis persistent state shared across re-renders and the collapse system. */
export interface AxisState {
  axis: AxisRender;
  nodeMap: Map<string, RenderNode>;
  allNodeIds: Set<string>;
  fullDagInput: DagInput[];
  fullLayout: LayoutResult;
  collapsedSet: Set<string>;
  openDetails: Set<string>;
  section: HTMLElement;
  rowContainer: HTMLElement;
  asciiPre: HTMLElement;
}

// --- SVG gutter constants ---

export const COL_W = 16;
export const ROW_H = 28;
export const LINE_COLOR = "#30363d";
export const DOT_COLOR = "#4078b4";
export const HOVER_DOT_COLOR = "#f0883e";
export const HOVER_IN_COLOR = "#79c0ff";
export const HOVER_OUT_COLOR = "#bc8cff";
export const DOT_R = 4;
export const LINE_W = 2;
export const CURVE_R = 7;
export const CROSS_GAP = 6;

/** Center X of a column in the SVG gutter. */
export function cx(c: number): number { return c * COL_W + COL_W / 2; }

/** Unique identifier for an edge between two nodes. */
export function edgeId(fromId: string, toId: string): string {
  return `${fromId}>${toId}`;
}

/** Format a node kind as a human-readable label. */
export function formatKind(kind: string): string {
  return kind.replace(/-/g, " ");
}

/** HTML-escape a string. */
export function esc(s: string): string {
  const d = document.createElement("span"); d.textContent = s; return d.innerHTML;
}
