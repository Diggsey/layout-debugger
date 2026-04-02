/**
 * Layout context identification.
 *
 * Spec references:
 * - CSS Display 3 §2  Types of Boxes
 *   https://www.w3.org/TR/css-display-3/#box-generation
 * - CSS2 §9.2  Controlling box generation
 *   https://www.w3.org/TR/CSS2/visuren.html#display-prop
 */
import { LayoutContext, LayoutMode } from "./types";
import { findContainingBlock, getContainingBlockSize } from "./containing-block";

/**
 * Identify the layout context for a given element.
 *
 * Determines which sizing algorithm governs the element by examining
 * its own display/position and its parent's display type.
 *
 * CSS2 §9.2: The display, position, and float properties determine
 * which formatting context an element participates in.
 */
export function identifyContext(el: Element): LayoutContext {
  const s = getComputedStyle(el);
  const display = s.display;
  const position = s.position;
  const float = s.cssFloat;

  const parent = el.parentElement || document.documentElement;
  const parentDisplay = getComputedStyle(parent).display;

  const cb = findContainingBlock(el);
  const cbSize = getContainingBlockSize(cb, position);

  const mode = resolveMode(display, position, parentDisplay);

  // Writing mode determines which physical axis is inline vs block
  const wm = s.writingMode;
  const isVertical = wm === "vertical-rl" || wm === "vertical-lr";

  return {
    mode,
    parent,
    parentDisplay,
    containingBlock: cb,
    containingBlockSize: cbSize,
    position,
    display,
    float,
    inlineAxis: isVertical ? "height" : "width",
    blockAxis: isVertical ? "width" : "height",
  };
}

/**
 * Resolve the layout mode governing an element's sizing.
 *
 * CSS2 §9.7: Relationships between display, position, and float.
 * CSS Flexbox §4: Flex items — children of flex containers.
 * CSS Grid §6: Grid items — children of grid containers.
 *
 * Priority: positioned > parent-flex > parent-grid > table > inline > block
 */
function resolveMode(display: string, position: string, parentDisplay: string): LayoutMode {
  // CSS2 §9.6.1: Absolutely positioned elements are removed from flow
  // and don't participate in flex/grid layout.
  if (position === "absolute" || position === "fixed") {
    return "positioned";
  }

  // Check what layout context the parent establishes
  if (parentDisplay === "flex" || parentDisplay === "inline-flex") {
    return "flex";
  }
  if (parentDisplay === "grid" || parentDisplay === "inline-grid") {
    return "grid";
  }

  // Table cells
  if (
    display === "table-cell" ||
    parentDisplay === "table-row" ||
    parentDisplay === "table" ||
    parentDisplay === "inline-table"
  ) {
    return "table-cell";
  }

  // Inline-block
  if (display === "inline-block") {
    return "inline-block";
  }

  // Inline
  if (display === "inline") {
    return "inline";
  }

  // Default: block flow
  return "block";
}
