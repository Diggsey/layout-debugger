// Collapse/expand animation logic.

import type { AxisState } from "./panel-types";

const ANIM_DURATION = 200; // ms
const BADGE_TRANSITION = `width ${ANIM_DURATION}ms ease-out, padding ${ANIM_DURATION}ms ease-out, margin ${ANIM_DURATION}ms ease-out, opacity ${ANIM_DURATION}ms ease-out`;

// ---------------------------------------------------------------------------
// Visible node computation
// ---------------------------------------------------------------------------

/**
 * BFS from root, skipping children of collapsed nodes.
 * If `skipId` is provided, that node is treated as not collapsed
 * (used to simulate expanding a single node).
 */
export function bfsVisible(state: AxisState, skipId?: string): Set<string> {
  const visible = new Set<string>();
  const root = state.axis.nodes[0];
  if (!root) return visible;

  const queue = [root.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visible.has(id)) continue;
    visible.add(id);

    if (id !== skipId && state.collapsedSet.has(id)) continue;

    const node = state.nodeMap.get(id);
    if (node) {
      for (const dep of node.dependsOn) {
        if (state.allNodeIds.has(dep) && !visible.has(dep)) queue.push(dep);
      }
    }
  }
  return visible;
}

/** Count nodes that would become visible if this node were expanded. */
export function countHiddenDescendants(state: AxisState, nodeId: string, visibleSet: Set<string>): number {
  const hypothetical = bfsVisible(state, nodeId);
  let count = 0;
  for (const id of hypothetical) {
    if (!visibleSet.has(id)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Edge fade helpers
// ---------------------------------------------------------------------------

/**
 * True if ALL edges in the attribute have at least one non-visible endpoint.
 * If any edge has both endpoints visible, the SVG element is still needed.
 */
function shouldFade(edgeAttr: string, visibleSet: Set<string>): boolean {
  for (const eid of edgeAttr.split(" ")) {
    const sep = eid.indexOf(">");
    if (sep < 0) continue;
    if (visibleSet.has(eid.slice(0, sep)) && visibleSet.has(eid.slice(sep + 1))) return false;
  }
  return true;
}

/** Set or animate opacity on edge elements connecting to non-visible nodes. */
function setEdgeOpacity(container: HTMLElement, visibleSet: Set<string>, opacity: string, animate = false): void {
  for (const el of container.querySelectorAll<SVGElement>("[data-edges]")) {
    if (shouldFade(el.dataset.edges!, visibleSet)) {
      if (animate) el.style.transition = `opacity ${ANIM_DURATION}ms ease-out`;
      el.style.opacity = opacity;
    }
  }
}

// ---------------------------------------------------------------------------
// Inline style cleanup
// ---------------------------------------------------------------------------

const ANIM_PROPS = ["transition", "height", "overflow", "opacity"] as const;

/** Strip animation-related inline styles from an element and its children. */
function clearAnimStyles(el: HTMLElement): void {
  for (const p of ANIM_PROPS) el.style[p] = "";
  for (const child of el.querySelectorAll<HTMLElement>("[style]")) {
    child.style.transition = "";
    child.style.opacity = "";
  }
}

/** Strip animation inline styles from all edge elements. */
function clearEdgeStyles(container: HTMLElement): void {
  for (const el of container.querySelectorAll<SVGElement>("[data-edges][style]")) {
    el.style.transition = "";
    el.style.opacity = "";
  }
}

/** Strip badge animation inline styles. */
function clearBadgeStyles(badge: HTMLElement): void {
  badge.style.transition = "";
  badge.style.display = "";
  badge.style.width = "";
  badge.style.padding = "";
  badge.style.marginRight = "";
  badge.style.opacity = "";
  badge.style.overflow = "";
}

// ---------------------------------------------------------------------------
// Row content opacity helpers
// ---------------------------------------------------------------------------

/** Set opacity on the fading parts of a graph-row (summary, badge, dot). */
function setRowContentOpacity(row: HTMLElement, opacity: string, animate = false): void {
  const summary = row.querySelector<HTMLElement>(".node-summary");
  const badge = row.querySelector<HTMLElement>(".collapse-badge");
  const dot = row.querySelector<SVGElement>(".gutter-svg [data-dot]");
  const t = animate ? `opacity ${ANIM_DURATION}ms ease-out` : "";
  for (const el of [summary, badge, dot]) {
    if (!el) continue;
    if (animate) el.style.transition = t;
    el.style.opacity = opacity;
  }
}

// ---------------------------------------------------------------------------
// Collapse / expand
// ---------------------------------------------------------------------------

/**
 * Toggle collapse state for a node, animating rows and badge.
 * `rebuild` is called to snapshot open details and re-render rows.
 */
export function toggleCollapse(state: AxisState, nodeId: string, rebuild: () => void): void {
  const isCollapsing = !state.collapsedSet.has(nodeId);

  if (isCollapsing) {
    animateCollapse(state, nodeId, rebuild);
  } else {
    animateExpand(state, nodeId, rebuild);
  }
}

function animateCollapse(state: AxisState, nodeId: string, rebuild: () => void): void {
  state.collapsedSet.add(nodeId);
  const futureVisible = bfsVisible(state);

  // Identify disappearing rows and their detail panels
  const disappearing: HTMLElement[] = [];
  for (const row of state.rowContainer.querySelectorAll<HTMLElement>(".graph-row")) {
    if (!futureVisible.has(row.dataset.nodeId!)) {
      disappearing.push(row);
      const detail = row.nextElementSibling as HTMLElement | null;
      if (detail?.classList.contains("node-detail")) disappearing.push(detail);
    }
  }

  // Show badge and animate it in from zero
  const collapsingRow = state.rowContainer.querySelector<HTMLElement>(`.graph-row[data-node-id="${nodeId}"]`);
  const badge = collapsingRow?.querySelector<HTMLElement>(".collapse-badge");
  if (collapsingRow) collapsingRow.classList.add("collapsed");
  if (badge) {
    badge.textContent = `+${countHiddenDescendants(state, nodeId, futureVisible)}`;
    const natural = badge.offsetWidth;
    badge.style.width = "0";
    badge.style.padding = "0";
    badge.style.marginRight = "0";
    badge.style.opacity = "0";
    badge.style.overflow = "hidden";
    void badge.offsetHeight; // force reflow
    badge.style.transition = BADGE_TRANSITION;
    badge.style.width = natural + "px";
    badge.style.padding = "";
    badge.style.marginRight = "";
    badge.style.opacity = "1";
    setTimeout(() => { badge.style.transition = ""; badge.style.width = ""; badge.style.overflow = ""; }, ANIM_DURATION);
  }

  if (disappearing.length === 0) {
    return;
  }

  // Fade edges whose endpoints won't both be visible
  setEdgeOpacity(state.rowContainer, futureVisible, "0", true);

  // Shrink disappearing rows and fade their content
  for (const el of disappearing) {
    el.style.height = el.getBoundingClientRect().height + "px";
    el.style.overflow = "hidden";
    if (el.classList.contains("graph-row")) {
      const dot = el.querySelector<SVGElement>(".gutter-svg [data-dot]");
      if (dot) { dot.style.transition = `opacity 0.15s ease-out`; dot.style.opacity = "0"; }
      el.classList.add("row-exit");
    } else {
      el.classList.add("row-exit");
      el.style.opacity = "1";
      void el.offsetHeight;
      el.style.transition = `height 0.2s ease-out, opacity 0.15s ease-out`;
      el.style.opacity = "0";
    }
    void el.offsetHeight;
    el.style.height = "0";
  }

  setTimeout(rebuild, ANIM_DURATION);
}

function animateExpand(state: AxisState, nodeId: string, rebuild: () => void): void {
  // Measure badge before rebuild destroys it
  const oldBadge = state.rowContainer.querySelector<HTMLElement>(`.graph-row[data-node-id="${nodeId}"] .collapse-badge`);
  const badgeWidth = oldBadge ? oldBadge.offsetWidth : 0;

  state.collapsedSet.delete(nodeId);
  const prevVisible = bfsVisible({ ...state, collapsedSet: new Set([...state.collapsedSet, nodeId]) });

  rebuild();

  // Identify newly appearing rows
  const appearing: HTMLElement[] = [];
  for (const row of state.rowContainer.querySelectorAll<HTMLElement>(".graph-row")) {
    if (!prevVisible.has(row.dataset.nodeId!)) {
      appearing.push(row);
      const detail = row.nextElementSibling as HTMLElement | null;
      if (detail?.classList.contains("node-detail") && detail.classList.contains("open")) {
        appearing.push(detail);
      }
    }
  }

  // Force-show badge at its pre-rebuild width so we can animate it out
  const expandedRow = state.rowContainer.querySelector<HTMLElement>(`.graph-row[data-node-id="${nodeId}"]`);
  const badge = expandedRow?.querySelector<HTMLElement>(".collapse-badge");
  if (badge && badgeWidth > 0) {
    badge.style.display = "inline-block";
    badge.style.width = badgeWidth + "px";
    badge.style.overflow = "hidden";
  }

  // Set initial hidden state (no transitions)
  setEdgeOpacity(state.rowContainer, prevVisible, "0");
  for (const el of appearing) {
    el.dataset.naturalHeight = String(el.getBoundingClientRect().height);
    el.style.height = "0";
    el.style.overflow = "hidden";
    if (el.classList.contains("graph-row")) {
      setRowContentOpacity(el, "0");
    } else {
      el.style.opacity = "0";
    }
  }

  // Double-rAF: ensure browser paints hidden state before animating
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // Animate badge out
    if (badge) {
      badge.style.transition = BADGE_TRANSITION;
      badge.style.width = "0";
      badge.style.padding = "0";
      badge.style.marginRight = "0";
      badge.style.opacity = "0";
    }

    // Fade in edges
    setEdgeOpacity(state.rowContainer, prevVisible, "1", true);

    // Expand rows and fade in content
    for (const el of appearing) {
      el.style.transition = `height ${ANIM_DURATION}ms ease-out`;
      el.style.height = el.dataset.naturalHeight + "px";
      delete el.dataset.naturalHeight;
      if (el.classList.contains("graph-row")) {
        setRowContentOpacity(el, "1", true);
      } else {
        el.style.transition = `height ${ANIM_DURATION}ms ease-out, opacity ${ANIM_DURATION}ms ease-out`;
        el.style.opacity = "1";
      }
    }

    setTimeout(() => {
      if (badge) clearBadgeStyles(badge);
      for (const el of appearing) clearAnimStyles(el);
      clearEdgeStyles(state.rowContainer);
    }, ANIM_DURATION);
  }));
}
