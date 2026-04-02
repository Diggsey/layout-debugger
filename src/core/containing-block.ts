/**
 * Containing block identification.
 *
 * Spec references:
 * - CSS2 §10.1  Definition of "containing block"
 *   https://www.w3.org/TR/CSS2/visudet.html#containing-block-details
 *
 * - CSS Transforms 1 §6  Containing blocks formed by transforms
 *   https://www.w3.org/TR/css-transforms-1/#containing-block-for-all-descendants
 *
 * - CSS Containment 2 §3  Contain property
 *   https://www.w3.org/TR/css-contain-2/#contain-property
 *   "An element with contain: paint/layout establishes a containing block
 *   for absolutely/fixed positioned descendants."
 */

/**
 * Does this element create a containing block for abs/fixed descendants?
 *
 * CSS2 §10.1: position != static creates a CB for abs positioned descendants.
 * CSS Transforms §6: transform/filter/perspective also creates one.
 * CSS Will Change §3: will-change of transform/filter/perspective too.
 * CSS Containment §3: contain: paint/layout/strict/content also applies.
 */
function createsContainingBlock(el: Element): boolean {
  const s = getComputedStyle(el);
  if (s.position !== "static") return true;
  if (s.transform !== "none") return true;
  if (s.filter !== "none") return true;
  if (s.perspective !== "none") return true;

  const wc = s.willChange;
  if (wc === "transform" || wc === "filter" || wc === "perspective") return true;

  const contain = s.contain;
  if (
    contain &&
    (contain.includes("paint") ||
      contain.includes("layout") ||
      contain.includes("strict") ||
      contain.includes("content"))
  )
    return true;

  return false;
}

/**
 * Find the containing block for an element per the CSS spec.
 *
 * CSS2 §10.1:
 * - position: static/relative → nearest block container ancestor
 *   (CSS2 §9.4.1: a block container is anything not inline/contents)
 * - position: absolute → nearest positioned ancestor (or ICB)
 * - position: fixed → viewport (document.documentElement), unless an
 *   ancestor creates a CB via transform/filter/contain
 */
export function findContainingBlock(el: Element): Element {
  const position = getComputedStyle(el).position;
  let ancestor = el.parentElement;

  if (position === "fixed") {
    while (ancestor && ancestor !== document.documentElement) {
      if (createsContainingBlock(ancestor)) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return document.documentElement;
  }

  if (position === "absolute") {
    while (ancestor && ancestor !== document.documentElement) {
      if (createsContainingBlock(ancestor)) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return document.documentElement;
  }

  // Static or relative: nearest block container ancestor
  while (ancestor && ancestor !== document.documentElement) {
    const d = getComputedStyle(ancestor).display;
    if (d !== "inline" && d !== "contents") {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }

  return document.documentElement;
}

/**
 * Get the size of the containing block's relevant box.
 *
 * CSS2 §10.1:
 * - For abs/fixed positioning: the containing block is the padding box
 *   of the positioned ancestor (border-box minus borders)
 * - For static/relative: the containing block is the content box
 *   (border-box minus padding and borders)
 */
export function getContainingBlockSize(
  cb: Element,
  position: string,
): { width: number; height: number } {
  const rect = cb.getBoundingClientRect();
  const s = getComputedStyle(cb);

  if (position === "absolute" || position === "fixed") {
    const bw = parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth);
    const bh = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth);
    return {
      width: rect.width - bw,
      height: rect.height - bh,
    };
  }

  const pw = parseFloat(s.paddingLeft) + parseFloat(s.paddingRight);
  const ph = parseFloat(s.paddingTop) + parseFloat(s.paddingBottom);
  const bw = parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth);
  const bh = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth);
  return {
    width: rect.width - pw - bw,
    height: rect.height - ph - bh,
  };
}
