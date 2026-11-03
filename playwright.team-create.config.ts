import { defineConfig } from '@playwright/test';
import path from 'node:path';
import phaseOne from './playwright.phase-one.config';

const cwd = path.resolve(__dirname);
/** 独立服务与内存库，避免测试停止用户正在使用的服务。 */
export default defineConfig({
  ...phaseOne,
  timeout: 90000,
  outputDir: './tests/test-results/team-create',
  use: { ...phaseOne.use, baseURL: 'http://localhost:3337' },
  webServer: [
    {
      command:
        'java -jar backend/phase-one/target/phase-one-0.1.0-SNAPSHOT.jar --server.port=18082 --colla.database-name=colla_team_create_e2e',
      cwd,
      url: 'http://127.0.0.1:18082/actuator/health',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'yarn dev',
      cwd,
      url: 'http://localhost:3337/account/login',
      reuseExistingServer: false,
      timeout: 360000,
      env: {
        APP_CONFIG: 'config/phase-one-e2e.js',
        OHIF_PORT: '3337',
        COLLA_API_TARGET: 'http://127.0.0.1:18082',
        OHIF_OPEN: 'false',
      },
    },
  ],
});
