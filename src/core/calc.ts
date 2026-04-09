/**
 * CalcExpr builder functions and evaluation.
 *
 * CalcExprs represent the computation tree for layout values.
 * Each node carries a unit (px, unitless, etc.) computed at construction time.
 */
import type { CalcExpr, LayoutNode } from "./types";
import type { CssPropertyName } from "./element-proxy";
import { type Units, UNITLESS, PX, unitsMul, unitsDiv, unitsAssertEqual } from "./units";
import { ElementProxy } from "./element-proxy";

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Evaluate a CalcExpr tree to produce a number. */
export function evaluate(expr: CalcExpr): number {
  switch (expr.op) {
    case "ref": return expr.node.result;
    case "constant": return expr.value;
    case "property": return expr.value;
    case "measured": return expr.value;
    case "add": return expr.args.reduce((s, a) => s + evaluate(a), 0);
    case "sub": return evaluate(expr.left) - evaluate(expr.right);
    case "mul": return evaluate(expr.left) * evaluate(expr.right);
    case "div": {
      const d = evaluate(expr.right);
      return d === 0 ? 0 : evaluate(expr.left) / d;
    }
    case "max": return Math.max(...expr.args.map(evaluate));
    case "min": return Math.min(...expr.args.map(evaluate));
  }
}

/** Get the unit of a CalcExpr (already computed at construction). */
export function calcUnit(expr: CalcExpr): Units {
  return expr.unit;
}

// ---------------------------------------------------------------------------
// Builder helpers — each computes and stores the unit at construction time
// ---------------------------------------------------------------------------

type LiteralNumber<T extends number> = number extends T ? never : T;

export function ref(node: LayoutNode): CalcExpr {
  return { op: "ref", node, unit: calcUnit(node.calc) };
}

export function constant<T extends number>(n: LiteralNumber<T>, unit: Units = UNITLESS): CalcExpr {
  return { op: "constant", value: n, unit };
}

/** Properties whose computed values are unitless numbers (not lengths). */
const UNITLESS_PROPS = new Set<CssPropertyName>([
  "flex-grow", "flex-shrink", "aspect-ratio",
]);

/** Create a CalcExpr property node by reading a CSS property via an ElementProxy. */
export function prop(proxy: ElementProxy, name: CssPropertyName): CalcExpr {
  const raw = proxy.readProperty(name);
  let value: number;
  let unit: Units;
  if (raw.endsWith("px")) {
    value = parseFloat(raw);
    unit = PX;
  } else if (raw.endsWith("%")) {
    // Percentage that didn't resolve to px (indefinite containing block).
    // Use PX unit with the raw numeric value to prevent unit mismatches;
    // the actual result will be computed correctly by the algorithm.
    value = parseFloat(raw) || 0;
    unit = PX;
  } else if (raw.includes("/")) {
    const parts = raw.split("/").map(s => parseFloat(s.trim()));
    value = parts.length === 2 && parts[1] !== 0 ? parts[0] / parts[1] : parseFloat(raw) || 0;
    unit = UNITLESS;
  } else if (UNITLESS_PROPS.has(name)) {
    value = parseFloat(raw) || 0;
    unit = UNITLESS;
  } else {
    // Dimension properties: "0", "normal", "auto", "none" all resolve to 0px
    value = parseFloat(raw) || 0;
    unit = PX;
  }
  return { op: "property", name, value, unit };
}

/** Create a property CalcExpr with an explicit value (when computed style returns the wrong value). */
export function propVal(name: CssPropertyName, value: number, unit: Units = PX): CalcExpr {
  return { op: "property", name, value, unit };
}

export function measured(label: string, value: number, unit: Units = PX): CalcExpr {
  return { op: "measured", label, value, unit };
}

export function add(...args: CalcExpr[]): CalcExpr {
  if (args.length === 0) return { op: "add", args, unit: UNITLESS };
  const unit = args[0].unit;
  for (let i = 1; i < args.length; i++) {
    unitsAssertEqual(unit, args[i].unit, "add");
  }
  return { op: "add", args, unit };
}

export function sub(left: CalcExpr, right: CalcExpr): CalcExpr {
  unitsAssertEqual(left.unit, right.unit, "sub");
  return { op: "sub", left, right, unit: left.unit };
}

export function mul(left: CalcExpr, right: CalcExpr): CalcExpr {
  return { op: "mul", left, right, unit: unitsMul(left.unit, right.unit) };
}

export function div(left: CalcExpr, right: CalcExpr): CalcExpr {
  return { op: "div", left, right, unit: unitsDiv(left.unit, right.unit) };
}

export function cmax(...args: CalcExpr[]): CalcExpr {
  if (args.length === 0) return { op: "max", args, unit: UNITLESS };
  const unit = args[0].unit;
  for (let i = 1; i < args.length; i++) {
    unitsAssertEqual(unit, args[i].unit, "max");
  }
  return { op: "max", args, unit };
}

export function cmin(...args: CalcExpr[]): CalcExpr {
  if (args.length === 0) return { op: "min", args, unit: UNITLESS };
  const unit = args[0].unit;
  for (let i = 1; i < args.length; i++) {
    unitsAssertEqual(unit, args[i].unit, "min");
  }
  return { op: "min", args, unit };
}
