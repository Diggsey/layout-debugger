# Layout Debugger — Development Guidelines

## Lint Exceptions

Never add `eslint-disable` or other lint suppression comments without:
1. Considering alternatives — can the code be restructured to avoid the violation?
2. Asking the user for permission.

The only file authorized to have a lint exception is `src/core/element-proxy.ts`, which is the sole wrapper around `getComputedStyle`.

## CSS Property Access

All CSS property reads MUST go through `ElementProxy` (defined in `src/core/element-proxy.ts`). Direct use of `getComputedStyle` is forbidden everywhere except inside ElementProxy itself. This ensures every CSS read is tracked and visible in the UI.

## Test Runner

Tests use Playwright, not Vitest. Run with `npx playwright test --project default`.

## Fuzz Corpus

The `errors` field in fuzz corpus JSON files records historical errors from when the test was first generated. These are NOT expected failures — the test runner compares current results against live browser measurements. If a fuzz test fails, it's a real regression.

Never delete fuzz corpus files — they are permanent regression tests.
