/**
 * DAG Layout Algorithm — pure function, no DOM dependency.
 *
 * Input:  A DAG as an array of { id, children } nodes.
 *         First child = main-line continuation; rest = side branches.
 * Output: A layout that can be rendered to ASCII or SVG.
 *
 * The layout uses a rail-based system (like git log):
 * - Each node occupies a column and row
 * - Vertical rails connect parent→child
 * - Branches curve right (\), merges curve into target column
 * - Grid uses step_x=5, step_y=4 between node centers
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DagInput {
  id: string;
  children: string[];
}

export interface LayoutResult {
  /** Nodes in display order (topological). */
  order: string[];
  /** Column assigned to each node. */
  columns: Map<string, number>;
  /** Row index for each node. */
  rows: Map<string, number>;
  /** Visual edges to draw. */
  edges: VisualEdge[];
  /** Total columns used. */
  numCols: number;
}

export interface VisualEdge {
  fromId: string;
  toId: string;
  /** Column the edge originates from (source node's column). */
  fromCol: number;
  /** Column the edge arrives at (target node's column). */
  toCol: number;
  type: "main" | "branch" | "merge";
}

// ---------------------------------------------------------------------------
// Layout algorithm
// ---------------------------------------------------------------------------

export function layoutDag(nodes: DagInput[]): LayoutResult {
  const nodeMap = new Map<string, DagInput>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // Build parent map
  const parents = new Map<string, string[]>();
  for (const n of nodes) {
    for (const c of n.children) {
      if (!parents.has(c)) parents.set(c, []);
      parents.get(c)!.push(n.id);
    }
  }

  const order = topoSort(nodes, nodeMap, parents);
  return assignColumns(order, nodeMap);
}

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

/**
 * Topological sort with side-branch-first ordering.
 *
 * For each node, side branches (children[1..]) are placed before the
 * main-line child (children[0]). Among side branches, rightmost first.
 * A node is only placed when ALL its parents have been placed.
 */
function topoSort(
  nodes: DagInput[],
  nodeMap: Map<string, DagInput>,
  parents: Map<string, string[]>,
): string[] {
  const remaining = new Map<string, number>();
  for (const n of nodes) {
    const pars = parents.get(n.id);
    remaining.set(n.id, pars ? pars.length : 0);
  }

  const order: string[] = [];
  const placed = new Set<string>();
  const stack: string[] = [];

  // Seed with roots (no parents)
  for (const n of nodes) {
    if (remaining.get(n.id) === 0) stack.push(n.id);
  }

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (placed.has(id)) continue;
    if (remaining.get(id)! > 0) continue;

    placed.add(id);
    order.push(id);

    const node = nodeMap.get(id)!;
    const children = node.children.filter(c => nodeMap.has(c));

    // Decrement remaining parent count for all children
    for (const c of children) {
      remaining.set(c, remaining.get(c)! - 1);
    }

    // Push onto stack: main child first (bottom), then side branches.
    // Side branches pushed in order so rightmost is on top (popped first).
    if (children.length > 0) {
      stack.push(children[0]); // main child — placed last
    }
    for (let i = 1; i < children.length; i++) {
      stack.push(children[i]); // side branches — rightmost placed first
    }
  }

  return order;
}

// ---------------------------------------------------------------------------
// Column assignment (rail-based)
// ---------------------------------------------------------------------------

interface Rail {
  targetId: string;
  col: number;
}

function assignColumns(
  order: string[],
  nodeMap: Map<string, DagInput>,
): LayoutResult {
  const columns = new Map<string, number>();
  const rows = new Map<string, number>();
  const edges: VisualEdge[] = [];
  let rails: Rail[] = [];

  for (let row = 0; row < order.length; row++) {
    const id = order[row];
    rows.set(id, row);

    // Find and consume arriving rails
    const arriving = rails.filter(r => r.targetId === id);
    rails = rails.filter(r => r.targetId !== id);

    // Determine this node's column
    let col: number;
    if (arriving.length > 0) {
      col = arriving[0].col;
    } else {
      col = allocFreeCol(rails);
    }
    columns.set(id, col);

    // Spawn new rails and record edges
    const node = nodeMap.get(id)!;
    const children = node.children.filter(c => nodeMap.has(c));

    for (let i = 0; i < children.length; i++) {
      const childId = children[i];
      const existingRail = rails.find(r => r.targetId === childId);

      if (existingRail) {
        // Rail already exists — this edge becomes a merge
        edges.push({
          fromId: id, toId: childId,
          fromCol: col, toCol: -1, // filled in when child is placed
          type: "merge",
        });
      } else if (i === 0) {
        // Main child: inherit this column
        rails.push({ targetId: childId, col });
        edges.push({
          fromId: id, toId: childId,
          fromCol: col, toCol: col,
          type: "main",
        });
      } else {
        // Side branch: allocate column to the right
        const branchCol = allocBranchCol(col, rails);
        rails.push({ targetId: childId, col: branchCol });
        edges.push({
          fromId: id, toId: childId,
          fromCol: col, toCol: branchCol,
          type: "branch",
        });
      }
    }
  }

  // Fix up merge edge toCol values (now that all nodes are placed)
  for (const e of edges) {
    if (e.toCol === -1) {
      e.toCol = columns.get(e.toId)!;
    }
  }

  const allCols = Array.from(columns.values());
  const numCols = allCols.length > 0 ? Math.max(...allCols) + 1 : 0;

  return { order, columns, rows, edges, numCols };
}

