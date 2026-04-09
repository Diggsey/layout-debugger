/**
 * DagBuilder — node cache with deduplication.
 *
 * One node per (NodeKind, Element) pair. The create() method handles
 * caching, cycle detection, and NodeBuilder lifecycle.
 */
import type { NodeKind, LayoutNode } from "./types";
import { NodeBuilder } from "./node-builder";

export class CycleError extends Error {
  constructor(public kind: NodeKind, public element: Element) {
    super(`Cycle detected for ${kind}`);
  }
}

type NodeKey = `${number}:${NodeKind}`;

export class DagBuilder {
  private nodes = new Map<NodeKey, LayoutNode>();
  private building = new Set<NodeKey>();
  private elIds = new WeakMap<Element, number>();
  private nextElId = 0;

  /**
   * The single node creation path. Returns cached node if it exists,
   * otherwise calls cb to build it.
   *
   * cb receives a NodeBuilder to populate (describe, calc, inputs, etc.)
   * and returns nothing. The node is finished automatically after cb returns.
   */
  create(kind: NodeKind, element: Element, depth: number, cb: (nb: NodeBuilder) => void): LayoutNode {
    const key = this.key(kind, element);
    const cached = this.nodes.get(key);
    if (cached) return cached;

    if (this.building.has(key)) {
      throw new CycleError(kind, element);
    }
    this.building.add(key);
    const nb = new NodeBuilder(this, kind, element, depth);
    try {
      cb(nb);
      return nb._finish();
    } catch (e) {
      this.building.delete(key);
      throw e;
    }
  }

  /** Check if a node is currently being built (cycle detection). */
  isBuilding(kind: NodeKind, element: Element): boolean {
    return this.building.has(this.key(kind, element));
  }

  /** Register a completed node (called by NodeBuilder._finish). */
  _register(kind: NodeKind, node: LayoutNode): void {
    const key = this.key(node.kind, node.element);
    this.building.delete(key);
    this.nodes.set(key, node);
  }

  private elementId(element: Element): number {
    let id = this.elIds.get(element);
    if (id === undefined) {
      id = this.nextElId++;
      this.elIds.set(element, id);
    }
    return id;
  }

  private key(kind: NodeKind, element: Element): NodeKey {
    return `${this.elementId(element)}:${kind}`;
  }
}
