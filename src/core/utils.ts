/* eslint-disable eslint-js/no-restricted-syntax -- Measurement utility: authorized to use getBoundingClientRect */

/** Measure an element's border-box size on the given axis. */
export function measureElementSize(el: Element, axis: "width" | "height"): number {
  return el.getBoundingClientRect()[axis];
}

/** Parse a CSS pixel value like "123.45px" to a number. Returns 0 for non-pixel values. */
export function px(value: string): number {
  if (value.endsWith("px")) {
    return parseFloat(value);
  }
  return 0;
}

/** Check if a computed value is effectively 'auto'. */
export function isAuto(value: string): boolean {
  return value === "auto" || value === "";
}

/** Produce a short human-readable descriptor for an element, e.g. "<div.card#main>". */
export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes =
    el.classList.length > 0 ? "." + Array.from(el.classList).slice(0, 3).join(".") : "";
  const extra = el.classList.length > 3 ? "…" : "";
  return `<${tag}${id}${classes}${extra}>`;
}

/** Round a number to at most 2 decimal places. */
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Get the flex direction main axis property name ('width' or 'height'). */
export function flexMainAxisProp(direction: string, writingMode = "horizontal-tb"): "width" | "height" {
  const isVertical = writingMode === "vertical-rl" || writingMode === "vertical-lr";
  const isRow = !direction.startsWith("column");
  // row → inline axis, column → block axis
  // horizontal-tb: inline=width, block=height
  // vertical-*:    inline=height, block=width
  if (isRow) return isVertical ? "height" : "width";
  return isVertical ? "width" : "height";
}

/** Parse a space-separated list of pixel values like "200px 300px 300px" into numbers. */
export function parseTrackList(value: string): number[] {
  if (!value || value === "none") return [];
  return value
    .split(/\s+/)
    .map((v) => px(v))
    .filter((v) => !isNaN(v));
}

/**
 * Measure the min-content size of an element on a given axis.
 * Creates an off-screen clone with `width/height: min-content` and measures it.
 * This is needed because `min-width: auto` on flex items resolves to min-content,
 * but getComputedStyle just returns "auto".
 */
export function measureMinContentSize(el: Element, axis: "width" | "height"): number {
  const clone = el.cloneNode(true) as HTMLElement;
  const crossAxis = axis === "width" ? "height" : "width";
  // Append overrides (don't replace — must preserve existing padding, border, etc.)
  clone.style.cssText += "; " + [
    "position: absolute !important",
    "visibility: hidden !important",
    "pointer-events: none !important",
    `${axis}: min-content !important`,
    `${crossAxis}: auto !important`,
    "flex: none !important",
    "min-width: 0 !important",
    "min-height: 0 !important",
    "max-width: none !important",
    "max-height: none !important",
  ].join("; ");
  // Append to body (not the flex container) to avoid layout interference
  document.body.appendChild(clone);
  const value = clone.getBoundingClientRect()[axis];
  clone.remove();
  return value;
}

/**
 * Measure the intrinsic (content-based) size of an element on a given axis.
 * Creates an off-screen clone with the target axis set to `auto` and
 * `align-self: flex-start` (to prevent stretch), then measures it.
 * This gives the size the element would be based purely on its content.
 */
export function measureIntrinsicSize(el: Element, axis: "width" | "height"): number {
  const clone = el.cloneNode(true) as HTMLElement;
  // Append overrides (don't replace — must preserve existing padding, border, etc.)
  // Keep min-width/min-height intact — the max-content size includes min constraints
  // per CSS Sizing 3 §4.1. Only override the target axis to auto and remove max constraints.
  clone.style.cssText += "; " + [
    "position: absolute !important",
    "visibility: hidden !important",
    "pointer-events: none !important",
    `${axis}: auto !important`,
    "align-self: flex-start !important",
    "flex: none !important",
    "max-width: none !important",
    "max-height: none !important",
  ].join("; ");
  // Preserve the cross-axis size by reading it from the original
  const crossAxis = axis === "width" ? "height" : "width";
  const crossSize = el.getBoundingClientRect()[crossAxis];
  clone.style.setProperty(crossAxis, `${crossSize}px`, "important");

  document.body.appendChild(clone);
  const size = clone.getBoundingClientRect()[axis];
  clone.remove();
  return size;
}
