import { px } from "./utils";

/** Element with CSS Typed OM support (Chrome/Edge). */
interface CSSStyleValue { value: number; constructor: { name: string } }
interface TypedStyleMap { get(name: string): CSSStyleValue | undefined }
interface StyledElement { computedStyleMap(): TypedStyleMap }

/**
 * Resolve a CSS value containing var() references by temporarily applying it
 * to a test element and reading the computed result.
 * e.g. "var(--chakra-sizes-full)" → "100%"
 */
function resolveVarValue(el: Element, rawValue: string): string {
  // Simple case: "var(--name)" or "var(--name, fallback)"
  // Try to extract the variable name and read it directly
  const simpleMatch = rawValue.match(/^\s*var\(\s*(--[^,)]+)\s*(?:,\s*([^)]+))?\s*\)\s*$/);
  if (simpleMatch) {
    const varName = simpleMatch[1];
    const resolved = getComputedStyle(el).getPropertyValue(varName).trim();
    if (resolved) return resolved;
    // If the variable is empty, use the fallback
    if (simpleMatch[2]) return simpleMatch[2].trim();
  }

  // Complex case (calc with nested var, etc.): can't resolve further
  return rawValue;
}

/** Check if a value is percentage-based (pure % or calc containing %). */
function isPercentageDerived(val: string): boolean {
  return val.endsWith("%") || (val.includes("%") && val.includes("calc"));
}

function isContentDerived(val: string): boolean {
  return (
    val === "auto" ||
    val === "initial" ||
    val === "unset" ||
    val === "min-content" ||
    val === "max-content" ||
    val === "fit-content" ||
    val.startsWith("fit-content(")
  );
}

/**
 * Info about an element's specified size on an axis.
 * - 'fixed': an absolute length like 200px, 10em, 5rem (resolvedPx is the value)
 * - 'percentage': a percentage like 100% or 50% (specifiedValue is the string, resolvedPx is the computed pixel value)
 * - null: auto, intrinsic keyword, or unset
 */
export type SizeInfo =
  | {
      kind: "fixed";
      resolvedPx: number;
    }
  | {
      kind: "percentage";
      specifiedValue: string;
      resolvedPx: number;
    }
  | null;

/**
 * Check if an element has an explicit size for the given axis.
 * Returns SizeInfo describing the kind of value, or null if auto/intrinsic/unset.
 *
 * getComputedStyle().width always resolves to pixels for block elements,
 * even when the authored value is "auto" or "100%". We use the CSS Typed OM
 * (computedStyleMap) when available, which preserves keyword values like "auto".
 * Falls back to a heuristic for browsers without Typed OM support.
 */
export function getExplicitSize(el: Element, axis: "width" | "height"): SizeInfo {
  // First, try to get the specified (authored) value
  let specified = getSpecifiedValue(el, axis);

  // If the specified value uses var(), resolve it by reading the variable value.
  // e.g. "var(--chakra-sizes-full)" where --chakra-sizes-full is "100%"
  if (specified && specified.includes("var(")) {
    specified = resolveVarValue(el, specified);
  }

  // If specified value is content-derived, it's not an explicit size
  if (specified && isContentDerived(specified)) return null;

  // If specified value is a percentage or a calc() containing a percentage,
  // it derives from the containing block — not a fixed explicit value
  if (specified && isPercentageDerived(specified)) {
    return {
      kind: "percentage",
      specifiedValue: specified,
      resolvedPx: px(getComputedStyle(el).getPropertyValue(axis)),
    };
  }

  // CSS Typed OM (Chrome/Edge): preserves keyword values like "auto"
  if ("computedStyleMap" in el && typeof (el as unknown as StyledElement).computedStyleMap === "function") {
    try {
      const map = (el as unknown as StyledElement).computedStyleMap();
      const value = map.get(axis);
      // CSSKeywordValue means auto, min-content, max-content, etc. — not explicit
      if (value && value.constructor?.name === "CSSKeywordValue") {
        return null;
      }
      if (value && typeof value.value === "number") {
        return { kind: "fixed", resolvedPx: value.value };
      }
    } catch {
      // Fall through to heuristic
    }
  }

  // Fallback heuristic: check inline style and stylesheet rules
  const htmlEl = el as HTMLElement;

  // Check inline style
  if (htmlEl.style && htmlEl.style.getPropertyValue(axis)) {
    const inlineVal = htmlEl.style.getPropertyValue(axis);
    if (inlineVal && !isContentDerived(inlineVal) && !isPercentageDerived(inlineVal)) {
      return { kind: "fixed", resolvedPx: px(getComputedStyle(el).getPropertyValue(axis)) };
    }
    if (inlineVal) return null;
  }

  // Check matched CSS rules
  try {
    const rules = getMatchedCSSRules(el);
    if (rules !== null) {
      for (const rule of rules) {
        const val = rule.style.getPropertyValue(axis);
        if (val && !isContentDerived(val) && !isPercentageDerived(val)) {
          return { kind: "fixed", resolvedPx: px(getComputedStyle(el).getPropertyValue(axis)) };
        }
      }
      return null;
    }
  } catch {
    // getMatchedCSSRules may not exist or may throw for cross-origin sheets
  }

  // Last-resort heuristic: walk stylesheets
  if (hasExplicitRuleFor(el, axis)) {
    return { kind: "fixed", resolvedPx: px(getComputedStyle(el).getPropertyValue(axis)) };
  }

  return null;
}

/**
 * Walk accessible stylesheets to check if any rule explicitly sets
 * a property on the given element.
 */
function hasExplicitRuleFor(el: Element, prop: string): boolean {
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // Cross-origin stylesheet
      }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          try {
            if (el.matches(rule.selectorText)) {
              const val = rule.style.getPropertyValue(prop);
              if (val && !isContentDerived(val) && !isPercentageDerived(val)) {
                return true;
              }
            }
          } catch {
            continue; // Invalid selector
          }
        }
      }
    }
  } catch {
    // If we can't access stylesheets at all, fall through
  }
  return false;
}

/**
 * Get the specified (authored) value for a CSS property by checking
 * inline style and stylesheet rules. Returns the raw string or null.
 *
 * Unlike getComputedStyle, this returns the pre-layout authored value
 * (e.g. "68px" even if the element was resized by flex distribution).
 */
export function getSpecifiedValue(el: Element, prop: string): string | null {
  const htmlEl = el as HTMLElement;
  if (htmlEl.style) {
    const val = htmlEl.style.getPropertyValue(prop);
    if (val) return val;
  }
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          try {
            if (el.matches(rule.selectorText)) {
              const val = rule.style.getPropertyValue(prop);
              if (val) return val;
            }
          } catch {
            continue;
          }
        }
      }
    }
  } catch {
    /* cross-origin */
  }
  return null;
}

/** Shim for the deprecated getMatchedCSSRules. Returns null if unavailable. */
function getMatchedCSSRules(el: Element): CSSStyleRule[] | null {
  const win = window as Window & { getMatchedCSSRules?(el: Element): CSSStyleRule[] | null };
  if (typeof win.getMatchedCSSRules === "function") {
    try {
      const rules = win.getMatchedCSSRules(el);
      return rules ? Array.from(rules) : null;
    } catch {
      return null;
    }
  }
  return null;
}
