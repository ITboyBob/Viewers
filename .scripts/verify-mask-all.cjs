const fs = require('node:fs'),
  path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  output = path.join(root, '.cache/full-mask-regression');
fs.mkdirSync(output, { recursive: true });
const testDate =
  process.env.MASK_TEST_DATE ||
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const units = require('../package.json').scripts['test:mask-editing'].split(' ').slice(1);
const browser = [
  ['basic-ui', 'verify-mask-ui.cjs'],
  ['sphere', 'verify-sphere-tools.cjs'],
  ['selection', 'verify-segment-selection.cjs'],
  ['volume', 'verify-volume-mask.cjs'],
  ['mpr-brushes', 'verify-mpr-brushes.cjs'],
  ['split', 'verify-volume-split.cjs'],
  ['workbench', 'verify-mask-workbench.cjs'],
  ['continuity', 'verify-mask-continuity.cjs'],
  ['dicom-seg', 'verify-mask-export.cjs'],
  ['appearance', 'verify-mask-appearance.cjs'],
  ['project', 'verify-mask-project.cjs'],
  ['roi-and-drafts', 'verify-mask-safety.cjs'],
  ['refinement', 'verify-mask-refinement.cjs'],
  ['refinement-cancel', 'verify-refinement-cancel.cjs'],
  ['frontend-workflow', 'verify-mask-frontend.cjs'],
  ['workspace-and-history', 'verify-mask-workspace.cjs'],
];
const steps = [
  { name: 'unit-tests', command: process.execPath, args: units },
  {
    name: 'dependency-patch',
    command: 'git',
    args: ['apply', '--reverse', '--check', 'patches/@cornerstonejs+tools+4.5.13.patch'],
  },
  ...browser.map(([name, script]) => ({
    name,
    command: process.execPath,
    args: [path.join('.scripts', script)],
  })),
  {
    name: 'real-ct-lung-and-abdomen',
    command: process.execPath,
    args: ['.scripts/verify-real-dicom.cjs'],
  },
  ...[
    ['real-project', 'verify-mask-project.cjs'],
    ['real-roi-and-drafts', 'verify-mask-safety.cjs'],
    ['real-refinement', 'verify-mask-refinement.cjs'],
    ['real-frontend-workflow', 'verify-mask-frontend.cjs'],
    ['real-workspace-and-history', 'verify-mask-workspace.cjs'],
  ].map(([name, script]) => ({
    name,
    command: process.execPath,
    args: [path.join('.scripts', script), 'abdomen-ct'],
  })),
];
const report = { testDate, startedAt: new Date().toISOString(), node: process.version, steps: [] };
const write = () =>
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
function run(step) {
  return new Promise(resolve => {
    const started = Date.now(),
      log = path.join(output, step.name + '.log'),
      fd = fs.openSync(log, 'w');
    let tail = '',
      settled = false;
    const child = spawn(step.command, step.args, {
      cwd: root,
      shell: false,
      windowsHide: true,
      timeout: 360000,
      env: { ...process.env, MASK_TEST_DATE: testDate },
    });
    const capture = data => {
      fs.writeSync(fd, data);
      tail = (tail + data.toString()).slice(-3000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    function finish(code, error) {
      if (settled) return;
      settled = true;
      fs.closeSync(fd);
      const result = {
        name: step.name,
        passed: code === 0 && !error,
        exitCode: code,
        elapsedMs: Date.now() - started,
        log: path.relative(root, log).replaceAll('\\', '/'),
      };
      if (error) result.error = error.message;
      if (!result.passed) result.output = tail;
      resolve(result);
    }
    child.on('error', error => finish(null, error));
    child.on('close', code => finish(code));
  });
}
(async () => {
  // Full regression deliberately checks both downloaded complete real CT series.
  for (const [key, count] of [
    ['lung-ct', 114],
    ['abdomen-ct', 52],
  ]) {
    const folder = path.join(root, '.cache/real-dicom', key);
    if (!fs.existsSync(path.join(folder, 'provenance.json')))
      throw Error('请先运行 corepack yarn demo:real-data，获取完整真实 CT：' + key);
    if (fs.readdirSync(folder).filter(file => file.endsWith('.dcm')).length !== count)
      throw Error(
        `真实 CT ${key} 的切片不完整，需要 ${count} 张，请运行 corepack yarn demo:real-data。`
      );
  }
  const response = await fetch('http://localhost:3000/local-mask', {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error('请先启动 corepack yarn dev:mask。');
  write();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`[${i + 1}/${steps.length}] ${step.name}: running`);
    const result = await run(step);
    report.steps.push(result);
    write();
    console.log(
      `[${i + 1}/${steps.length}] ${step.name}: ${result.passed ? 'PASS' : 'FAIL'} (${(result.elapsedMs / 1000).toFixed(1)}s)`
    );
    if (!result.passed) console.error(result.output || result.error);
  }
  report.finishedAt = new Date().toISOString();
  report.passed = report.steps.every(step => step.passed);
  write();
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        checks: report.steps.length,
        failed: report.steps.filter(step => !step.passed).map(step => step.name),
        report: path.relative(root, path.join(output, 'report.json')),
      },
      null,
      2
    )
  );
  process.exitCode = report.passed ? 0 : 1;
})().catch(error => {
  report.failure = error.message;
  report.passed = false;
  write();
  console.error(error);
  process.exitCode = 1;
});
