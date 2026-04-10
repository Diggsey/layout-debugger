/**
 * Pure utility functions — no DOM measurement, no core type dependencies.
 */

/** Parse a CSS pixel value like "123.45px" to a number. Returns 0 for non-pixel values. */
export function px(value: string): number {
  if (value.endsWith("px")) {
    return parseFloat(value);
  }
  return 0;
}

/** Check if a computed value is effectively 'auto'. */
export function isAuto(value: string): boolean {
  return value === "auto" || value === "";
}

/** Produce a short human-readable descriptor for an element, e.g. "<div.card#main>". */
export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes =
    el.classList.length > 0 ? "." + Array.from(el.classList).slice(0, 3).join(".") : "";
  const extra = el.classList.length > 3 ? "…" : "";
  return `<${tag}${id}${classes}${extra}>`;
}

/** Round a number to at most 2 decimal places. */
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Get the flex direction main axis property name ('width' or 'height'). */
export function flexMainAxisProp(direction: string, writingMode = "horizontal-tb"): "width" | "height" {
  const isVertical = writingMode === "vertical-rl" || writingMode === "vertical-lr";
  const isRow = !direction.startsWith("column");
  if (isRow) return isVertical ? "height" : "width";
  return isVertical ? "width" : "height";
}

/** Parse a space-separated list of pixel values like "200px 300px 300px" into numbers. */
export function parseTrackList(value: string): number[] {
  if (!value || value === "none") return [];
  return value
    .split(/\s+/)
    .map((v) => px(v))
    .filter((v) => !isNaN(v));
}

/**
 * Resolve a CSS length value — possibly a clamp/min/max/calc expression with
 * percentages — to a pixel number, given the reference container size for
 * percentage resolution. Returns null if the expression can't be resolved.
 */
export function resolveCssLength(val: string, containerPx: number): number | null {
  val = val.trim();
  if (val === "" || val === "auto" || val === "none") return null;
  if (val.endsWith("px")) {
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  }
  if (val.endsWith("%")) {
    const n = parseFloat(val);
    return isNaN(n) ? null : (n / 100) * containerPx;
  }
  if (val === "0") return 0;
  const fn = val.match(/^(clamp|min|max|calc)\((.*)\)$/);
  if (fn) {
    const name = fn[1];
    const body = fn[2];
    if (name === "calc") return evalCalcExpr(body, containerPx);
    const args = splitCssArgs(body).map(a => resolveCssLength(a, containerPx));
    if (args.some(a => a === null)) return null;
    const nums = args as number[];
    if (name === "clamp" && nums.length === 3) {
      return Math.max(nums[0], Math.min(nums[2], nums[1]));
    }
    if (name === "max") return Math.max(...nums);
    if (name === "min") return Math.min(...nums);
  }
  return null;
}

/**
 * Evaluate a calc() expression body. Supports +, -, *, / with px/% operands
 * and nested calc/min/max/clamp. Uses shunting-yard for precedence.
 */
function evalCalcExpr(body: string, containerPx: number): number | null {
  const tokens = tokenizeCalc(body, containerPx);
  if (!tokens) return null;
  const output: (number | string)[] = [];
  const ops: string[] = [];
  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
  for (const t of tokens) {
    if (typeof t === "number") {
      output.push(t);
    } else {
      while (ops.length > 0 && prec[ops[ops.length - 1]] >= prec[t]) {
        output.push(ops.pop()!);
      }
      ops.push(t);
    }
  }
  while (ops.length > 0) output.push(ops.pop()!);
  const stack: number[] = [];
  for (const t of output) {
    if (typeof t === "number") {
      stack.push(t);
    } else {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) return null;
      switch (t) {
        case "+": stack.push(a + b); break;
        case "-": stack.push(a - b); break;
        case "*": stack.push(a * b); break;
        case "/": stack.push(b === 0 ? 0 : a / b); break;
      }
    }
  }
  return stack.length === 1 ? stack[0] : null;
}

function tokenizeCalc(s: string, containerPx: number): (number | string)[] | null {
  const tokens: (number | string)[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "+" || c === "-" || c === "*" || c === "/") {
      if ((c === "-" || c === "+") && (tokens.length === 0 || typeof tokens[tokens.length - 1] === "string")) {
        tokens.push(0);
      }
      tokens.push(c);
      i++;
      continue;
    }
    // Function call: calc/clamp/min/max — delegate to resolveCssLength
    const fnMatch = s.slice(i).match(/^(calc|clamp|min|max)\(/);
    if (fnMatch) {
      let depth = 1;
      let j = i + fnMatch[0].length;
      while (j < s.length && depth > 0) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") depth--;
        if (depth > 0) j++;
      }
      if (depth !== 0) return null;
      const whole = s.slice(i, j + 1);
      const val = resolveCssLength(whole, containerPx);
      if (val === null) return null;
      tokens.push(val);
      i = j + 1;
      continue;
    }
    // Plain parenthesized sub-expression
    if (c === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") depth--;
        if (depth > 0) j++;
      }
      if (depth !== 0) return null;
      const inner = s.slice(i + 1, j);
      const val = evalCalcExpr(inner, containerPx);
      if (val === null) return null;
      tokens.push(val);
      i = j + 1;
      continue;
    }
    // Number literal with optional unit
    const numMatch = s.slice(i).match(/^(-?[\d.]+)(px|%)?/);
    if (numMatch) {
      const n = parseFloat(numMatch[1]);
      if (isNaN(n)) return null;
      tokens.push(numMatch[2] === "%" ? (n / 100) * containerPx : n);
      i += numMatch[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

function splitCssArgs(s: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}
