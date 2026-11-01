import type {
  LocalParticipantSnapshot,
  LocalParticipationPort,
  LocalParticipationSnapshot,
  SharedCursorPosition,
} from '@ohif/core';
import { RemoteCursorController } from './RemoteCursorController';
import type { RemoteCursorControllerOptions } from './RemoteCursorController';
import type { StackCursorProjectionContext } from './remoteCursorProjection';

const cursor: SharedCursorPosition = {
  selection_index: 2,
  study_uid: '1.2.3',
  series_uid: '1.2.3.4',
  sop_uid: '1.2.3.4.5',
  frame_number: 1,
  coordinate_space: 'image-pixel-center',
  column: 20.25,
  row: 30.5,
  columns: 128,
  rows: 96,
};

const controllers: RemoteCursorController[] = [];
const resizeCallbacks: Array<() => void> = [];
const disconnects: jest.Mock[] = [];
let focused = true;
let visibility: DocumentVisibilityState = 'visible';
let previousResizeObserver: typeof ResizeObserver;

beforeEach(() => {
  focused = true;
  visibility = 'visible';
  resizeCallbacks.length = 0;
  disconnects.length = 0;
  jest.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  jest.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  previousResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = jest.fn().mockImplementation(callback => {
    resizeCallbacks.push(callback);
    const disconnect = jest.fn();
    disconnects.push(disconnect);
    return { observe: jest.fn(), disconnect };
  });
});

afterEach(() => {
  controllers.splice(0).forEach(controller => controller.dispose());
  globalThis.ResizeObserver = previousResizeObserver;
  document.body.replaceChildren();
  jest.restoreAllMocks();
});

function setup() {
  const element = document.createElement('div');
  document.body.appendChild(element);
  jest.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 20,
    width: 400,
    height: 300,
  } as DOMRect);
  let context: StackCursorProjectionContext = {
    viewportType: 'stack',
    frame: cursor,
    viewportSize: { width: 400, height: 300 },
    transform: {
      imageToCanvas: ({ column, row }) => ({ x: column * 2 + 10, y: row * 3 + 12 }),
      canvasToImage: ({ x, y }) => ({ column: (x - 10) / 2, row: (y - 12) / 3 }),
    },
  };
  let ready = true;
  let current = true;
  const remote: LocalParticipantSnapshot = {
    participant_id: 'source',
    user: { uid: 'bob', username: '真实远端' },
    role: 'source',
    color_key: 'cursor-v1-01',
    cursor_seq: 10,
    cursor,
  };
  let snapshot: LocalParticipationSnapshot = {
    phase: 'active',
    source_participant_id: 'source',
    batch_id: 'batch',
    error: null,
    members: [
      {
        participant_id: 'self',
        user: { uid: 'alice', username: '本机' },
        role: 'viewer',
        color_key: 'cursor-v1-02',
        cursor_seq: 0,
        cursor: null,
      },
      remote,
    ],
    color_registry: {
      task_id: 'task',
      source_participant_id: 'source',
      revision: 2,
      assignments: [
        { uid: 'bob', color_key: 'cursor-v1-01', color_value: '#2563EB' },
        { uid: 'alice', color_key: 'cursor-v1-02', color_value: '#C2410C' },
      ],
    },
  };
  const participants = new Set<() => void>();
  const views = new Set<() => void>();
  const stopParticipation = jest.fn();
  const stopView = jest.fn();
  const participation = {
    identity: {
      participant_id: 'self',
      task_id: 'task',
      user: { uid: 'alice', username: '本机' },
      isCurrent: () => current,
    },
    getSnapshot: () => snapshot,
    subscribe: listener => {
      participants.add(listener);
      return () => {
        stopParticipation();
        participants.delete(listener);
      };
    },
    sendCursor: jest.fn(),
    setViewReady: jest.fn(),
    close: jest.fn(),
  } as unknown as LocalParticipationPort;
  const onChange = jest.fn();
  const getContext = jest.fn(() => context);
  const options: RemoteCursorControllerOptions = {
    element,
    participation,
    getContext,
    getViewReady: () => ready,
    subscribeView: listener => {
      views.add(listener);
      return () => {
        stopView();
        views.delete(listener);
      };
    },
    onChange,
  };
  const controller = new RemoteCursorController(options);
  controllers.push(controller);
  const move = (x = 50.5, y = 103.5, target = element) => {
    const event = new MouseEvent('pointermove', { bubbles: true, cancelable: true });
    // jsdom 的 MouseEvent 会截断小数；补成真实 PointerEvent 可提供的 CSS 亚像素值。
    Object.defineProperties(event, { clientX: { value: x + 10 }, clientY: { value: y + 20 } });
    return target.dispatchEvent(event);
  };
  const emitView = () => views.forEach(listener => listener());
  const emitParticipation = () => participants.forEach(listener => listener());
  return {
    element,
    controller,
    participation,
    onChange,
    options,
    getContext,
    participants,
    views,
    stopParticipation,
    stopView,
    move,
    emitView,
    emitParticipation,
    state: () => onChange.mock.calls.at(-1)?.[0],
    setContext: (value: Partial<StackCursorProjectionContext>) => {
      context = { ...context, ...value };
    },
    setReady: (value: boolean) => {
      ready = value;
      emitView();
    },
    setCurrent: (value: boolean) => {
      current = value;
      emitParticipation();
    },
    setSnapshot: (value: Partial<LocalParticipationSnapshot>) => {
      snapshot = { ...snapshot, ...value };
      emitParticipation();
    },
    updateRemote: (value: Partial<LocalParticipantSnapshot>) => {
      snapshot = { ...snapshot, members: [snapshot.members[0], { ...remote, ...value }] };
      emitParticipation();
    },
  };
}

