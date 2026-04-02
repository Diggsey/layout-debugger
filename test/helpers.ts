import { Page, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Serializable version of TraceStep (Element → string descriptor). */
export interface SerializedStep {
  elementDesc: string;
  summary: string;
  details: Record<string, string>;
  substeps?: SerializedStep[];
}

export interface SerializedResult {
  borderBoxWidth: number;
  borderBoxHeight: number;
  steps: SerializedStep[];
}

/** Load a fixture HTML file in the given page. */
export async function loadFixture(page: Page, name: string): Promise<void> {
  const filePath = path.resolve(__dirname, 'fixtures', name);
  await page.goto(`file://${filePath}`);
  await page.waitForFunction(() => typeof (window as any).whyThisSize === 'function');
}

/**
 * Run whyThisSize on an element selected by data-testid and return
 * a serialized result that can be asserted on from Node.
 */
export async function analyzeElement(page: Page, testId: string): Promise<SerializedResult> {
  return page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (!el) throw new Error(`Element with data-testid="${tid}" not found`);

    const result = (window as any).whyThisSize(el);

    function describeEl(e: Element): string {
      const tid = e.getAttribute('data-testid');
      if (tid) return `[${tid}]`;
      const tag = e.tagName.toLowerCase();
      const id = e.id ? `#${e.id}` : '';
      const cls = e.classList.length > 0 ? '.' + Array.from(e.classList).join('.') : '';
      return `<${tag}${id}${cls}>`;
    }

    function serializeStep(step: any): any {
      return {
        elementDesc: describeEl(step.element),
        summary: step.summary,
        details: step.details,
        substeps: step.substeps?.map(serializeStep),
      };
    }

    return {
      borderBoxWidth: result.borderBoxWidth,
      borderBoxHeight: result.borderBoxHeight,
      steps: result.steps.map(serializeStep),
    };
  }, testId);
}

// ---------------------------------------------------------------------------
// Step matching
// ---------------------------------------------------------------------------

/**
 * A declarative matcher for a single step in the trace.
 *
 * - element:    exact data-testid string, e.g. "[container]"
 * - summary:    regex the summary must match
 * - details:    optional map of key → exact value to assert in details
 * - substeps:   optional recursive list of matchers for substeps
 * - noSubsteps: if true, asserts substeps is undefined
 */
export interface StepMatcher {
  element: string;
  summary: RegExp;
  /** Assert summary does NOT match this pattern. */
  summaryNot?: RegExp;
  /** Assert exact detail values. */
  details?: Record<string, string>;
  /** Assert detail values match regex patterns. */
  detailsMatch?: Record<string, RegExp>;
  substeps?: StepMatcher[];
  noSubsteps?: boolean;
}

function formatStep(step: SerializedStep, indent = 0): string {
  const pad = '  '.repeat(indent);
  let s = `${pad}${step.elementDesc} ${step.summary}\n`;
  if (step.substeps) {
    for (const sub of step.substeps) s += formatStep(sub, indent + 1);
  }
  return s;
}

function formatResult(result: SerializedResult): string {
  return result.steps.map((s) => formatStep(s)).join('');
}

function matchStep(actual: SerializedStep, matcher: StepMatcher, path: string): void {
  expect(actual.elementDesc, `${path}.element`).toBe(matcher.element);
  expect(actual.summary, `${path}.summary`).toMatch(matcher.summary);

  if (matcher.summaryNot) {
    expect(actual.summary, `${path}.summary should NOT match ${matcher.summaryNot}`).not.toMatch(matcher.summaryNot);
  }

  if (matcher.details) {
    for (const [key, value] of Object.entries(matcher.details)) {
      expect(actual.details[key], `${path}.details["${key}"]`).toBe(value);
    }
  }

  if (matcher.detailsMatch) {
    for (const [key, pattern] of Object.entries(matcher.detailsMatch)) {
      expect(actual.details[key], `${path}.details["${key}"] should exist`).toBeDefined();
      expect(actual.details[key], `${path}.details["${key}"]`).toMatch(pattern);
    }
  }

  if (matcher.noSubsteps) {
    expect(actual.substeps, `${path} should have no substeps`).toBeUndefined();
  }

  if (matcher.substeps) {
    expect(actual.substeps, `${path} should have substeps`).toBeDefined();
    expect(actual.substeps!.length, `${path}.substeps.length`).toBe(matcher.substeps.length);
    for (let i = 0; i < matcher.substeps.length; i++) {
      matchStep(actual.substeps![i], matcher.substeps[i], `${path}.substeps[${i}]`);
    }
  }
}

