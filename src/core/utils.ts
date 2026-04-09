/**
 * Pure utility functions — no DOM measurement, no core type dependencies.
 */

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
