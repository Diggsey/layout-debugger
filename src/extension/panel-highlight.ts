// Hover highlighting: graph edges/dots and page element overlay.

import {
  HOVER_DOT_COLOR, HOVER_IN_COLOR, HOVER_OUT_COLOR, LINE_COLOR,
  edgeId,
} from "./panel-types";

// ---------------------------------------------------------------------------
// Graph hover highlighting (SVG overlay + detail rails)
// ---------------------------------------------------------------------------

/** Set or clear a highlight overlay element's color based on its tag. */
function setHlColor(el: SVGElement, color: string): void {
  if (el.tagName === "g") {
    el.setAttribute("color", color);
  } else if (el.tagName === "circle") {
    el.setAttribute("fill", color);
  } else {
    el.setAttribute("stroke", color);
  }
}

/** Highlight full edge paths and dots when hovering a node row. */
export function highlightGraph(section: HTMLElement, nodeId: string, deps: string[]): void {
  function highlightEdge(eid: string, color: string): void {
    section.querySelectorAll(`.hl[data-edges~="${eid}"], .detail-rail[data-edges~="${eid}"]`).forEach((el) => {
      (el as SVGElement).setAttribute("stroke", color);
    });
  }

  // Outgoing edges (this node → its deps): purple
  for (const dep of deps) {
    highlightEdge(edgeId(nodeId, dep), HOVER_OUT_COLOR);
    section.querySelectorAll(`.hl[data-dot="${dep}"]`).forEach((el) => setHlColor(el as SVGElement, HOVER_OUT_COLOR));
  }

  // Incoming edges (parents → this node): blue
  section.querySelectorAll<HTMLElement>(".graph-row").forEach((row) => {
    const parentId = row.dataset.nodeId!;
    const parentDeps = (row.dataset.deps ?? "").split(",");
    if (parentDeps.includes(nodeId)) {
      highlightEdge(edgeId(parentId, nodeId), HOVER_IN_COLOR);
      section.querySelectorAll(`.hl[data-dot="${parentId}"]`).forEach((el) => setHlColor(el as SVGElement, HOVER_IN_COLOR));
    }
  });

  // Hovered node's dot
  section.querySelectorAll(`.hl[data-dot="${nodeId}"]`).forEach((el) => setHlColor(el as SVGElement, HOVER_DOT_COLOR));
}

/** Clear all graph hover highlights. */
export function clearGraphHighlight(section: HTMLElement): void {
  section.querySelectorAll(".hl").forEach((el) => setHlColor(el as SVGElement, "transparent"));
  section.querySelectorAll(".detail-rail[data-edges]").forEach((el) => {
    (el as SVGElement).setAttribute("stroke", LINE_COLOR);
  });
}

/** Highlight a specific calc-ref: the referenced node's row, the edge to it, and its dot. */
export function highlightRef(section: HTMLElement, fromId: string, toId: string): void {
  const row = section.querySelector(`.graph-row[data-node-id="${toId}"]`);
  if (row) row.classList.add("highlighted");

  const eid = edgeId(fromId, toId);
  section.querySelectorAll(`.hl[data-edges~="${eid}"], .detail-rail[data-edges~="${eid}"]`).forEach((el) => {
    (el as SVGElement).setAttribute("stroke", HOVER_OUT_COLOR);
  });
  section.querySelectorAll(`.hl[data-dot="${toId}"]`).forEach((el) => setHlColor(el as SVGElement, HOVER_OUT_COLOR));
}

export function clearRefHighlight(section: HTMLElement): void {
  section.querySelectorAll(".graph-row.highlighted").forEach((el) => el.classList.remove("highlighted"));
  clearGraphHighlight(section);
}

// ---------------------------------------------------------------------------
// Page element overlay (runs in the inspected page via eval)
// ---------------------------------------------------------------------------

export function highlightInPage(path: string): void {
  const escaped = path.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  chrome.devtools.inspectedWindow.eval(`(function() {
    var el = document.querySelector('${escaped}');
    if (!el) return;
    var r = el.getBoundingClientRect();
    var w = Math.round(r.width * 100) / 100;
    var h = Math.round(r.height * 100) / 100;

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
    if (r.bottom + 24 > window.innerHeight) {
      lbl.style.top = (r.top - 20) + 'px';
    }
    if (r.left + lbl.offsetWidth > window.innerWidth) {
      lbl.style.left = (window.innerWidth - lbl.offsetWidth - 4) + 'px';
    }
  })()`);
}

export function clearHighlightInPage(): void {
  chrome.devtools.inspectedWindow.eval(`(function() {
    var ov = document.getElementById('__layout-debugger-overlay');
    if (ov) ov.style.display = 'none';
    var lbl = document.getElementById('__layout-debugger-label');
    if (lbl) lbl.style.display = 'none';
  })()`);
}
