const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const ts = require('typescript');
const React = require('react');
let current;
function compiled(file, requireStub) {
  const output = ts.transpileModule(
    fs.readFileSync(path.resolve(__dirname, '../../', file), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    }
  ).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(requireStub, module, module.exports);
  return module.exports;
}
const header = compiled(
  'extensions/cornerstone/src/customizations/CustomSegmentStatisticsHeader.tsx',
  name => {
    if (name === 'react') return React;
    if (name === 'react-i18next') return { useTranslation: () => ({ t: key => key }) };
    if (name === '@ohif/core/src')
      return {
        useSystem: () => ({
          servicesManager: {
            services: { segmentationService: { getSegmentation: () => current } },
          },
          commandsManager: {},
        }),
      };
    if (name === '@ohif/ui-next')
      return {
        Separator: 'hr',
        Button: 'button',
        Tooltip: 'div',
        TooltipTrigger: 'div',
        TooltipContent: 'div',
        Icons: { ToolBidirectionalSegment: () => null },
      };
    if (name === '@ohif/core/src/utils') return { roundNumber: v => v };
    return {};
  }
).CustomSegmentStatisticsHeader;
test('a statistics row unmounting after its segmentation was removed renders nothing', () => {
  current = undefined;
  assert.equal(header({ segmentationId: 'deleted', segmentIndex: 2 }), null);
});
test('split undo can remove a Mask before its retained statistics row renders', () => {
  current = { segments: { 1: { cachedStats: {} } } };
  assert.equal(header({ segmentationId: 'seg', segmentIndex: 22 }), null);
});
test('statistics which have not been computed do not crash a new Mask', () => {
  current = { segments: { 1: {} } };
  assert.equal(header({ segmentationId: 'seg', segmentIndex: 1 }), null);
});
test('existing statistics still offer their normal measurement action', () => {
  current = {
    segments: { 1: { cachedStats: { namedStats: { volume: { value: 100, unit: 'mm3' } } } } },
  };
  assert.ok(React.isValidElement(header({ segmentationId: 'seg', segmentIndex: 1 })));
});
const Service = compiled(
  'extensions/cornerstone/src/services/SegmentationService/SegmentationService.ts',
  name => {
    if (name === '@ohif/core') return { PubSubService: class {} };
    if (name === '@cornerstonejs/tools')
      return {
        Enums: { SegmentationRepresentations: { Labelmap: 'Labelmap', Contour: 'Contour' } },
      };
    return {};
  }
).default;
const service = Object.create(Service.prototype);
service.getSegmentation = () => current;
test('locating a Mask already removed by undo returns no center', () => {
  current = { segments: {} };
  assert.equal(service._getSegmentCenter('seg', 2), undefined);
});
test('locating a removed annotation set returns no center', () => {
  current = undefined;
  assert.equal(service._getSegmentCenter('deleted', 1), undefined);
});
test('locating a surviving Mask still returns its cached world center', () => {
  const center = { world: [1, 2, 3] };
  current = { segments: { 1: { cachedStats: { center } } } };
  assert.deepEqual(service._getSegmentCenter('seg', 1), center);
});