describe('远端光标受控接合', () => {
  it('初次接合展开可信快照，只绘制远端真实身份和色表投影', () => {
    const fixture = setup();
    expect(fixture.state()).toMatchObject({
      supported: true,
      viewportSize: { width: 400, height: 300 },
    });
    expect(fixture.state().cursors).toHaveLength(1);
    expect(fixture.state().cursors[0]).toMatchObject({
      participant: { participant_id: 'source', user: { username: '真实远端' } },
      point: { x: 50.5, y: 103.5 },
    });
    expect(fixture.participation.sendCursor).not.toHaveBeenCalled();
    expect(fixture.participation.setViewReady).not.toHaveBeenCalled();
  });

  it('真实 pointer CSS 点通过变换采样，保留原工具事件传播及默认行为', () => {
    const fixture = setup();
    const nativeTool = jest.fn();
    fixture.element.addEventListener('pointermove', nativeTool);
    expect(fixture.move()).toBe(true);
    expect(nativeTool).toHaveBeenCalledTimes(1);
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(cursor);
    fixture.move(52.5, 103.5);
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith({ ...cursor, column: 21.25 });
    expect(fixture.participation.close).not.toHaveBeenCalled();
  });

  it.each(['idle', 'loading', 'closed'] as const)('通信 %s 时不能绘制或发送非空光标', phase => {
    const fixture = setup();
    fixture.setSnapshot({ phase });
    fixture.move();
    expect(fixture.state().cursors).toEqual([]);
    expect(fixture.participation.sendCursor).not.toHaveBeenCalled();
  });

  it('active 且 view_ready 才能非空，恢复 ready 仍需新的指针采样', () => {
    const fixture = setup();
    fixture.move();
    fixture.setReady(false);
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    expect(fixture.state().cursors).toEqual([]);
    const calls = (fixture.participation.sendCursor as jest.Mock).mock.calls.length;
    fixture.move();
    fixture.setReady(true);
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(calls);
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(cursor);
    expect(fixture.participation.setViewReady).not.toHaveBeenCalled();
  });

  it('身份暂时不可用立即提交 null，恢复后不自动发旧点', () => {
    const fixture = setup();
    fixture.move();
    fixture.setCurrent(false);
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    expect(fixture.state().cursors).toEqual([]);
    const calls = (fixture.participation.sendCursor as jest.Mock).mock.calls.length;
    fixture.setCurrent(true);
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(calls);
  });

  it.each(['pointerleave', 'pointercancel'])('%s 立即隐藏并清除待采样点，返回必须新采样', event => {
    const fixture = setup();
    fixture.move();
    fixture.element.dispatchEvent(new Event(event));
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    const calls = (fixture.participation.sendCursor as jest.Mock).mock.calls.length;
    fixture.controller.refresh();
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(calls);
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(cursor);
  });

  it('失焦及隐藏立即 null，focus/恢复可见不制造鼠标移动', () => {
    const fixture = setup();
    fixture.move();
    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    let calls = (fixture.participation.sendCursor as jest.Mock).mock.calls.length;
    fixture.move();
    focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(calls);
    fixture.move();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    calls = (fixture.participation.sendCursor as jest.Mock).mock.calls.length;
    fixture.move();
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(calls);
  });

  it('换帧立即 null，切回不能重画旧快照；本机和远端各需有效新样本', () => {
    const fixture = setup();
    fixture.move();
    fixture.setContext({ frame: { ...cursor, frame_number: 2 } });
    fixture.emitView();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    expect(fixture.state().cursors).toEqual([]);
    fixture.setContext({ frame: cursor });
    fixture.emitView();
    expect(fixture.state().cursors).toEqual([]);
    fixture.updateRemote({ cursor_seq: 11 });
    expect(fixture.state().cursors).toHaveLength(1);
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(cursor);
  });

  it('PRE_STACK_NEW_IMAGE 在旧上下文仍可读时先清光标，完成后再接受新样本', () => {
    const fixture = setup();
    fixture.move();
    fixture.element.dispatchEvent(new Event('CORNERSTONE_PRE_STACK_NEW_IMAGE'));
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    expect(fixture.state().cursors).toEqual([]);
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    fixture.element.dispatchEvent(new Event('CORNERSTONE_STACK_NEW_IMAGE'));
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(cursor);
  });

  it('原生目标先变化再 PRE，完成事件前不得发送新帧非空位置', () => {
    const fixture = setup();
    fixture.move();
    fixture.setContext({ frame: { ...cursor, frame_number: 2 } });
    fixture.element.dispatchEvent(
      new CustomEvent('CORNERSTONE_PRE_STACK_NEW_IMAGE', {
        detail: { imageId: 'dicomfile:0&frame=2' },
      })
    );
    fixture.move();
    const sent = (fixture.participation.sendCursor as jest.Mock).mock.calls.map(call => call[0]);
    expect(sent.filter(value => value !== null).map(value => value.frame_number)).toEqual([1]);
    expect(sent.at(-1)).toBeNull();
    fixture.element.dispatchEvent(
      new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', {
        detail: { imageId: 'dicomfile:0&frame=2' },
      })
    );
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith({
      ...cursor,
      frame_number: 2,
    });
  });

  it('原生目标先变化再 PRE，完成事件前远端新帧及新序号也不得绘制', () => {
    const fixture = setup();
    fixture.setContext({ frame: { ...cursor, frame_number: 2 } });
    fixture.element.dispatchEvent(
      new CustomEvent('CORNERSTONE_PRE_STACK_NEW_IMAGE', {
        detail: { imageId: 'dicomfile:0&frame=2' },
      })
    );
    fixture.updateRemote({ cursor_seq: 11, cursor: { ...cursor, frame_number: 2 } });
    expect(fixture.state().cursors).toEqual([]);
    fixture.element.dispatchEvent(
      new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', {
        detail: { imageId: 'dicomfile:0&frame=2' },
      })
    );
    expect(fixture.state().cursors).toEqual([]);
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    expect(fixture.state().cursors).toHaveLength(1);
  });

  it('快速换目标后的旧完成事件和缺标记完成事件不能释放最新 PRE 等待', () => {
    const fixture = setup();
    for (const frame_number of [2, 3]) {
      fixture.setContext({ frame: { ...cursor, frame_number } });
      fixture.element.dispatchEvent(
        new CustomEvent('CORNERSTONE_PRE_STACK_NEW_IMAGE', {
          detail: { imageId: `dicomfile:0&frame=${frame_number}` },
        })
      );
    }
    fixture.element.dispatchEvent(
      new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', {
        detail: { imageId: 'dicomfile:0&frame=2' },
      })
    );
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    fixture.move();
    fixture.updateRemote({ cursor_seq: 11, cursor: { ...cursor, frame_number: 3 } });
    expect(fixture.participation.sendCursor).not.toHaveBeenCalled();
    expect(fixture.state().cursors).toEqual([]);
    fixture.element.dispatchEvent(new Event('CORNERSTONE_STACK_NEW_IMAGE'));
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    fixture.move();
    expect(fixture.participation.sendCursor).not.toHaveBeenCalled();
    fixture.element.dispatchEvent(
      new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', {
        detail: { imageId: 'dicomfile:0&frame=3' },
      })
    );
    fixture.move();
    expect(fixture.participation.sendCursor).not.toHaveBeenCalled();
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith({
      ...cursor,
      frame_number: 3,
    });
    expect(fixture.state().cursors).toHaveLength(1);
  });

  it('CPU 在适配器就绪前发匹配 STACK，随后渲染应恢复而无需第二个 STACK', () => {
    const fixture = setup();
    const transform = fixture.getContext().transform;
    fixture.setContext({ frame: { ...cursor, frame_number: 2 }, transform: null });
    const detail = { imageId: 'dicomfile:0&frame=2' };
    fixture.element.dispatchEvent(new CustomEvent('CORNERSTONE_PRE_STACK_NEW_IMAGE', { detail }));
    fixture.element.dispatchEvent(new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', { detail }));
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    fixture.setContext({ transform });
    fixture.emitView();
    fixture.move();
    fixture.updateRemote({ cursor_seq: 11, cursor: { ...cursor, frame_number: 2 } });
    expect(fixture.participation.sendCursor).not.toHaveBeenCalled();
    expect(fixture.state().cursors).toEqual([]);
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith({
      ...cursor,
      frame_number: 2,
    });
  });

  it('CPU 同尺寸新帧在 STACK 时仍有旧变换，GPU/CPU 均须等渲染后才采样和绘制', () => {
    const fixture = setup();
    fixture.setContext({ frame: { ...cursor, frame_number: 2 } });
    const detail = { imageId: 'dicomfile:0&frame=2' };
    fixture.element.dispatchEvent(new CustomEvent('CORNERSTONE_PRE_STACK_NEW_IMAGE', { detail }));
    fixture.element.dispatchEvent(new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', { detail }));
    fixture.move();
    fixture.updateRemote({ cursor_seq: 11, cursor: { ...cursor, frame_number: 2 } });
    expect(fixture.participation.sendCursor).not.toHaveBeenCalled();
    expect(fixture.state().cursors).toEqual([]);
    fixture.setContext({
      transform: {
        imageToCanvas: ({ column, row }) => ({ x: column * 2 + 30, y: row * 3 + 12 }),
        canvasToImage: ({ x, y }) => ({ column: (x - 30) / 2, row: (y - 12) / 3 }),
      },
    });
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith({
      ...cursor,
      frame_number: 2,
      column: 10.25,
    });
    expect(fixture.state().cursors[0].point).toEqual({ x: 70.5, y: 103.5 });
  });

  it('匹配 STACK 后新的 PRE 必须清完成标志，旧 render 不得放行新目标', () => {
    const fixture = setup();
    fixture.setContext({ frame: { ...cursor, frame_number: 2 } });
    fixture.element.dispatchEvent(
      new CustomEvent('CORNERSTONE_PRE_STACK_NEW_IMAGE', {
        detail: { imageId: 'dicomfile:0&frame=2' },
      })
    );
    fixture.element.dispatchEvent(
      new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', {
        detail: { imageId: 'dicomfile:0&frame=2' },
      })
    );
    fixture.setContext({ frame: { ...cursor, frame_number: 3 } });
    fixture.element.dispatchEvent(
      new CustomEvent('CORNERSTONE_PRE_STACK_NEW_IMAGE', {
        detail: { imageId: 'dicomfile:0&frame=3' },
      })
    );
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    fixture.move();
    fixture.updateRemote({ cursor_seq: 11, cursor: { ...cursor, frame_number: 3 } });
    expect(fixture.participation.sendCursor).not.toHaveBeenCalled();
    expect(fixture.state().cursors).toEqual([]);
    fixture.element.dispatchEvent(
      new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', {
        detail: { imageId: 'dicomfile:0&frame=3' },
      })
    );
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith({
      ...cursor,
      frame_number: 3,
    });
  });

  it('同帧 camera/render/resize 立即重投影，只有指针下原图位置改变才重采样', () => {
    const fixture = setup();
    fixture.move();
    const calls = (fixture.participation.sendCursor as jest.Mock).mock.calls.length;
    fixture.setContext({
      transform: {
        imageToCanvas: ({ column, row }) => ({ x: column * 2 + 30, y: row * 3 + 12 }),
        canvasToImage: ({ x, y }) => ({ column: (x - 30) / 2, row: (y - 12) / 3 }),
      },
    });
    fixture.element.dispatchEvent(new Event('CORNERSTONE_CAMERA_MODIFIED'));
    expect(fixture.state().cursors[0].point).toEqual({ x: 70.5, y: 103.5 });
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith({ ...cursor, column: 10.25 });
    fixture.element.dispatchEvent(new Event('CORNERSTONE_IMAGE_RENDERED'));
    resizeCallbacks.forEach(callback => callback());
    window.dispatchEvent(new Event('resize'));
    fixture.emitParticipation();
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(calls + 1);
  });

  it('协议更新引起同步刷新时不循环发送，不建立第二层移动定时器', () => {
    const fixture = setup();
    const clock = { now: jest.fn(), setTimeout: jest.fn(), clearTimeout: jest.fn() };
    fixture.controller.dispose();
    const controller = new RemoteCursorController({ ...fixture.options, clock });
    controllers.push(controller);
    (fixture.participation.sendCursor as jest.Mock).mockImplementation(() =>
      fixture.emitParticipation()
    );
    fixture.move();
    fixture.move(52.5);
    fixture.move(54.5);
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(3);
    expect(clock.setTimeout).not.toHaveBeenCalled();
  });

  it('发送期间协议同步关闭时立即隐藏，不能用发送前快照重画旧成员', () => {
    const fixture = setup();
    (fixture.participation.sendCursor as jest.Mock).mockImplementation(() =>
      fixture.setSnapshot({ phase: 'closed' })
    );
    fixture.move();
    expect(fixture.state().cursors).toEqual([]);
  });

  it.each(['volume', 'microscopy'])(
    '切到 %s 隐藏且不修改原生模式，切回需远端新序号',
    viewportType => {
      const fixture = setup();
      fixture.move();
      fixture.setContext({ viewportType });
      fixture.emitView();
      expect(fixture.state()).toMatchObject({ supported: false, cursors: [] });
      expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
      fixture.setContext({ viewportType: 'stack' });
      fixture.emitView();
      expect(fixture.state().cursors).toEqual([]);
      fixture.updateRemote({ cursor_seq: 11 });
      expect(fixture.state().cursors).toHaveLength(1);
    }
  );

  it('无效变换、画面外采样及读上下文抛错安全隐藏', () => {
    const fixture = setup();
    fixture.move();
    fixture.move(0, 0);
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    fixture.setContext({ transform: { imageToCanvas: () => null, canvasToImage: () => null } });
    fixture.emitView();
    expect(fixture.state().cursors).toEqual([]);
    fixture.getContext.mockImplementation(() => {
      throw new Error('视口已释放');
    });
    expect(() => fixture.controller.refresh()).not.toThrow();
    expect(fixture.state().cursors).toEqual([]);
  });

  it.each(['missing', 'task', 'source', 'duplicate', 'key'])('色表 %s 时不能猜色绘制', kind => {
    const fixture = setup();
    const registry = fixture.state().colorRegistry;
    if (kind === 'missing') {
      fixture.setSnapshot({ color_registry: null });
    }
    if (kind === 'task') {
      fixture.setSnapshot({ color_registry: { ...registry, task_id: 'other' } });
    }
    if (kind === 'source') {
      fixture.setSnapshot({ color_registry: { ...registry, source_participant_id: 'old' } });
    }
    if (kind === 'duplicate') {
      fixture.setSnapshot({
        color_registry: {
          ...registry,
          assignments: registry.assignments.map(value => ({ ...value, color_value: '#2563EB' })),
        },
      });
    }
    if (kind === 'key') {
      fixture.updateRemote({ color_key: 'unknown' });
    }
    expect(fixture.state().cursors).toEqual([]);
  });

  it('远端 null、帧失配、旧序号及同序号改点不画，只有新有效样本恢复', () => {
    const fixture = setup();
    fixture.updateRemote({ cursor_seq: 11, cursor: { ...cursor, column: 25 } });
    expect(fixture.state().cursors[0].point.x).toBe(60);
    fixture.updateRemote({ cursor_seq: 10 });
    expect(fixture.state().cursors).toEqual([]);
    fixture.updateRemote({ cursor_seq: 11, cursor: { ...cursor, column: 30 } });
    expect(fixture.state().cursors).toEqual([]);
    fixture.updateRemote({ cursor_seq: 12, cursor: null });
    expect(fixture.state().cursors).toEqual([]);
    fixture.updateRemote({ cursor_seq: 13, cursor: { ...cursor, frame_number: 2 } });
    expect(fixture.state().cursors).toEqual([]);
    fixture.updateRemote({ cursor_seq: 14 });
    expect(fixture.state().cursors).toHaveLength(1);
  });

  it('静止位置不靠假移动续期，参与快照仍有效时持续显示', () => {
    const fixture = setup();
    fixture.move();
    const calls = (fixture.participation.sendCursor as jest.Mock).mock.calls.length;
    for (let i = 0; i < 20; i++) {
      fixture.controller.refresh();
    }
    expect(fixture.state().cursors).toHaveLength(1);
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(calls);
  });

  it('同 port 多视口只允许当前指针所有者发送 null，其他视口刷新和退出不清新点', () => {
    const fixture = setup();
    const second = document.createElement('div');
    document.body.appendChild(second);
    jest
      .spyOn(second, 'getBoundingClientRect')
      .mockReturnValue({ left: 10, top: 20, width: 400, height: 300 } as DOMRect);
    const other = new RemoteCursorController({ ...fixture.options, element: second });
    controllers.push(other);
    fixture.move();
    fixture.move(52.5, 103.5, second);
    const calls = (fixture.participation.sendCursor as jest.Mock).mock.calls.length;
    fixture.controller.refresh();
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(calls);
    fixture.move();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(cursor);
    fixture.move(52.5, 103.5, second);
    const afterReturn = (fixture.participation.sendCursor as jest.Mock).mock.calls.length;
    fixture.element.dispatchEvent(new Event('pointerleave'));
    fixture.controller.dispose();
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(afterReturn);
    second.dispatchEvent(new Event('pointerleave'));
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
  });

  it('dispose 清所有监听与 observer，旧订阅/旧 observer 回调无法复活，不关闭共享端口', () => {
    const fixture = setup();
    fixture.move();
    const oldView = [...fixture.views];
    const oldParticipation = [...fixture.participants];
    fixture.controller.dispose();
    expect(fixture.participation.sendCursor).toHaveBeenLastCalledWith(null);
    expect(fixture.stopView).toHaveBeenCalledTimes(1);
    expect(fixture.stopParticipation).toHaveBeenCalledTimes(1);
    expect(disconnects[0]).toHaveBeenCalledTimes(1);
    const calls = fixture.onChange.mock.calls.length;
    const sends = (fixture.participation.sendCursor as jest.Mock).mock.calls.length;
    oldView.forEach(callback => callback());
    oldParticipation.forEach(callback => callback());
    resizeCallbacks.forEach(callback => callback());
    fixture.move();
    window.dispatchEvent(new Event('blur'));
    fixture.controller.refresh();
    fixture.controller.dispose();
    expect(fixture.onChange).toHaveBeenCalledTimes(calls);
    expect(fixture.participation.sendCursor).toHaveBeenCalledTimes(sends);
    expect(fixture.participation.close).not.toHaveBeenCalled();
    expect(fixture.participation.setViewReady).not.toHaveBeenCalled();
  });

  it('没有 ResizeObserver 时仍可通过显式订阅、原生事件和 window resize 刷新', () => {
    const fixture = setup();
    fixture.controller.dispose();
    globalThis.ResizeObserver = undefined;
    const controller = new RemoteCursorController({
      ...fixture.options,
      events: ['controlled-view-change'],
    });
    controllers.push(controller);
    const before = fixture.onChange.mock.calls.length;
    fixture.element.dispatchEvent(new Event('controlled-view-change'));
    window.dispatchEvent(new Event('resize'));
    expect(fixture.onChange.mock.calls.length).toBe(before + 2);
  });
});
