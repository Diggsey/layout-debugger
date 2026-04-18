/**
 * Positioned layout analyzer.
 */
import type { Axis, NodeKind, LayoutNode } from "../types";
import type { NodeBuilder } from "../node-builder";
import { ref, prop, measured, sub, add, cmax } from "../calc";
import { PX } from "../units";
import { isAuto } from "../utils";

export function positioned(
  nb: NodeBuilder, axis: Axis,
): void {
  const el = nb.element;
  const startProp = axis === "width" ? "left" as const : "top" as const;
  const endProp = axis === "width" ? "right" as const : "bottom" as const;
  const startVal = nb.css(startProp);
  const endVal = nb.css(endProp);

  const pos = nb.css("position");

  // An abs-pos child of a flex container with an explicit non-stretch
  // align-self sizes its block axis to content rather than using the
  // opposing offsets — Chrome treats a non-stretch alignment as suppressing
  // the offset-derived sizing. Fall through to content-sizing below.
  let suppressOffsetDerived = false;
  const layoutParent = nb.proxy.getLayoutParent();
  const parentDisplay = layoutParent.readProperty("display");
  if (parentDisplay === "flex" || parentDisplay === "inline-flex") {
    const alignSelf = nb.css("align-self");
    const nonStretch = alignSelf !== "auto" && alignSelf !== "normal" && alignSelf !== "stretch";
    if (nonStretch) {
      const wm = nb.css("writing-mode");
      const isVertical = wm === "vertical-rl" || wm === "vertical-lr"
        || wm === "sideways-rl" || wm === "sideways-lr";
      const blockAxis: Axis = isVertical ? "width" : "height";
      if (axis === blockAxis) suppressOffsetDerived = true;
    }
  }

  if (!suppressOffsetDerived && !isAuto(startVal) && !isAuto(endVal)) {
    // For fixed elements, getContainingBlock returns the viewport (documentElement)
    // UNLESS a transform/filter/contain ancestor creates an intermediate CB.
    const cb = nb.proxy.getContainingBlock();
    let cbNode: LayoutNode;
    const cbElement = cb.element;
    if (pos === "fixed" && cbElement === document.documentElement) {
      // True viewport — use window dimensions (html element size may differ)
      const vpSize = axis === "width" ? window.innerWidth : window.innerHeight;
      cbNode = nb.create(`measured:${axis}`, cbElement, (n) => {
        n.setMode("viewport")
          .describe("Size of the browser viewport")
          .calc(measured("viewport", vpSize, PX));
      });
    } else {
      cbNode = nb.computeSize(cbElement, axis);
    }
    const cbBorderProps = axis === "width"
      ? ["border-left-width", "border-right-width"] as const
      : ["border-top-width", "border-bottom-width"] as const;

    const cbPaddingBoxKind: NodeKind = `padding-area:${axis}`;
    const cbPaddingBox = nb.create(cbPaddingBoxKind, cbElement, (cnb) => {
      cnb.setMode("content-area")
        .describe("Containing block padding box (for positioned descendants)")
        .calc(sub(ref(cbNode), add(...cbBorderProps.map(p => prop(cnb.proxy, p)))))
        .input("borderBox", cbNode);
    });

    const [mStartName, mEndName] = axis === "width"
      ? ["margin-left", "margin-right"] as const : ["margin-top", "margin-bottom"] as const;
    const pbProps = axis === "width"
      ? ["padding-left", "padding-right", "border-left-width", "border-right-width"] as const
      : ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"] as const;
    const spacing = add(
      nb.prop(startProp), nb.prop(endProp),
      nb.prop(mStartName), nb.prop(mEndName),
    );
    nb.describe(`Absolutely positioned \u2014 ${axis} derived from opposing offsets`)
      .calc(cmax(add(...pbProps.map(p => nb.prop(p))), sub(ref(cbPaddingBox), spacing)))
      .input("containingBlock", cbNode);
    return;
  }

  const contentNode = nb.computeIntrinsicSize(el, axis);
  nb.describe(`Absolutely positioned \u2014 ${axis} shrinks to fit content`)
    .calc(ref(contentNode))
    .input("content", contentNode);
}
