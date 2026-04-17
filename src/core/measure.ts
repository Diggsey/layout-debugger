/* eslint-disable eslint-js/no-restricted-syntax -- Authorized measurement utilities */

/**
 * DOM measurement utilities.
 *
 * These are the authorized paths for reading element sizes via getBoundingClientRect.
 * Core layout code should call these functions rather than using getBoundingClientRect directly.
 */

/** Measure an element's border-box size on the given axis. */
export function measureElementSize(el: Element, axis: "width" | "height"): number {
  return el.getBoundingClientRect()[axis];
}

/**
 * Measure the min-content size of an element on a given axis.
 * Clones the element with `width/height: min-content` and measures it.
 * The clone is inserted as a sibling of the original so it inherits the same
 * font-size, writing-mode, and other inherited properties.
 */
export function measureMinContentSize(el: Element, axis: "width" | "height"): number {
  const clone = el.cloneNode(true) as HTMLElement;
  const crossAxis = axis === "width" ? "height" : "width";
  // For the inline axis (width in horizontal writing modes), min-content is
  // the usual "shrunk to longest word" measurement. For the block axis
  // (height), min-content should reflect the element's natural size at its
  // current cross size — otherwise text measured with auto width will flow
  // as a single line, giving an unrealistically small min-content height.
  const crossBorderBox = el.getBoundingClientRect()[crossAxis];
  clone.style.cssText += "; " + [
    "position: absolute !important",
    "visibility: hidden !important",
    "pointer-events: none !important",
    `${axis}: min-content !important`,
    "box-sizing: border-box !important",
    `${crossAxis}: ${crossBorderBox}px !important`,
    "flex: none !important",
    "min-width: 0 !important",
    "min-height: 0 !important",
    "max-width: none !important",
    "max-height: none !important",
  ].join("; ");
  const host = el.parentElement ?? document.body;
  host.appendChild(clone);
  const value = clone.getBoundingClientRect()[axis];
  clone.remove();
  return value;
}

/**
 * Measure the intrinsic (content-based) size of an element on a given axis.
 * Clones the element with the target axis set to `auto` and inserts it as a
 * sibling so it inherits the same font/writing-mode context. Min/max
 * constraints are reset on the clone because the clone is positioned absolute
 * and its CB for percentage resolution differs from the original's.
 */
export function measureIntrinsicSize(el: Element, axis: "width" | "height", ignoreAspectRatio = false): number {
  const clone = el.cloneNode(true) as HTMLElement;
  const baseRules = [
    "position: absolute !important",
    "visibility: hidden !important",
    "pointer-events: none !important",
    `${axis}: auto !important`,
    "align-self: flex-start !important",
    "flex: none !important",
    "min-width: 0 !important",
    "min-height: 0 !important",
    "max-width: none !important",
    "max-height: none !important",
  ];
  if (ignoreAspectRatio) baseRules.push("aspect-ratio: auto !important");
  clone.style.cssText += "; " + baseRules.join("; ");

  // The cross axis is left at whatever the original authored value is — this
  // preserves aspect-ratio transfer in the clone with the correct box-sizing.
  // For cases where the original's cross-axis size comes from flex or block
  // layout (not an explicit value), the clone's positioned-absolute context
  // will shrink-to-fit, which may differ from the original, but it's better
  // than forcing a border-box value and breaking the aspect-ratio math.
  const host = el.parentElement ?? document.body;
  host.appendChild(clone);
  const size = clone.getBoundingClientRect()[axis];
  clone.remove();
  return size;
}

/**
 * Measure the content-based size used for flex-basis: auto fallthrough
 * (CSS Flexbox §9.2 step 3E). Unlike measureIntrinsicSize (which gives
 * unconstrained max-content), this preserves cross-axis min/max so the
 * measurement reflects the item's actual used cross size — which is what
 * the browser uses when computing the basis at this step.
 *
 * Only the main-axis min/max are stripped; the main-axis size is set to
 * auto so content determines the extent.
 */
export function measureFlexBasisContent(el: Element, axis: "width" | "height"): number {
  const clone = el.cloneNode(true) as HTMLElement;
  const mainMin = axis === "width" ? "min-width" : "min-height";
  const mainMax = axis === "width" ? "max-width" : "max-height";
  const baseRules = [
    "position: absolute !important",
    "visibility: hidden !important",
    "pointer-events: none !important",
    `${axis}: auto !important`,
    "align-self: flex-start !important",
    "flex: none !important",
    `${mainMin}: 0 !important`,
    `${mainMax}: none !important`,
  ];
  clone.style.cssText += "; " + baseRules.join("; ");
  const host = el.parentElement ?? document.body;
  host.appendChild(clone);
  const size = clone.getBoundingClientRect()[axis];
  clone.remove();
  return size;
}