function allocFreeCol(rails: Rail[]): number {
  const occupied = new Set(rails.map(r => r.col));
  for (let c = 0; ; c++) if (!occupied.has(c)) return c;
}

function allocBranchCol(nodeCol: number, rails: Rail[]): number {
  let max = nodeCol;
  for (const r of rails) if (r.col > max) max = r.col;
  return max + 1;
}

// ---------------------------------------------------------------------------
// ASCII rendering
// ---------------------------------------------------------------------------

const STEP_X = 5;
const STEP_Y = 4;

/**
 * Render a DAG as ASCII art.
 *
 * Characters:
 * - `@` = node dot
 * - `|` = vertical edge
 * - `-` = horizontal edge segment
 * - `\` = curve going down-right
 * - `/` = curve going down-left
 */
export function renderAscii(nodes: DagInput[]): string {
  const layout = layoutDag(nodes);
  const { order, columns, rows, edges, numCols } = layout;

  if (order.length === 0) return "";

  const numRows = order.length;
  const gridW = (numCols - 1) * STEP_X + 5;
  const gridH = (numRows - 1) * STEP_Y + 1;

  // Initialize grid with spaces
  const grid: string[][] = [];
  for (let y = 0; y < gridH; y++) {
    grid.push(Array.from({ length: gridW }, () => " "));
  }

  function cx(col: number): number { return col * STEP_X + 2; }
  function cy(row: number): number { return row * STEP_Y; }

  function set(x: number, y: number, ch: string): void {
    if (y >= 0 && y < gridH && x >= 0 && x < gridW) {
      grid[y][x] = ch;
    }
  }

  // Phase 1: Draw vertical segments
  for (const edge of edges) {
    const sy = cy(rows.get(edge.fromId)!);
    const ty = cy(rows.get(edge.toId)!);

    if (edge.type === "main") {
      // Straight vertical from source to target
      const x = cx(edge.fromCol);
      for (let y = sy + 1; y < ty; y++) set(x, y, "|");
    } else if (edge.type === "branch") {
      // Vertical segment below the branch diagonal, at the target column
      const x = cx(edge.toCol);
      // Branch diagonal occupies sy+1, sy+2, sy+3. Vertical from sy+4 to ty-1.
      for (let y = sy + 4; y < ty; y++) set(x, y, "|");
    } else if (edge.type === "merge") {
      // Vertical segment at source column, from source down to merge diagonal
      const x = cx(edge.fromCol);
      // Merge diagonal occupies ty-3, ty-2, ty-1. Vertical from sy+1 to ty-4.
      for (let y = sy + 1; y <= ty - 4; y++) set(x, y, "|");
    }
  }

  // Phase 2: Draw diagonals (can overwrite verticals at crossings)
  for (const edge of edges) {
    const sy = cy(rows.get(edge.fromId)!);
    const ty = cy(rows.get(edge.toId)!);
    const sx = cx(edge.fromCol);
    const tx = cx(edge.toCol);

    if (edge.type === "branch") {
      // Branch diagonal just below source
      set(sx + 1, sy + 1, "\\");
      for (let x = sx + 2; x <= tx - 2; x++) set(x, sy + 2, "-");
      if (tx > sx) set(tx - 1, sy + 3, "\\");
    } else if (edge.type === "merge" && edge.fromCol < edge.toCol) {
      // Merge diagonal just above target (going right)
      set(sx + 1, ty - 3, "\\");
      for (let x = sx + 2; x <= tx - 2; x++) set(x, ty - 2, "-");
      if (tx > sx) set(tx - 1, ty - 1, "\\");
    } else if (edge.type === "merge" && edge.fromCol > edge.toCol) {
      // Merge diagonal going left (use /)
      set(sx - 1, ty - 3, "/");
      for (let x = tx + 2; x <= sx - 2; x++) set(x, ty - 2, "-");
      if (tx < sx) set(tx + 1, ty - 1, "/");
    }
  }

  // Phase 3: Draw node dots
  for (const id of order) {
    set(cx(columns.get(id)!), cy(rows.get(id)!), "@");
  }

  // Build output with labels at a fixed column (gridW) after the grid
  const lines: string[] = [];
  for (let y = 0; y < gridH; y++) {
    let line = grid[y].join("");
    for (const id of order) {
      if (cy(rows.get(id)!) === y) {
        line += id;
        break;
      }
    }
    lines.push(line);
  }

  // Trim trailing empty lines and trailing whitespace per line
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.map(l => l.replace(/\s+$/, "")).join("\n");
}
