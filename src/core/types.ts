export type LayoutMode =
  | "block"
  | "flex"
  | "grid"
  | "inline"
  | "inline-block"
  | "table-cell"
  | "positioned";

/** The layout context an element participates in. */
export interface LayoutContext {
  /** Which layout algorithm governs this element's sizing. */
  mode: LayoutMode;
  /** The element's direct parent. */
  parent: Element;
  /** The computed display value of the parent. */
  parentDisplay: string;
  /** The element forming the containing block. */
  containingBlock: Element;
  /** The size of the containing block's content area. */
  containingBlockSize: { width: number; height: number };
  /** The element's own computed position value. */
  position: string;
  /** The element's own computed display value. */
  display: string;
  /** The element's computed float value ('none', 'left', 'right'). */
  float: string;
  /** Which physical axis is the inline (flow) axis. */
  inlineAxis: "width" | "height";
  /** Which physical axis is the block (stacking) axis. */
  blockAxis: "width" | "height";
}