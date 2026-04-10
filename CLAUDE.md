# Layout Debugger — Development Guidelines

## Lint Exceptions

Never add `eslint-disable` or other lint suppression comments without:
1. Considering alternatives — can the code be restructured to avoid the violation?
2. Asking the user for permission.

The only file authorized to have a lint exception is `src/core/element-proxy.ts`, which is the sole wrapper around `getComputedStyle`.

## CalcExpr and Node Results

Every LayoutNode's CalcExpr MUST represent the real CSS calculation that produces the node's result. Never use `propVal`, `overrideResult`, or `getBoundingClientRect` to paper over a CalcExpr that doesn't match reality. If the CalcExpr evaluates to a different number than the browser, the CalcExpr is wrong — fix the calculation, don't override the result.

The whole point of this tool is to show users WHY an element is a given size. A CalcExpr that just reports a measured value explains nothing. Build the actual calculation from the spec (container size minus margins, flex algorithm shares, percentage of containing block, etc.).

## CSS Property Access

All CSS property reads MUST go through `ElementProxy` (defined in `src/core/element-proxy.ts`). Direct use of `getComputedStyle` is forbidden everywhere except inside ElementProxy itself. This ensures every CSS read is tracked and visible in the UI.

## No getBoundingClientRect in Core Layout Code

`getBoundingClientRect()` is banned in core layout code (`src/core/`) because it replaces a calculation with a measurement, losing the "why" explanation. The only authorized measurement functions are in `src/core/utils.ts` (`measureElementSize`, `measureIntrinsicSize`, `measureMinContentSize`). UI code in `src/extension/` and the oracle in `src/core/serialize.ts` may use it directly. Enforced by `eslint-js/no-restricted-syntax` lint rule.

## Test Runner

Tests use Playwright, not Vitest. Run with `npx playwright test --project default`.

## Fuzz Corpus

The `errors` field in fuzz corpus JSON files records historical errors from when the test was first generated. These are NOT expected failures — the test runner compares current results against live browser measurements. If a fuzz test fails, it's a real regression.

Never delete fuzz corpus files — they are permanent regression tests.

## Analysis Scripts

For any repeated ad-hoc analysis (parsing test results, grouping fuzz failures, inspecting JSON output), write a reusable script under `scripts/` rather than invoking `node -e '...'` directly. Direct `node` invocations require per-call approval; a script can be refined and re-run freely.