/**
 * Assert the full step sequence of a result matches the given matchers.
 * Checks step count, then asserts each step by index.
 */
export function assertSteps(result: SerializedResult, matchers: StepMatcher[]): void {
  expect(
    result.steps.length,
    `Expected ${matchers.length} steps but got ${result.steps.length}:\n${formatResult(result)}`
  ).toBe(matchers.length);

  for (let i = 0; i < matchers.length; i++) {
    matchStep(result.steps[i], matchers[i], `steps[${i}]`);
  }
}

// ---------------------------------------------------------------------------
// Size assertions
// ---------------------------------------------------------------------------

/**
 * Assert a number is within a tolerance of an expected value.
 * Default tolerance is 10% of the expected value, minimum 1px.
 */
export function expectSize(
  actual: number,
  expected: number,
  label: string,
  tolerancePct = 0.1,
): void {
  const tolerance = Math.max(1, expected * tolerancePct);
  expect(
    actual,
    `${label}: expected ~${expected}px (±${tolerance.toFixed(1)}px), got ${actual}px`
  ).toBeGreaterThanOrEqual(expected - tolerance);
  expect(
    actual,
    `${label}: expected ~${expected}px (±${tolerance.toFixed(1)}px), got ${actual}px`
  ).toBeLessThanOrEqual(expected + tolerance);
}

// ---------------------------------------------------------------------------
// DAG helpers
// ---------------------------------------------------------------------------

/** Serialized DAG node. */
export interface SerializedNode {
  kind: string;
  element: string;
  axis: string;
  result: number;
  inputs: Record<string, SerializedNode>;
  literals: Record<string, number>;
  expr: string;
  cssProperties: Record<string, string>;
  ref?: boolean; // true if this is a back-reference (cycle prevention)
}

/** Serialized DAG result. */
export interface SerializedDag {
  element: string;
  width: SerializedNode;
  height: SerializedNode;
}

/** Run buildDag on an element and return a serialized result. */
export async function analyzeDag(page: Page, testId: string): Promise<SerializedDag> {
  return page.evaluate((tid: string) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (!el) throw new Error(`Element with data-testid="${tid}" not found`);

    const { buildDag } = (window as any).LayoutDebugger;
    if (!buildDag) throw new Error("buildDag not found");

    const result = buildDag(el);

    function describeEl(e: Element): string {
      const t = e.getAttribute("data-testid");
      if (t) return `[${t}]`;
      return `<${e.tagName.toLowerCase()}>`;
    }

    function serializeNode(node: any, visited = new Set()): any {
      if (!node) return null;
      // Prevent infinite recursion on DAG cycles
      if (visited.has(node)) return { kind: node.kind, element: describeEl(node.element), result: node.result, ref: true };
      visited.add(node);

      const inputs: Record<string, any> = {};
      for (const [key, dep] of Object.entries(node.inputs || {})) {
        inputs[key] = serializeNode(dep, visited);
      }

      return {
        kind: node.kind,
        element: describeEl(node.element),
        axis: node.axis,
        result: node.result,
        inputs,
        literals: node.literals || {},
        expr: node.expr,
        cssProperties: node.cssProperties || {},
      };
    }

    return {
      element: describeEl(result.element),
      width: serializeNode(result.width),
      height: serializeNode(result.height),
    };
  }, testId);
}

/** Serialized render node from the linearized graph. */
export interface SerializedRenderNode {
  id: string;
  kind: string;
  element: string;
  result: number;
  dependsOn: string[];
  expression: string;
}

/** Get the linearized render output for a given element and axis. */
export async function renderDagAxis(
  page: Page, testId: string, axis: "width" | "height"
): Promise<SerializedRenderNode[]> {
  return page.evaluate(({ tid, ax }) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (!el) throw new Error(`Element with data-testid="${tid}" not found`);

    const { buildDag, renderDag } = (window as any).LayoutDebugger;
    if (!buildDag || !renderDag) throw new Error("buildDag/renderDag not found");

    const dag = buildDag(el);
    const rendered = renderDag(dag);
    const axisRender = ax === "width" ? rendered.width : rendered.height;

    function describeEl(e: Element): string {
      const t = e.getAttribute("data-testid");
      if (t) return `[${t}]`;
      return `<${e.tagName.toLowerCase()}>`;
    }

    return axisRender.nodes.map((n: any) => ({
      id: n.id,
      kind: n.kind,
      element: describeEl(n.element),
      result: n.result,
      dependsOn: n.dependsOn,
      expression: n.expression,
    }));
  }, { tid: testId, ax: axis });
}
