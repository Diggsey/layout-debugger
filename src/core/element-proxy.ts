/* eslint-disable no-restricted-globals -- Sole authorized wrapper around getComputedStyle */

/**
 * ElementProxy — the single authorized path for reading computed CSS.
 *
 * Every CSS property read is recorded for display in the UI.
 * DOM navigation methods (getParent, getContainingBlock, getFlexChildren)
 * return new proxies with appropriate key prefixes.
 */

import type { Axis } from "./dag";

// ---------------------------------------------------------------------------
// CSS property name type — every tracked property must be listed here
// ---------------------------------------------------------------------------

export type CssPropertyName =
  // Box model
  | "width" | "height"
  | "min-width" | "min-height" | "max-width" | "max-height"
  | "padding-left" | "padding-right" | "padding-top" | "padding-bottom"
  | "border-left-width" | "border-right-width" | "border-top-width" | "border-bottom-width"
  | "margin-left" | "margin-right" | "margin-top" | "margin-bottom"
  | "box-sizing"
  // Layout mode
  | "display" | "position" | "float" | "writing-mode"
  // Flex
  | "flex-basis" | "flex-grow" | "flex-shrink" | "flex-direction" | "flex-wrap"
  | "align-self" | "align-items"
  | "column-gap" | "row-gap"
  // Grid
  | "grid-column" | "grid-row"
  // Positioning
  | "left" | "right" | "top" | "bottom"
  // Overflow
  | "overflow" | "overflow-x" | "overflow-y"
  // Sizing
  | "aspect-ratio";

// ---------------------------------------------------------------------------
// Auto-reason generation — every CssPropertyName must have an entry
// ---------------------------------------------------------------------------

const REASON_TABLE: Record<CssPropertyName, string> = {
  "width":              "Computed width",
  "height":             "Computed height",
  "min-width":          "Minimum width constraint",
  "min-height":         "Minimum height constraint",
  "max-width":          "Maximum width constraint",
  "max-height":         "Maximum height constraint",
  "padding-left":       "Left padding",
  "padding-right":      "Right padding",
  "padding-top":        "Top padding",
  "padding-bottom":     "Bottom padding",
  "border-left-width":  "Left border width",
  "border-right-width": "Right border width",
  "border-top-width":   "Top border width",
  "border-bottom-width": "Bottom border width",
  "margin-left":        "Left margin",
  "margin-right":       "Right margin",
  "margin-top":         "Top margin",
  "margin-bottom":      "Bottom margin",
  "box-sizing":         "Whether padding/border are included in size",
  "display":            "Determines box generation and layout mode",
  "position":           "Determines positioning scheme",
  "float":              "Float direction",
  "writing-mode":       "Determines inline vs block axis direction",
  "flex-basis":         "Starting size before flex distribution",
  "flex-grow":          "Growth factor relative to siblings",
  "flex-shrink":        "Shrink factor relative to siblings",
  "flex-direction":     "Determines main vs cross axis",
  "flex-wrap":          "Single-line vs multi-line flex",
  "align-self":         "Cross-axis alignment of this item",
  "align-items":        "Container default for cross-axis alignment",
  "column-gap":         "Gap between columns",
  "row-gap":            "Gap between rows",
  "grid-column":        "Grid column placement",
  "grid-row":           "Grid row placement",
  "left":               "Left offset from containing block",
  "right":              "Right offset from containing block",
  "top":                "Top offset from containing block",
  "bottom":             "Bottom offset from containing block",
  "overflow":           "Affects minimum size calculation",
  "overflow-x":         "Horizontal overflow behavior",
  "overflow-y":         "Vertical overflow behavior",
  "aspect-ratio":       "Ratio between width and height",
};

function autoReason(key: string): string {
  // Strip all prefixes (parent., containingBlock., etc.) for lookup
  const bare = key.replace(/^.+\./, "") as CssPropertyName;
  return REASON_TABLE[bare] ?? "";
}

// ---------------------------------------------------------------------------
// Explicit size detection
// ---------------------------------------------------------------------------

export interface ExplicitSize {
  kind: "fixed" | "percentage";
  resolvedPx: number;
}

// ---------------------------------------------------------------------------
// ElementProxy
// ---------------------------------------------------------------------------

