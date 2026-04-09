/**
 * Positioned layout analyzer.
 */
import type { Axis, NodeKind, LayoutNode, NodeBuilder } from "../dag";
import { ref, prop, measured, sub, add, cmax } from "../dag";
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

  if (!isAuto(startVal) && !isAuto(endVal)) {
    // For fixed position, the containing block is the viewport (initial containing block),
    // not the html element. Use window dimensions directly.
    let cbNode: LayoutNode;
    let cbElement: Element;
    if (pos === "fixed") {
      cbElement = document.documentElement;
      const vpSize = axis === "width" ? window.innerWidth : window.innerHeight;
      cbNode = nb.create(`measured:${axis}`, cbElement, (n) => {
        n.setMode("viewport")
          .describe("Size of the browser viewport")
          .calc(measured("viewport", vpSize, PX));
      });
    } else {
      const cb = nb.proxy.getContainingBlock();
      cbElement = cb.element;
      cbNode = nb.computeSize(cbElement, axis);
    }
    const cbBorderProps = axis === "width"
      ? ["border-left-width", "border-right-width"] as const
      : ["border-top-width", "border-bottom-width"] as const;

    const cbPaddingBoxKind: NodeKind = `content-area:${axis}`;
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
