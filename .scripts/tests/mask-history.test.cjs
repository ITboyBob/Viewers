const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  ts = require('typescript');
function compile(file, requireStub) {
  const m = { exports: {} };
  const code = ts.transpileModule(
    fs.readFileSync(path.resolve(__dirname, '../../', file), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  new Function('require', 'module', 'exports', code)(requireStub, m, m.exports);
  return m.exports;
}
const events = new EventTarget();
const { HistoryMemo } = compile(
  'node_modules/@cornerstonejs/core/dist/esm/utilities/historyMemo/index.js',
  name =>
    name.includes('eventTarget')
      ? { default: events }
      : name.includes('asArray')
        ? { asArray: v => (Array.isArray(v) ? v : [v]) }
        : require(name)
);
const { describeHistoryMemo, readMaskHistory, trackMaskHistory, assertMaskHistoryTarget } = compile(
  'extensions/cornerstone/src/utils/maskEditing/maskHistory.ts',
  () => ({ utilities: {}, eventTarget: events })
);
function fixture(size = 4) {
  const history = new HistoryMemo('test', size),
    service = {
      getActiveSegmentation: () => ({ segmentationId: 's' }),
      getActiveSegment: () => ({ segmentIndex: 1, label: 'Bone' }),
      getSegmentation: () => ({
        label: 'Collection',
        segments: { 1: { segmentIndex: 1, label: 'Bone', active: true } },
      }),
    };
  const stop = trackMaskHistory(
    {
      services: {
        segmentationService: service,
        viewportGridService: { getActiveViewportId: () => 'v' },
        toolGroupService: {
          getToolGroupForViewport: () => ({
            getActivePrimaryMouseButtonTool: () => 'CircularBrush',
          }),
        },
      },
    },
    history
  );
  return { history, stop, service };
}
function memo(title) {
  return describeHistoryMemo(
    { restoreMemo() {} },
    { title, changed: 3, target: 'Collection / Bone', parameters: { '半径 mm': 1 } }
  );
}
test('history follows actual SDK undo/redo and carries target, parameters and voxel count', () => {
  const f = fixture();
  try {
    f.history.push(memo('Threshold'));
    f.history.push(memo('Morphology'));
    let state = readMaskHistory(f.history);
    assert.equal(state.nextUndo.title, 'Morphology');
    assert.equal(state.nextUndo.changed, 3);
    f.history.undo();
    state = readMaskHistory(f.history);
    assert.equal(state.nextUndo.title, 'Threshold');
    assert.equal(state.nextRedo.title, 'Morphology');
    assert.equal(state.entries[0].state, 'undone');
    f.history.redo();
    assert.equal(readMaskHistory(f.history).nextUndo.title, 'Morphology');
  } finally {
    f.stop();
  }
});
test('a new edit drops the undone branch; ring eviction drops old display entries', () => {
  const f = fixture(2);
  try {
    f.history.push(memo('a'));
    f.history.push(memo('b'));
    f.history.undo();
    f.history.push(memo('c'));
    assert.deepEqual(
      readMaskHistory(f.history).entries.map(v => v.title),
      ['c', 'a']
    );
    f.history.push(memo('d'));
    assert.deepEqual(
      readMaskHistory(f.history).entries.map(v => v.title),
      ['d', 'c']
    );
    assert.equal(readMaskHistory(f.history).canRedo, false);
  } finally {
    f.stop();
  }
});
test('native brush memos are represented and grouped edits match one SDK undo step', () => {
  const f = fixture();
  try {
    f.history.startGroupRecording();
    f.history.push({ operationType: 'labelmap', segmentationId: 's', restoreMemo() {} });
    f.history.push(memo('paint'));
    assert.equal(readMaskHistory(f.history).canUndo, false);
    f.history.endGroupRecording();
    const state = readMaskHistory(f.history);
    assert.equal(state.entries.length, 1);
    assert.equal(state.nextUndo.title, '组合编辑（2 项）');
    f.history.undo();
    assert.equal(readMaskHistory(f.history).entries[0].state, 'undone');
  } finally {
    f.stop();
  }
});
test('failed restore does not falsely move the history cursor', () => {
  const f = fixture();
  try {
    const item = memo('failed');
    item.restoreMemo = () => {
      throw Error('fail');
    };
    f.history.push(item);
    assert.throws(() => f.history.undo(), /fail/);
    assert.equal(readMaskHistory(f.history).nextUndo.title, 'failed');
    assert.equal(readMaskHistory(f.history).entries[0].state, 'applied');
  } finally {
    f.stop();
  }
});
test('new sessions clear stale memos and cleanup restores original SDK methods', () => {
  const history = new HistoryMemo();
  history.push(memo('old'));
  const original = history.push;
  const f = fixture();
  f.stop();
  const stop = trackMaskHistory(
    { services: { segmentationService: {}, viewportGridService: {} } },
    history
  );
  assert.equal(readMaskHistory(history).entries.length, 0);
  stop();
  assert.equal(history.push, original);
});
test('deleted targets are marked unavailable and rejected before an undo can touch orphaned labelmaps', () => {
  const f = fixture();
  let restored = 0;
  try {
    f.history.push(
      describeHistoryMemo(
        {
          restoreMemo() {
            restored++;
          },
        },
        { title: 'Threshold', segmentationId: 's', segmentIndex: 1 }
      )
    );
    f.service.getSegmentation = () => null;
    assert.equal(readMaskHistory(f.history).nextUndo.available, false);
    assert.equal(readMaskHistory(f.history).canUndo, false);
    assert.throws(() => assertMaskHistoryTarget(false, f.history), /已被删除/);
    assert.equal(restored, 0);
    assert.equal(readMaskHistory(f.history).entries[0].state, 'applied');
  } finally {
    f.stop();
  }
});
test('undo/redo is refused while a native grouped brush stroke is still being recorded', () => {
  const f = fixture();
  try {
    f.history.startGroupRecording();
    f.history.push(memo('paint'));
    assert.throws(() => assertMaskHistoryTarget(false, f.history), /笔画尚未结束/);
    assert.throws(() => assertMaskHistoryTarget(true, f.history), /笔画尚未结束/);
    f.history.endGroupRecording();
    assert.doesNotThrow(() => assertMaskHistoryTarget(false, f.history));
  } finally {
    f.stop();
  }
});
