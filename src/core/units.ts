/**
 * Dimensional unit tracking for CalcExpr values.
 *
 * Units are represented as a map of base unit → exponent, e.g.:
 *   { px: 1 }  — a length (px)
 *   {}          — unitless (a pure number)
 *   { px: 2 }  — an area (px²)
 *   { px: -1 } — inverse length (1/px)
 *
 * This representation naturally handles unit arithmetic:
 *   px × px = px²     (add exponents)
 *   px / px = unitless (subtract exponents → all zero → empty)
 *   px × unitless = px (merge with empty)
 */

/** The set of base unit names supported by the system. */
export type BaseUnit = "px";

/** A dimensional unit as a map of base unit names to their exponents. */
export type Units = Readonly<Partial<Record<BaseUnit, number>>>;

/** The unitless (dimensionless) unit. */
export const UNITLESS: Units = Object.freeze({});

/** A single px dimension. */
export const PX: Units = Object.freeze({ px: 1 });

/** Check if two Units are equal. */
export function unitsEqual(a: Units, b: Units): boolean {
  const keysA = Object.keys(a) as BaseUnit[];
  const keysB = Object.keys(b) as BaseUnit[];
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** Multiply units: adds exponents. px × px = px². */
export function unitsMul(a: Units, b: Units): Units {
  const result: Partial<Record<BaseUnit, number>> = { ...a };
  for (const k of Object.keys(b) as BaseUnit[]) {
    result[k] = (result[k] ?? 0) + b[k]!;
    if (result[k] === 0) delete result[k];
  }
  return result;
}

/** Divide units: subtracts exponents. px / px = unitless. */
export function unitsDiv(a: Units, b: Units): Units {
  const result: Partial<Record<BaseUnit, number>> = { ...a };
  for (const k of Object.keys(b) as BaseUnit[]) {
    result[k] = (result[k] ?? 0) - b[k]!;
    if (result[k] === 0) delete result[k];
  }
  return result;
}

/**
 * Assert that two Units are equal for additive operations.
 * Throws a descriptive error on mismatch.
 */
export function unitsAssertEqual(a: Units, b: Units, context: string): void {
  if (!unitsEqual(a, b)) {
    throw new Error(`Unit mismatch in ${context}: ${formatUnits(a)} vs ${formatUnits(b)}`);
  }
}

/** Format units for display: "px", "", "px²", etc. */
export function formatUnits(u: Units): string {
  const parts: string[] = [];
  for (const name of Object.keys(u) as BaseUnit[]) {
    const exp = u[name]!;
    if (exp === 1) parts.push(name);
    else if (exp !== 0) parts.push(`${name}${toSuperscript(exp)}`);
  }
  return parts.join("·") || "";
}

function toSuperscript(n: number): string {
  const map: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻" };
  return String(n).split("").map(c => map[c] ?? c).join("");
}
