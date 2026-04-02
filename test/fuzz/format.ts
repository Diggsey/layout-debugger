/**
 * JSON format for describing HTML element hierarchies with CSS styles.
 * Used by the fuzz generator and corpus regression tests.
 */

export interface LayoutSpec {
  /** HTML tag name. Defaults to "div". */
  tag?: string;
  /** Inline CSS properties. */
  style?: Record<string, string>;
  /** Text content (for leaf nodes). */
  text?: string;
  /** Child elements. */
  children?: LayoutSpec[];
  /** If true, this is the element buildDag will analyze. One per tree. */
  target?: boolean;
}

export interface GenerateOpts {
  /** Maximum number of elements in the tree. Default 10. */
  maxElements?: number;
  /** Maximum nesting depth. Default 3. */
  maxDepth?: number;
}