export class ElementProxy {
  readonly element: Element;
  private _style: CSSStyleDeclaration;
  private _prefix: string;
  private _records: [key: string, value: string][];

  constructor(element: Element, records?: [string, string][], prefix = "") {
    this.element = element;
    this._style = getComputedStyle(element);
    this._prefix = prefix;
    this._records = records ?? [];
  }

  // --- CSS property reads ---

  /** Read a CSS property, record it, and return the value. */
  readProperty(name: CssPropertyName): string {
    const val = this._style.getPropertyValue(name);
    const key = this._prefix ? `${this._prefix}.${name}` : name;
    this._records.push([key, val]);
    return val;
  }

  /** Read a CSS property as a pixel number. */
  readPx(name: CssPropertyName): number {
    return parseFloat(this.readProperty(name)) || 0;
  }

  /** Record a synthetic CSS property value (e.g. "auto" when computed differs). */
  record(name: CssPropertyName, value: string): void {
    const key = this._prefix ? `${this._prefix}.${name}` : name;
    this._records.push([key, value]);
  }

  // --- DOM navigation ---

  /** Proxy for the parent element. Reads are prefixed with "parent.". */
  getParent(): ElementProxy {
    return new ElementProxy(this.element.parentElement!, this._records, this._prefixed("parent"));
  }

  /** Proxy for the containing block. Reads are prefixed with "containingBlock.". */
  getContainingBlock(): ElementProxy {
    const cb = findContainingBlock(this.element);
    return new ElementProxy(cb, this._records, this._prefixed("containingBlock"));
  }

  /**
   * Get proxies for flex children of this element (skips positioned, hidden, contents).
   * Filtered children's styles are NOT recorded.
   */
  getFlexChildren(): ElementProxy[] {
    const children: ElementProxy[] = [];
    for (const child of Array.from(this.element.children)) {
      const cs = getComputedStyle(child);
      if (cs.position === "absolute" || cs.position === "fixed") continue;
      if (cs.display === "none" || cs.display === "contents") continue;
      children.push(new ElementProxy(child));
    }
    return children;
  }

  /**
   * Get proxies for flow children (skips positioned, hidden, contents).
   * Filtered children's styles are NOT recorded.
   */
  getChildren(): ElementProxy[] {
    return this.getFlexChildren(); // same filter logic
  }

  // --- Explicit size detection ---

  /**
   * Check if this element has an explicitly set size on the given axis.
   * Records the property read if an explicit size is found.
   * Returns null if the size is auto/content-driven.
   */
  getExplicitSize(axis: Axis): ExplicitSize | null {
    const el = this.element;

    // Check inline style first
    if (el instanceof HTMLElement) {
      const inlineVal = el.style.getPropertyValue(axis);
      if (inlineVal) {
        if (inlineVal.endsWith("%")) return { kind: "percentage", resolvedPx: this.readPx(axis) };
        if (isExplicitLength(inlineVal)) return { kind: "fixed", resolvedPx: this.readPx(axis) };
      }
    }

    // Check stylesheet rules
    const rules = getMatchedCSSRules(el);
    for (let i = rules.length - 1; i >= 0; i--) {
      const val = rules[i].style.getPropertyValue(axis);
      if (!val) continue;
      if (val.endsWith("%")) return { kind: "percentage", resolvedPx: this.readPx(axis) };
      if (isExplicitLength(val)) return { kind: "fixed", resolvedPx: this.readPx(axis) };
      if (val === "auto" || val === "none") return null;
      // CSS variable or calc — resolve
      if (val.startsWith("var(") || val.startsWith("calc(") || val.startsWith("min(") || val.startsWith("max(") || val.startsWith("clamp(")) {
        return { kind: "fixed", resolvedPx: this.readPx(axis) };
      }
    }

    return null;
  }

