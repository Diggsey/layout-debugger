import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  use: {
    browserName: 'chromium',
    headless: true,
  },
  projects: [
    {
      name: 'default',
      testMatch: /dag\.test\.ts|fuzz-corpus\.test\.ts/,
    },
    {
      name: 'fuzz',
      testMatch: '**/fuzz.test.ts',
    },
  ],
  // Build before running tests
  webServer: {
    command: 'npm run build:dev',
    reuseExistingServer: true,
  },
});
