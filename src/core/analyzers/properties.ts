/**
 * Check if an element has an intrinsic sizing keyword (min-content, max-content,
 * fit-content) as a specified value for a given CSS property.
 */
export function getSpecifiedIntrinsicKeyword(
  el: Element,
  prop: string,
): string | null {
  const htmlEl = el as HTMLElement;
  if (htmlEl.style) {
    const val = htmlEl.style.getPropertyValue(prop);
    if (val && isIntrinsicKeyword(val)) return val;
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
              if (val && isIntrinsicKeyword(val)) return val;
            }
          } catch {
            continue;
          }
        }
      }
    }
  } catch {
    /* cross-origin sheets */
  }

  return null;
}

function isIntrinsicKeyword(val: string): boolean {
  return (
    val === "min-content" ||
    val === "max-content" ||
    val === "fit-content" ||
    val.startsWith("fit-content(")
  );
}
