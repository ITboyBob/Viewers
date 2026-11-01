import { defineConfig } from '@playwright/test';
import phaseOne from './playwright.phase-one.config';

export default defineConfig({
  ...phaseOne,
  testDir: './tests/local-shared',
  outputDir: './tests/test-results/local-shared',
  timeout: 90000,
  projects: [
    { name: 'chrome', use: { channel: 'chrome', viewport: { width: 1440, height: 900 } } },
  ],
});