let statsRead;
const statsModule = compiled('extensions/cornerstone/src/utils/updateSegmentationStats.ts', () => ({
  utilities: { segmentation: { getStatistics: () => statsRead() } },
}));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result = { 1: { array: [], volume: { value: 30, unit: 'mm3' } } };
test('a deleted segment result is discarded after its asynchronous statistics finish', async () => {
  const pending = deferred(),
    snapshot = { segments: { 22: { cachedStats: {} } } };
  statsRead = () => pending.promise;
  const job = statsModule.updateSegmentationStats({
    segmentation: snapshot,
    segmentationId: 'seg',
    readableText: { volume: 'Volume' },
  });
  delete snapshot.segments[22];
  pending.resolve({ 22: result[1] });
  assert.equal(await job, null);
});
test('invalidated statistics never mutate their captured segment objects', async () => {
  const pending = deferred(),
    snapshot = { segments: { 1: { cachedStats: {} } } };
  statsRead = () => pending.promise;
  const job = statsModule.updateSegmentationStats({
    segmentation: snapshot,
    segmentationId: 'seg',
    readableText: { volume: 'Volume' },
    isCurrent: () => false,
  });
  pending.resolve(result);
  assert.equal(await job, null);
  assert.deepEqual(snapshot.segments[1].cachedStats, {});
});
test('fresh statistics preserve a concurrent rename and replace stale volume without mutating old metadata', async () => {
  const pending = deferred(),
    snapshot = {
      segments: { 1: { label: 'Before', cachedStats: { namedStats: { volume: { value: 10 } } } } },
    };
  const latest = {
    segments: {
      1: { label: 'After', locked: true, cachedStats: { namedStats: { volume: { value: 10 } } } },
    },
  };
  statsRead = () => pending.promise;
  const job = statsModule.updateSegmentationStats({
    segmentation: snapshot,
    segmentationId: 'seg',
    readableText: { volume: 'Volume' },
    getCurrentSegmentation: () => latest,
  });
  pending.resolve(result);
  const updated = await job;
  assert.equal(updated.segments[1].label, 'After');
  assert.equal(updated.segments[1].locked, true);
  assert.equal(updated.segments[1].cachedStats.namedStats.volume.value, 30);
  assert.equal(snapshot.segments[1].cachedStats.namedStats.volume.value, 10);
  assert.equal(latest.segments[1].cachedStats.namedStats.volume.value, 10);
});
const handlers = compiled('extensions/cornerstone/src/utils/segmentationHandlers.ts', name =>
  name === './updateSegmentationStats' ? statsModule : {}
);
function handlerFixture() {
  const pending = deferred();
  statsRead = () => pending.promise;
  const snapshot = { segments: { 1: { cachedStats: {} } } },
    writes = [];
  let invalidate,
    run,
    unsubscribed = 0;
  const service = {
    EVENTS: { SEGMENTATION_DATA_MODIFIED: 'data' },
    getSegmentation: () => snapshot,
    subscribe: (_, cb) => {
      invalidate = cb;
      return { unsubscribe: () => unsubscribed++ };
    },
    subscribeDebounced: (_, cb) => {
      run = cb;
      return { unsubscribe: () => unsubscribed++ };
    },
    addOrUpdateSegmentation: input => writes.push(input),
  };
  const subscription = handlers.setupSegmentationDataModifiedHandler({
    segmentationService: service,
    customizationService: { getCustomization: () => ({ volume: 'Volume' }) },
    commandsManager: {},
  });
  return {
    pending,
    snapshot,
    writes,
    subscription,
    invalidate: () => invalidate({ segmentationId: 'seg' }),
    run: () => run({ segmentationId: 'seg' }),
    unsubscribed: () => unsubscribed,
  };
}
test('new voxel data invalidates in-flight statistics immediately before the next debounce', async () => {
  const fixture = handlerFixture(),
    job = fixture.run();
  fixture.invalidate();
  fixture.pending.resolve(result);
  await job;
  assert.equal(fixture.writes.length, 0);
  assert.deepEqual(fixture.snapshot.segments[1].cachedStats, {});
});
test('leaving the mode unsubscribes both observers and prevents a late statistics write', async () => {
  const fixture = handlerFixture(),
    job = fixture.run();
  fixture.subscription.unsubscribe();
  fixture.pending.resolve(result);
  await job;
  assert.equal(fixture.unsubscribed(), 2);
  assert.equal(fixture.writes.length, 0);
});
test('a worker rejection caused by an invalidated segmentation does not escape into the viewer', async () => {
  const fixture = handlerFixture(),
    job = fixture.run();
  fixture.invalidate();
  fixture.pending.reject(Error('source removed'));
  await assert.doesNotReject(job);
  assert.equal(fixture.writes.length, 0);
});
