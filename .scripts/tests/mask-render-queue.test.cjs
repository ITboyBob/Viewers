const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  ts = require('typescript');
function fixture() {
  const frames = [],
    rendered = [],
    live = new Set(['default', 'v1', 'v2']),
    views = new Map(),
    types = { Labelmap: 'Labelmap', Surface: 'Surface', Contour: 'Contour' };
  const view = id => {
    if (!views.has(id)) views.set(id, { id, element: new EventTarget(), render() {} });
    return views.get(id);
  };
  const result = { frames, rendered, live, onRender: undefined, engine: undefined };
  global.window = {
    requestAnimationFrame: callback => {
      frames.push(callback);
      return frames.length;
    },
  };
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../node_modules/@cornerstonejs/tools/dist/esm/stateManagement/segmentation/SegmentationRenderingEngine.js'
    ),
    'utf8'
  );
  const code = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    m = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    name => {
      if (name === '@cornerstonejs/core')
        return {
          triggerEvent() {},
          eventTarget: new EventTarget(),
          Enums: { Events: { IMAGE_RENDERED: 'image' } },
          getRenderingEngines: () => [{ getViewports: () => [...live].map(view) }],
          getEnabledElementByViewportId: id => (live.has(id) ? { viewport: view(id) } : undefined),
        };
      if (name.endsWith('/SegmentationRepresentations')) return { default: types };
      if (name.endsWith('/enums'))
        return {
          SegmentationRepresentations: types,
          Events: { SEGMENTATION_RENDERED: 'rendered' },
        };
      if (name.includes('getSegmentationRepresentation'))
        return {
          getSegmentationRepresentations: id =>
            live.has(id) ? [{ segmentationId: 's', type: 'Labelmap' }] : [],
        };
      if (name.includes('Display'))
        return {
          default: {
            render(viewport) {
              rendered.push(viewport.id);
              result.onRender?.(viewport.id);
            },
          },
        };
      if (name.includes('PlanarFreehand')) return { default: { toolName: 'PlanarFreehand' } };
      if (name.includes('store/state')) return { state: { tools: {} } };
      if (name.includes('addTool')) return { addTool() {} };
      if (name.includes('ToolGroupManager'))
        return { getToolGroupForViewport: () => ({ hasTool: () => true }) };
      throw Error('unmocked import ' + name);
    },
    m,
    m.exports
  );
  result.engine = m.exports.segmentationRenderingEngine;
  result.flush = () => {
    const callback = frames.shift();
    assert.ok(callback);
    callback();
  };
  return result;
}
test('many render requests for the same viewport coalesce to one frame', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 1000; i++) f.engine.renderSegmentationsForViewport('v1');
    assert.equal(f.frames.length, 1);
    f.flush();
    assert.deepEqual(f.rendered, ['v1']);
    assert.equal(f.frames.length, 0);
    assert.equal(f.engine._pendingRenderQueue.length, 0);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    delete global.window;
  }
});
test('empty and reentrant requests cannot strand valid viewports behind a FIFO queue', async () => {
  const f = fixture();
  try {
    f.onRender = id => {
      if (id === 'v1') {
        f.engine._setViewportsToBeRenderedNextFrame([]);
        f.engine.renderSegmentationsForViewport('v2');
        f.engine.renderSegmentationsForViewport('v2');
      }
    };
    f.engine.renderSegmentationsForViewport('v1');
    f.flush();
    assert.equal(f.frames.length, 1);
    f.flush();
    assert.deepEqual(f.rendered, ['v1', 'v2']);
    assert.equal(f.frames.length, 0);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    delete global.window;
  }
});
test('layout changes discard detached viewports while rendering all current viewports once', async () => {
  const f = fixture();
  try {
    f.engine.renderSegmentationsForViewport('default');
    f.live.delete('default');
    for (let i = 0; i < 100; i++) {
      f.engine.renderSegmentationsForViewport('v1');
      f.engine.renderSegmentationsForViewport('v2');
    }
    assert.equal(f.frames.length, 1);
    f.flush();
    assert.deepEqual(f.rendered, ['v1', 'v2']);
    assert.equal(f.engine._animationFrameSet, false);
    assert.equal(f.engine._needsRender.size, 0);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    delete global.window;
  }
});
