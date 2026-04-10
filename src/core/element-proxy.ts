/* eslint-disable no-restricted-globals -- Sole authorized wrapper around getComputedStyle */

/**
 * ElementProxy — the single authorized path for reading computed CSS.
 *
 * Every CSS property read is recorded for display in the UI.
 * DOM navigation methods (getParent, getContainingBlock, getFlexChildren)
 * return new proxies with appropriate key prefixes.
 */

import type { Axis } from "./types";

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

  /**
   * Proxy for the layout parent — the nearest ancestor that isn't display:contents.
   * Reads are prefixed with "parent." regardless of how many levels were skipped.
   */
  getLayoutParent(): ElementProxy {
    let ancestor = this.element.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      if (getComputedStyle(ancestor).display !== "contents") {
        return new ElementProxy(ancestor, this._records, this._prefixed("parent"));
      }
      ancestor = ancestor.parentElement;
    }
    return new ElementProxy(ancestor ?? document.documentElement, this._records, this._prefixed("parent"));
  }

  /** Proxy for the containing block. Reads are prefixed with "containingBlock.". */
  getContainingBlock(): ElementProxy {
    const cb = findContainingBlock(this.element);
    return new ElementProxy(cb, this._records, this._prefixed("containingBlock"));
  }

  /**
   * Get proxies for flex/grid children of this element.
   * Skips positioned and hidden elements. Recurses into display:contents children
   * since those children participate in this element's formatting context.
   * Filtered children's styles are NOT recorded.
   */
  getFlexChildren(): ElementProxy[] {
    const children: ElementProxy[] = [];
    const collect = (parent: Element) => {
      for (const child of Array.from(parent.children)) {
        const cs = getComputedStyle(child);
        if (cs.position === "absolute" || cs.position === "fixed") continue;
        if (cs.display === "none") continue;
        if (cs.display === "contents") {
          collect(child); // Recurse — contents children participate in this context
          continue;
        }
        children.push(new ElementProxy(child));
      }
    };
    collect(this.element);
    return children;
  }

  /**
   * Get proxies for flow children (skips positioned, hidden; recurses into contents).
   * Filtered children's styles are NOT recorded.
   */
  getChildren(): ElementProxy[] {
    return this.getFlexChildren(); // same filter logic
  }

  /**
   * Does this element establish a new block formatting context?
   * BFC triggers: overflow != visible, display: flex/grid/flow-root/table/etc.,
   * float: left/right, position: absolute/fixed, contain: layout/paint.
   * Reads are not recorded (this is a structural check).
   */
  isNewBlockFormattingContext(): boolean {
    const s = getComputedStyle(this.element);
    if (s.overflow !== "visible") return true;
    if (s.display === "flex" || s.display === "inline-flex") return true;
    if (s.display === "grid" || s.display === "inline-grid") return true;
    if (s.display === "flow-root" || s.display === "inline-block") return true;
    if (s.display === "table" || s.display === "inline-table") return true;
    if (s.display === "table-cell") return true;
    if (s.float !== "none") return true;
    if (s.position === "absolute" || s.position === "fixed") return true;
    const contain = s.contain;
    if (contain && (contain.includes("layout") || contain.includes("paint") || contain.includes("content") || contain.includes("strict"))) return true;
    return false;
  }

  /**
   * Sum the outer border-box widths (including margins) of preceding float
   * siblings of this element in the normal flow. Used to compute how much
   * horizontal space a BFC element must avoid. Reads are not recorded.
   */
  sumPrecedingFloatOuterWidth(): number {
    const el = this.element;
    const parent = el.parentElement;
    if (!parent) return 0;
    let total = 0;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === el) break;
      const cs = getComputedStyle(sibling);
      if (cs.float === "none") continue;
      if (cs.display === "none" || cs.display === "contents") continue;
      // offsetWidth gives the border-box width; add margins separately.
      const borderBox = (sibling as HTMLElement).offsetWidth;
      const marginLeft = parseFloat(cs.marginLeft) || 0;
      const marginRight = parseFloat(cs.marginRight) || 0;
      total += borderBox + marginLeft + marginRight;
    }
    return total;
  }

  /**
   * Get the measured sizes of anonymous flex items — runs of text content
   * directly inside this element, or inside its display:contents descendants.
   * Each run of text between element siblings becomes one anonymous item.
   *
   * Measured by inserting a temporary span with the same text and reading
   * offsetWidth/offsetHeight, so font/writing-mode context is inherited.
   */
  getAnonymousFlexItemSizes(axis: Axis): number[] {
    const sizes: number[] = [];
    let currentRun: Text[] = [];

    const flushRun = (hostParent: Element) => {
      if (currentRun.length === 0) return;
      const text = currentRun.map(n => n.textContent ?? "").join("");
      currentRun = [];
      if (!text.trim()) return;
      const span = hostParent.ownerDocument.createElement("span");
      // white-space: pre prevents the text from wrapping so we get its
      // max-content size in the inline direction.
      span.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;white-space:pre;";
      span.textContent = text;
      hostParent.appendChild(span);
      const size = axis === "width" ? span.offsetWidth : span.offsetHeight;
      span.remove();
      sizes.push(size);
    };

    const walk = (parent: Element) => {
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          currentRun.push(node as Text);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          const cs = getComputedStyle(el);
          if (cs.display === "contents") {
            walk(el);
          } else if (cs.position !== "absolute" && cs.position !== "fixed" && cs.display !== "none") {
            // Element boundary — flush current text run before the element.
            flushRun(parent);
          }
          // Positioned/hidden elements don't break runs.
        }
      }
      flushRun(parent);
    };

    walk(this.element);
    return sizes;
  }

  // --- Explicit size detection ---

  /**
   * Check if this element has an explicitly set size on the given axis.
   * Records the property read if an explicit size is found.
   * Returns null if the size is auto/content-driven.
   */
  getExplicitSize(axis: Axis): ExplicitSize | null {
    const el = this.element;
    // Also check logical properties (inline-size maps to width in horizontal-tb)
    const logicalProp = axis === "width" ? "inline-size" : "block-size";

    // For px literals, parse the authored value directly. Computed style
    // returns the post-layout used value, which for flex items differs from
    // the authored value. For percentages and CSS expressions, we fall back to
    // the computed value (which is already resolved by the browser).
    const resolveExplicit = (val: string): ExplicitSize | null => {
      if (val.endsWith("%")) return { kind: "percentage", resolvedPx: this.readPx(axis) };
      if (val.endsWith("px")) {
        const parsed = parseFloat(val);
        if (!isNaN(parsed)) return { kind: "fixed", resolvedPx: parsed };
      }
      if (isExplicitLength(val)) return { kind: "fixed", resolvedPx: this.readPx(axis) };
      if (isCssFunction(val)) return { kind: "fixed", resolvedPx: this.readPx(axis) };
      return null;
    };

    // Check inline style first (physical then logical)
    if (el instanceof HTMLElement) {
      for (const prop of [axis, logicalProp]) {
        const inlineVal = el.style.getPropertyValue(prop);
        if (inlineVal) {
          const resolved = resolveExplicit(inlineVal);
          if (resolved) return resolved;
          if (inlineVal === "auto" || inlineVal === "none") return null;
          if (isIntrinsicKeyword(inlineVal)) return null; // Handled separately
        }
      }
    }

    // Check stylesheet rules (physical then logical)
    const rules = getMatchedCSSRules(el);
    for (let i = rules.length - 1; i >= 0; i--) {
      for (const prop of [axis, logicalProp]) {
        const val = rules[i].style.getPropertyValue(prop);
        if (!val) continue;
        const resolved = resolveExplicit(val);
        if (resolved) return resolved;
        if (val === "auto" || val === "none") return null;
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

function isExplicitLength(val: string): boolean {
  return /^-?[\d.]+(?:px|em|rem|vh|vw|vmin|vmax|cm|mm|in|pt|pc|ch|ex|lh|rlh|cqi|cqb)$/.test(val);
}

function isCssFunction(val: string): boolean {
  return val.startsWith("calc(") || val.startsWith("min(") || val.startsWith("max(") ||
    val.startsWith("clamp(") || val.startsWith("var(");
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



/**
 * Walk up the DOM to find the containing block for an element.
 * Per CSS2 §10.1 and CSS Positioned Layout §3.
 */
function findContainingBlock(el: Element): Element {
  const position = getComputedStyle(el).position;
  let ancestor = el.parentElement;

  if (position === "fixed") {
    // Normally the viewport, but transform/filter/perspective/contain
    // ancestors create a containing block even for fixed elements.
    while (ancestor && ancestor !== document.documentElement) {
      if (createsFixedContainingBlock(ancestor)) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return document.documentElement;
  }

  if (position === "absolute") {
    while (ancestor && ancestor !== document.documentElement) {
      if (createsAbsoluteContainingBlock(ancestor)) return ancestor;
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

/** Does this element create a containing block for position: fixed descendants? */
function createsFixedContainingBlock(el: Element): boolean {
  const s = getComputedStyle(el);
  if (s.transform !== "none") return true;
  if (s.filter !== "none") return true;
  if (s.perspective !== "none") return true;
  const wc = s.willChange;
  if (wc === "transform" || wc === "filter" || wc === "perspective") return true;
  const contain = s.contain;
  if (contain && (contain.includes("layout") || contain.includes("paint") || contain.includes("strict") || contain.includes("content"))) return true;
  return false;
}

/** Does this element create a containing block for position: absolute descendants? */
function createsAbsoluteContainingBlock(el: Element): boolean {
  const s = getComputedStyle(el);
  if (s.position !== "static") return true;
  return createsFixedContainingBlock(el);
}