  /**
   * Get the specified (authored) value of a CSS property, before layout resolution.
   * Unlike computed style, this returns the pre-layout value (e.g. "200px" not the
   * post-flex used value). Records the specified value if found.
   */
  getSpecifiedValue(axis: Axis): string | null {
    const el = this.element;

    if (el instanceof HTMLElement) {
      const inlineVal = el.style.getPropertyValue(axis);
      if (inlineVal && inlineVal !== "auto") {
        this.record(axis, inlineVal);
        return inlineVal;
      }
    }

    const rules = getMatchedCSSRules(el);
    for (let i = rules.length - 1; i >= 0; i--) {
      const val = rules[i].style.getPropertyValue(axis);
      if (val && val !== "auto" && val !== "initial" && val !== "inherit" && val !== "unset" && val !== "revert") {
        this.record(axis, val);
        return val;
      }
    }

    return null;
  }

  /**
   * Check if this element has a specified intrinsic sizing keyword
   * (min-content, max-content, fit-content) on the given axis.
   * Records the keyword if found.
   */
  getIntrinsicKeyword(axis: Axis): string | null {
    const el = this.element;

    if (el instanceof HTMLElement) {
      const val = el.style.getPropertyValue(axis);
      if (isIntrinsicKeyword(val)) {
        this.record(axis, val);
        return val;
      }
    }

    const rules = getMatchedCSSRules(el);
    for (let i = rules.length - 1; i >= 0; i--) {
      const val = rules[i].style.getPropertyValue(axis);
      if (!val) continue;
      if (isIntrinsicKeyword(val)) {
        this.record(axis, val);
        return val;
      }
      return null; // non-intrinsic value found, stop
    }

    return null;
  }

  // --- Record management ---

  /** Drain recorded reads into target maps. Existing keys are not overwritten. */
  drainInto(props: Record<string, string>, reasons: Record<string, string>): void {
    for (const [key, value] of this._records) {
      if (!(key in props)) {
        props[key] = value;
        const reason = autoReason(key);
        if (reason) reasons[key] = reason;
      }
    }
    this._records = [];
  }

  // --- Internal helpers ---

  private _prefixed(segment: string): string {
    return this._prefix ? `${this._prefix}.${segment}` : segment;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported — only ElementProxy uses getComputedStyle)
// ---------------------------------------------------------------------------

function px(v: string): number { return parseFloat(v) || 0; }

function isExplicitLength(val: string): boolean {
  return /^-?[\d.]+(?:px|em|rem|vh|vw|vmin|vmax|cm|mm|in|pt|pc|ch|ex|lh|rlh|cqi|cqb)$/.test(val);
}

function isIntrinsicKeyword(val: string): boolean {
  return val === "min-content" || val === "max-content" ||
    val === "fit-content" || val.startsWith("fit-content(");
}

/** Get matched CSS rules for an element (cascade order). */
function getMatchedCSSRules(el: Element): CSSStyleRule[] {
  const matched: CSSStyleRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSStyleRule && el.matches(rule.selectorText)) {
          matched.push(rule);
        }
      }
    } catch {
      // Cross-origin stylesheet — skip
    }
  }
  return matched;
}

/** Resolve a CSS variable to its computed value. */
function resolveCssVariable(el: Element, varName: string): string | null {
  const val = getComputedStyle(el).getPropertyValue(varName).trim();
  return val || null;
}


/**
 * Walk up the DOM to find the containing block for an element.
 * Per CSS2 §10.1 and CSS Positioned Layout §3.
 */
function findContainingBlock(el: Element): Element {
  const position = getComputedStyle(el).position;
  let ancestor = el.parentElement;

  if (position === "fixed") {
    return document.documentElement;
  }

  if (position === "absolute") {
    while (ancestor && ancestor !== document.documentElement) {
      if (createsContainingBlock(ancestor)) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return document.documentElement;
  }

  // Static or relative: containing block is nearest block container ancestor
  while (ancestor && ancestor !== document.documentElement) {
    const d = getComputedStyle(ancestor).display;
    if (d !== "inline" && d !== "contents") {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return document.documentElement;
}

function createsContainingBlock(el: Element): boolean {
  const s = getComputedStyle(el);
  if (s.position !== "static") return true;
  if (s.transform !== "none") return true;
  if (s.filter !== "none") return true;
  if (s.perspective !== "none") return true;
  const wc = s.willChange;
  if (wc === "transform" || wc === "filter" || wc === "perspective") return true;
  const contain = s.contain;
  if (contain && (contain.includes("layout") || contain.includes("paint") || contain.includes("strict") || contain.includes("content"))) return true;
  return false;
}
