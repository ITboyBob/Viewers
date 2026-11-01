import { execFileSync } from 'node:child_process';
import path from 'node:path';

test.each([false, true])('WDS5默认／自定义代理均保留业务边界（自定义=%s）', custom => {
  const code = `
    const assert = require('node:assert/strict');
    const build = require('./platform/app/.webpack/webpack.pwa.js');
    const config = build({}, {mode: 'development'});
    assert.equal(Array.isArray(config.devServer.proxy), true);
    assert.equal(config.devServer.proxy.every(item => Array.isArray(item.context)), true);
    const business = config.devServer.proxy.find(item => item.context.includes('/api/v1'));
    assert.equal(business.target, 'http://127.0.0.1:18081');
    assert.equal(business.context.includes('/actuator/health'), true);
    const custom = process.env.PROXY_TARGET;
    if (custom) {
      const archive = config.devServer.proxy.find(item => item.context.includes(custom));
      assert.equal(archive.target, 'http://127.0.0.1:18082');
      assert.deepEqual(archive.pathRewrite, {'^/archive': '/dicomweb'});
    } else {
      assert.equal(config.devServer.proxy.find(item => item.context.includes('/dicomweb')).target, 'http://localhost:5000');
      assert.equal(config.devServer.proxy.find(item => item.context.includes('/dicom-microscopy-viewer')).target, 'http://localhost:3000');
    }
  `;
  expect(() =>
    execFileSync(process.execPath, ['-e', code], {
      cwd: path.resolve(__dirname, '../../../..'),
      stdio: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        COLLA_API_TARGET: 'http://127.0.0.1:18081',
        PROXY_TARGET: custom ? '/archive' : '',
        PROXY_DOMAIN: custom ? 'http://127.0.0.1:18082' : '',
        PROXY_PATH_REWRITE_FROM: '/archive',
        PROXY_PATH_REWRITE_TO: '/dicomweb',
      },
    })
  ).not.toThrow();
});
