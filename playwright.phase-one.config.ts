import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const cwd = path.resolve(__dirname);
export default defineConfig({
  testDir: './tests/phase-one',
  outputDir: './tests/test-results/phase-one',
  workers: 1,
  retries: 0,
  fullyParallel: false,
  timeout: 30000,
  expect: { timeout: 15000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3336',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command:
        "mvn -B -f backend/phase-one/pom.xml spring-boot:run -Dspring-boot.run.arguments='--server.port=18081 --colla.database-name=colla_phase_one_e2e'",
      cwd,
      url: 'http://127.0.0.1:18081/actuator/health',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'yarn dev',
      cwd,
      url: 'http://localhost:3336/account/login',
      reuseExistingServer: false,
      timeout: 360000,
      env: {
        APP_CONFIG: 'config/phase-one-e2e.js',
        OHIF_PORT: '3336',
        COLLA_API_TARGET: 'http://127.0.0.1:18081',
        OHIF_OPEN: 'false',
      },
    },
  ],
});
