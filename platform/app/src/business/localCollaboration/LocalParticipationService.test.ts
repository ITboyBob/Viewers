import type {
  LocalClockPort,
  LocalParticipantIdentity,
  LocalReadyState,
  LocalSharingMessage,
  SharedCursorPosition,
  SharedPublicationContext,
  SharedPublicationSnapshot,
} from '@ohif/core';
import { LocalParticipationService } from './LocalParticipationService';
import { TaskColorRegistry } from './TaskColorRegistry';

class Clock implements LocalClockPort {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  };
  clearTimeout = (id: number) => {
    this.timers.delete(id);
  };
  advance(ms: number) {
    const end = this.time + ms;
    while (this.timers.size) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) {
        break;
      }
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = end;
  }
}
class Bus {
  ports = new Set<ReturnType<Bus['port']>>();
  messages: LocalSharingMessage[] = [];
  port() {
    const listeners = new Set<(value: unknown) => void>();
    const port = {
      listeners,
      postMessage: (message: LocalSharingMessage) => {
        this.messages.push(message);
        for (const other of this.ports) {
          if (other !== port) {
            other.listeners.forEach(fn => fn(JSON.parse(JSON.stringify(message))));
          }
        }
      },
      subscribe: (listener: (value: unknown) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close: jest.fn(() => {
        this.ports.delete(port);
      }),
    };
    this.ports.add(port);
    return port;
  }
  inject(value: unknown) {
    this.ports.forEach(port => port.listeners.forEach(fn => fn(value)));
  }
}
function identity(
  id: string,
  uid = id,
  role: 'source' | 'viewer' = 'viewer'
): LocalParticipantIdentity {
  let current = true;
  let seq = 0;
  const listeners = new Set<() => void>();
  return {
    participant_id: id,
    task_id: 'task',
    role,
    user: { uid, username: uid },
    session_generation: 1,
    isCurrent: () => current,
    nextSeq: () => {
      if (!current) {
        throw new Error('旧实例');
      }
      return ++seq;
    },
    close: () => {
      if (current) {
        current = false;
        listeners.forEach(fn => fn());
      }
    },
    subscribe: fn => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
const cursor: SharedCursorPosition = {
  selection_index: 0,
  study_uid: 'study',
  series_uid: 'series',
  sop_uid: 'sop',
  frame_number: 1,
  coordinate_space: 'image-pixel-center',
  column: 5,
  row: 8,
  columns: 10,
  rows: 10,
};
function setup() {
  const clock = new Clock();
  const bus = new Bus();
  const sourceIdentity = identity('source', 'alice', 'source');
  const listeners = new Set<() => void>();
  let publication: SharedPublicationSnapshot = {
    publication_phase: 'ready',
    view_ready: false,
    error: null,
    manifest: {
      cache_version: 1,
      cache_state: 'ready',
      task_id: 'task',
      batch_id: 'batch',
      source_participant_id: 'source',
      importer_uid: 'alice',
      title: '合成',
      team_id: 'team',
      mode_path: 'segmentation/dicomlocal',
      files: [{ ...cursor, byte_length: 1, file_name: '合成.dcm' }],
    },
  };
  const context: SharedPublicationContext = {
    identity: sourceIdentity,
    task_id: 'task',
    batch_id: 'batch',
    isCurrent: sourceIdentity.isCurrent,
    getSnapshot: () => publication,
    subscribe: fn => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setViewReady: ready => {
      publication = { ...publication, view_ready: ready };
      listeners.forEach(fn => fn());
    },
    setPublication: phase => {
      publication = { ...publication, publication_phase: phase };
      listeners.forEach(fn => fn());
      return true;
    },
    close: sourceIdentity.close,
  };
  const verifier = { verify: jest.fn().mockResolvedValue(true) };
  const source = new LocalParticipationService({
    identity: sourceIdentity,
    source: context,
    channel: bus.port(),
    clock,
    verifier,
  });
  const makeViewer = (id = 'viewer', uid = 'bob') =>
    new LocalParticipationService({ identity: identity(id, uid), channel: bus.port(), clock });
  const viewer = makeViewer();
  return { clock, bus, source, viewer, context, verifier, makeViewer, sourceIdentity };
}
async function enter(viewer: LocalParticipationService) {
  await viewer.join('loading');
  await viewer.join('active');
}
const tick = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
};
const envelope = (id: string, seq: number, kind: string, extra = {}) => ({
  protocol_version: 1,
  task_id: 'task',
  source_participant_id: 'source',
  participant_id: id,
  seq,
  kind,
  ...extra,
});
function ready(reply: number, phase: 'loading' | 'active' = 'loading', seq = 1): LocalReadyState {
  const colors = new TaskColorRegistry('task', 'source', 'alice');
  if (phase === 'active') {
    colors.assign('bob');
  }
  const member = (id, uid, role, key) => ({
    participant_id: id,
    user: { uid, username: uid },
    role,
    color_key: key,
    cursor_seq: 0,
    cursor: null,
  });
  return envelope('source', seq, 'state', {
    target_participant_id: 'viewer',
    reply_to_seq: reply,
    result: 'ready',
    batch_id: 'batch',
    color_registry: colors.getSnapshot(),
    members: [
      member('source', 'alice', 'source', 'cursor-v1-01'),
      ...(phase === 'active' ? [member('viewer', 'bob', 'viewer', 'cursor-v1-02')] : []),
    ],
  }) as LocalReadyState;
}

describe('本地参与协议', () => {
  it('loading 只发现源，active 再登记 uid 并立即心跳，view_ready 独立', async () => {
    const { viewer, source, bus, verifier } = setup();
    const loading = await viewer.join('loading');
    expect(loading.members.map(m => m.participant_id)).toEqual(['source']);
    expect(loading.color_registry.revision).toBe(1);
    expect(viewer.getSnapshot().phase).toBe('loading');
    await viewer.join('active');
    expect(viewer.getSnapshot().phase).toBe('active');
    expect(source.getSnapshot().members).toHaveLength(2);
    expect(viewer.getSnapshot().color_registry.assignments).toHaveLength(2);
    expect(verifier.verify).toHaveBeenCalledTimes(2);
    expect(bus.messages.some(m => m.kind === 'heartbeat' && m.participant_id === 'viewer')).toBe(
      true
    );
    viewer.sendCursor(cursor);
    expect(bus.messages.filter(m => m.kind === 'cursor')).toHaveLength(0);
    viewer.setViewReady(true);
    viewer.sendCursor(cursor);
    expect(source.getSnapshot().members.find(m => m.participant_id === 'viewer').cursor).toEqual(
      cursor
    );
    source.setViewReady(true);
    source.sendCursor(cursor);
    expect(source.getSnapshot().members.find(m => m.participant_id === 'source').cursor).toEqual(
      cursor
    );
    expect(viewer.getSnapshot().members.find(m => m.participant_id === 'source').cursor).toEqual(
      cursor
    );
  });

  it('同实例所有消息严格递增，每 2 秒心跳，静止超过 5 秒不清光标', async () => {
    const { viewer, source, clock, bus } = setup();
    await enter(viewer);
    viewer.setViewReady(true);
    viewer.sendCursor(cursor);
    const initial = bus.messages.filter(
      m => m.kind === 'heartbeat' && m.participant_id === 'viewer'
    ).length;
    clock.advance(1999);
    expect(
      bus.messages.filter(m => m.kind === 'heartbeat' && m.participant_id === 'viewer')
    ).toHaveLength(initial);
    clock.advance(4001);
    expect(
      bus.messages.filter(m => m.kind === 'heartbeat' && m.participant_id === 'viewer')
    ).toHaveLength(initial + 3);
    expect(source.getSnapshot().members.find(m => m.participant_id === 'viewer').cursor).toEqual(
      cursor
    );
    for (const id of ['source', 'viewer']) {
      const seq = bus.messages.filter(m => m.participant_id === id).map(m => m.seq);
      expect(seq.every((value, index) => index === 0 || value > seq[index - 1])).toBe(true);
    }
  });

  it('50ms 保留最新移动，null 立即发送且取消滞留位置', async () => {
    const { viewer, source, clock, bus } = setup();
    await enter(viewer);
    viewer.setViewReady(true);
    viewer.sendCursor(cursor);
    viewer.sendCursor({ ...cursor, column: 6 });
    viewer.sendCursor({ ...cursor, column: 7 });
    clock.advance(49);
    expect(source.getSnapshot().members[1].cursor.column).toBe(5);
    clock.advance(1);
    expect(source.getSnapshot().members[1].cursor.column).toBe(7);
    viewer.sendCursor({ ...cursor, column: 8 });
    viewer.sendCursor(null);
    clock.advance(100);
    expect(source.getSnapshot().members[1].cursor).toBeNull();
    expect(
      bus.messages.filter(m => m.kind === 'cursor' && m.participant_id === 'viewer')
    ).toHaveLength(3);
  });

  it('未知 heartbeat/cursor/leave/active 不能建员，未知 loading 可以自举', async () => {
    const { bus, source } = setup();
    bus.inject(envelope('unknown', 1, 'heartbeat'));
    bus.inject(envelope('unknown', 2, 'cursor', { cursor }));
    bus.inject(envelope('unknown', 3, 'leave', { reason: 'exit' }));
    bus.inject(
      envelope('unknown', 4, 'join', {
        join_phase: 'active',
        user: { uid: 'bob', username: 'bob' },
      })
    );
    await tick();
    expect(source.getSnapshot().members).toHaveLength(1);
    bus.inject(
      envelope('unknown', 5, 'join', {
        source_participant_id: null,
        join_phase: 'loading',
        user: { uid: 'bob', username: 'bob' },
      })
    );
    await tick();
    expect(
      bus.messages.some(m => m.kind === 'state' && m.reply_to_seq === 5 && m.result === 'ready')
    ).toBe(true);
    expect(source.getSnapshot().members).toHaveLength(1);
  });

  it('候选不可更换 uid，loading/active 重试不重复占色', async () => {
    const { source, viewer, bus } = setup();
    await viewer.join('loading');
    bus.inject(
      envelope('viewer', 2, 'join', {
        join_phase: 'active',
        user: { uid: 'intruder', username: 'intruder' },
      })
    );
    await tick();
    expect(source.getSnapshot().members).toHaveLength(1);
    await viewer.join('active');
    await viewer.join('active');
    expect(source.getSnapshot().color_registry.revision).toBe(2);
    expect(source.getSnapshot().members).toHaveLength(2);
  });

  it('leave 与超时形成墓碑，新 participant 的相同 uid 仍取原色，历史第三 uid 无色', async () => {
    const { viewer, source, bus, makeViewer } = setup();
    await enter(viewer);
    viewer.close();
    bus.inject(envelope('viewer', 999, 'cursor', { cursor }));
    bus.inject(
      envelope('viewer', 1000, 'join', {
        join_phase: 'loading',
        user: { uid: 'bob', username: 'bob' },
      })
    );
    await tick();
    expect(source.getSnapshot().members).toHaveLength(1);
    const again = makeViewer('new-viewer');
    await enter(again);
    expect(again.getSnapshot().color_registry.revision).toBe(2);
    again.close();
    const third = makeViewer('third', 'carol');
    await third.join('loading');
    await expect(third.join('active')).rejects.toThrow('color_unavailable');
    expect(third.getSnapshot().phase).toBe('closed');
    expect(source.getSnapshot().color_registry.assignments).toHaveLength(2);
  });

  it('15 秒边界仍存活，超过边界清理且迟到消息不复活', async () => {
    const { viewer, source, clock, bus } = setup();
    await enter(viewer);
    // 模拟对端崩溃，只切断其发送，不走正常 leave。
    const remote = [...bus.ports][1];
    remote.postMessage = () => {};
    clock.advance(15000);
    expect(source.getSnapshot().members).toHaveLength(2);
    clock.advance(1000);
    expect(source.getSnapshot().members).toHaveLength(1);
    bus.inject(envelope('viewer', 900, 'heartbeat'));
    expect(source.getSnapshot().members).toHaveLength(1);
  });

  it('源超时关闭本次参与，保留色表但所有光标清空', async () => {
    const { viewer, clock, bus } = setup();
    await enter(viewer);
    [...bus.ports][0].postMessage = () => {};
    clock.advance(16000);
    expect(viewer.getSnapshot()).toMatchObject({ phase: 'closed', error: 'source_closed' });
    expect(viewer.getSnapshot().members).toHaveLength(0);
    expect(viewer.getSnapshot().color_registry.assignments).toHaveLength(2);
  });

  it('20 秒请求边界及迟到 state 失效，未关闭的显式重试使用更大 seq', async () => {
    const clock = new Clock();
    const bus = new Bus();
    const viewer = new LocalParticipationService({
      identity: identity('viewer', 'bob'),
      channel: bus.port(),
      clock,
    });
    const first = viewer.join('loading');
    const failure = expect(first).rejects.toThrow('join_timeout');
    clock.advance(19999);
    expect(viewer.getSnapshot().error).toBeNull();
    clock.advance(1);
    await failure;
    const second = viewer.join('loading');
    bus.inject(ready(1));
    expect(viewer.getSnapshot().source_participant_id).toBeNull();
    bus.inject(ready(2, 'loading', 2));
    await expect(second).resolves.toMatchObject({ batch_id: 'batch' });
    expect(viewer.getSnapshot().source_participant_id).toBe('source');
  });

  it('精确 target/reply、同任务同源、版本、结构、自身回声与旧 seq 过滤', async () => {
    const { viewer, bus } = setup();
    await enter(viewer);
    const before = viewer.getSnapshot();
    const invalid = [
      envelope('source', 100, 'cursor', { cursor, task_id: 'other' }),
      envelope('source', 100, 'cursor', { cursor, source_participant_id: 'old' }),
      envelope('source', 100, 'cursor', { cursor, protocol_version: 2 }),
      envelope('viewer', 100, 'cursor', { cursor }),
      envelope('source', 100, 'cursor', { cursor, token: 'secret' }),
      envelope('source', 100, 'cursor', { cursor: { ...cursor, row: Infinity } }),
      envelope('source', 100, 'cursor', { cursor: { ...cursor, frame_number: 0 } }),
      envelope('source', 100, 'cursor', { cursor: { ...cursor, row: -1 } }),
      envelope('source', 100, 'state', { ...ready(100), target_participant_id: 'wrong' }),
      null,
      [],
      { kind: 'heartbeat' },
    ];
    invalid.forEach(value => bus.inject(value));
    expect(viewer.getSnapshot()).toEqual(before);
    bus.inject(envelope('source', 100, 'cursor', { cursor }));
    bus.inject(envelope('source', 99, 'cursor', { cursor: null }));
    expect(viewer.getSnapshot().members[0].cursor).toEqual(cursor);
  });

  it('快照不覆盖更大 cursor_seq，也不把 cursor_seq 写成 last_seq', async () => {
    const clock = new Clock();
    const bus = new Bus();
    const viewer = new LocalParticipationService({
      identity: identity('viewer', 'bob'),
      channel: bus.port(),
      clock,
    });
    let pending = viewer.join('loading');
    bus.inject(ready(1));
    await pending;
    pending = viewer.join('active');
    bus.inject(ready(2, 'active', 2));
    await pending;
    bus.inject(envelope('source', 10, 'cursor', { cursor }));
    pending = viewer.join('active');
    const replySeq = bus.messages.filter(m => m.kind === 'join').slice(-1)[0].seq;
    const snapshot = ready(replySeq, 'active', 11);
    bus.inject({
      ...snapshot,
      members: snapshot.members.map(m =>
        m.role === 'source' ? { ...m, cursor_seq: 4, cursor: null } : m
      ),
    });
    await pending;
    expect(viewer.getSnapshot().members[0].cursor_seq).toBe(10);
    bus.inject(envelope('source', 12, 'heartbeat'));
    expect(viewer.getSnapshot().members[0].cursor_seq).toBe(10);
  });

  it('active 确认缺色安全关闭，运行中冲突保留原登记并隐藏箭头', async () => {
    const clock = new Clock();
    const bus = new Bus();
    const viewer = new LocalParticipationService({
      identity: identity('viewer', 'bob'),
      channel: bus.port(),
      clock,
    });
    let pending = viewer.join('loading');
    bus.inject(ready(1));
    await pending;
    pending = viewer.join('active');
    const failure = expect(pending).rejects.toThrow('invalid_state');
    bus.inject(ready(2, 'loading', 2));
    await failure;
    expect(viewer.getSnapshot().phase).toBe('closed');
    const pair = setup();
    await enter(pair.viewer);
    pair.bus.inject(envelope('source', 20, 'cursor', { cursor }));
    const previous = pair.viewer.getSnapshot().color_registry;
    pair.verifier.verify.mockImplementation(() => new Promise(() => {}));
    pending = pair.viewer.join('active');
    const rejection = expect(pending).rejects.toThrow('invalid_state');
    const request = pair.bus.messages.filter(m => m.kind === 'join').slice(-1)[0];
    const bad = ready(request.seq, 'active', 21);
    pair.bus.inject({ ...bad, color_registry: { ...bad.color_registry, assignments: [] } });
    await rejection;
    expect(pair.viewer.getSnapshot().color_registry).toEqual(previous);
    expect(pair.viewer.getSnapshot().members.every(m => m.cursor === null)).toBe(true);
  });

  it('缓存尚未 ready 或复核网络失败均不放行且不关闭 A 原身份', async () => {
    const { viewer, context, verifier, sourceIdentity } = setup();
    context.setPublication('writing');
    await expect(viewer.join('loading')).rejects.toThrow('not_ready');
    context.setPublication('ready');
    verifier.verify.mockRejectedValue(new Error('网络故障'));
    await expect(viewer.join('loading')).rejects.toThrow('not_ready');
    expect(sourceIdentity.isCurrent()).toBe(true);
  });

  it('异步复核晚完成、候选取消及旧 cleanup 不能创建成员或泄漏资源', async () => {
    const { viewer, source, verifier, bus, clock } = setup();
    let resolve;
    verifier.verify.mockImplementation(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const pending = viewer.join('loading');
    const failure = expect(pending).rejects.toThrow();
    await tick();
    viewer.close();
    source.close();
    resolve(true);
    await tick();
    await failure;
    expect(source.getSnapshot().members).toHaveLength(0);
    expect(bus.messages.filter(m => m.kind === 'state')).toHaveLength(0);
    source.close();
    source.close();
    expect(bus.ports.size).toBe(0);
    expect(clock.timers.size).toBe(0);
  });

  it('源关闭与自身身份失效给出独立结束信号，注销后不能重用实例', async () => {
    const pair = setup();
    await enter(pair.viewer);
    pair.viewer.identity.close('identity_invalid');
    pair.source.close('source_invalid');
    expect(pair.viewer.getSnapshot()).toMatchObject({ phase: 'closed', error: 'identity_invalid' });
    await expect(pair.viewer.join('loading')).rejects.toThrow();
    pair.viewer.sendCursor(cursor);
    const next = setup();
    await enter(next.viewer);
    next.source.close();
    expect(next.viewer.getSnapshot()).toMatchObject({ phase: 'closed', error: 'source_closed' });
  });

  it('active 复核期间的新心跳与光标不取消确认，也不回退已有样本', async () => {
    const { viewer, source, verifier, clock } = setup();
    await enter(viewer);
    let resolve;
    verifier.verify.mockImplementation(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const pending = viewer.join('active');
    await tick();
    viewer.setViewReady(true);
    viewer.sendCursor(cursor);
    clock.advance(2000);
    resolve(true);
    await tick();
    expect(source.getSnapshot().members[1].cursor).toEqual(cursor);
    expect(viewer.getSnapshot().error).toBeNull();
    await expect(pending).resolves.toMatchObject({ result: 'ready' });
  });

  it('已知源的 loading 候选取消形成墓碑，不耗色且后续 active 无法复活', async () => {
    const { viewer, source, bus } = setup();
    await viewer.join('loading');
    viewer.close();
    bus.inject(
      envelope('viewer', 100, 'join', {
        join_phase: 'active',
        user: { uid: 'bob', username: 'bob' },
      })
    );
    await tick();
    expect(source.getSnapshot().members).toHaveLength(1);
    expect(source.getSnapshot().color_registry.revision).toBe(1);
  });

  it('超过失联阈值的迟到消息不能利用清扫间隔复活源', async () => {
    const clock = new Clock();
    const bus = new Bus();
    const viewer = new LocalParticipationService({
      identity: identity('viewer', 'bob'),
      channel: bus.port(),
      clock,
    });
    const pending = viewer.join('loading');
    bus.inject(ready(1));
    await pending;
    clock.advance(15001);
    bus.inject(envelope('source', 100, 'heartbeat'));
    expect(viewer.getSnapshot()).toMatchObject({ phase: 'closed', error: 'source_closed' });
  });

  it('异常频道写入、重复关闭和订阅退出都释放自身资源', async () => {
    const pair = setup();
    await enter(pair.viewer);
    const listener = jest.fn();
    const unsubscribe = pair.source.subscribe(listener);
    pair.source.setViewReady(true);
    pair.source.sendCursor(cursor);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    pair.source.setViewReady(false);
    expect(pair.viewer.getSnapshot().members[0].cursor).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    [...pair.bus.ports][0].postMessage = () => {
      throw new Error('频道已关闭');
    };
    pair.clock.advance(2000);
    expect(pair.source.getSnapshot().phase).toBe('closed');
    pair.viewer.close();
    expect(pair.clock.timers.size).toBe(0);
    const clock = new Clock();
    const bus = new Bus();
    const channel = bus.port();
    const viewer = new LocalParticipationService({
      identity: identity('viewer', 'bob'),
      channel,
      clock,
    });
    channel.postMessage = () => {
      throw new Error('频道不可用');
    };
    await expect(viewer.join('loading')).rejects.toThrow('channel_unavailable');
    expect(clock.timers.size).toBe(0);
  });

  it('重复握手取消旧 pending；源复核 false 与坏缓存均不给 ready', async () => {
    const clock = new Clock();
    const bus = new Bus();
    const viewer = new LocalParticipationService({
      identity: identity('viewer', 'bob'),
      channel: bus.port(),
      clock,
    });
    const first = viewer.join('loading');
    const rejected = expect(first).rejects.toThrow('join_replaced');
    const second = viewer.join('loading');
    bus.inject(ready(2));
    await rejected;
    await second;
    viewer.close();
    const pair = setup();
    pair.verifier.verify.mockResolvedValue(false);
    await expect(pair.viewer.join('loading')).rejects.toThrow('not_ready');
    const snapshot = pair.context.getSnapshot();
    pair.context.getSnapshot = () => ({
      ...snapshot,
      manifest: { ...snapshot.manifest, batch_id: 'wrong' },
    });
    await expect(pair.viewer.join('loading')).rejects.toThrow('cache_invalid');
  });

  it('终结 leave 可在身份刚失效但尚未关闭时发出，普通消息仍被拒绝', async () => {
    const pair = setup();
    await enter(pair.viewer);
    pair.sourceIdentity.isCurrent = () => false;
    pair.source.sendCursor(cursor);
    pair.source.close('identity_invalid');
    expect(pair.viewer.getSnapshot()).toMatchObject({ phase: 'closed', error: 'source_closed' });
    expect(pair.bus.messages.slice(-1)[0]).toMatchObject({
      kind: 'leave',
      reason: 'identity_invalid',
    });
  });

  it('同凭据入口复核的短暂不可用暂停普通消息，恢复后沿用原实例和心跳', async () => {
    const pair = setup();
    await enter(pair.viewer);
    pair.source.setViewReady(true);
    pair.source.sendCursor(cursor);
    const originalCurrent = pair.sourceIdentity.isCurrent;
    const oldId = pair.sourceIdentity.participant_id;
    pair.context.isCurrent = () => pair.sourceIdentity.isCurrent();
    pair.sourceIdentity.isCurrent = () => false;
    pair.context.setViewReady(false);
    pair.clock.advance(3000);
    expect(pair.source.getSnapshot().phase).toBe('active');
    expect(pair.source.getSnapshot().members[0].cursor).toBeNull();
    expect(pair.sourceIdentity.participant_id).toBe(oldId);
    pair.sourceIdentity.isCurrent = originalCurrent;
    pair.clock.advance(1000);
    const sourceHeartbeats = pair.bus.messages.filter(
      m => m.participant_id === oldId && m.kind === 'heartbeat'
    );
    expect(sourceHeartbeats).toHaveLength(2);
    expect(pair.viewer.getSnapshot().phase).toBe('active');
    expect(pair.viewer.getSnapshot().members[0].cursor).toBeNull();
    pair.source.close();
    expect(pair.clock.timers.size).toBe(0);
  });

  it.each(['source', 'viewer'] as const)(
    '%s在短暂不可用时隐藏，取消排队旧点并在恢复后补发null，不改变view_ready',
    async role => {
      const pair = setup();
      await enter(pair.viewer);
      const sender = role === 'source' ? pair.source : pair.viewer;
      const receiver = role === 'source' ? pair.viewer : pair.source;
      sender.setViewReady(true);
      sender.sendCursor(cursor);
      sender.sendCursor({ ...cursor, column: 6 });
      const start = pair.bus.messages.length;
      const current = sender.identity.isCurrent;
      sender.identity.isCurrent = () => false;
      sender.sendCursor(null);
      pair.clock.advance(20);
      expect(
        pair.bus.messages
          .slice(start)
          .filter(message => message.participant_id === sender.identity.participant_id)
      ).toHaveLength(0);
      sender.identity.isCurrent = current;
      pair.clock.advance(1980);
      const sent = pair.bus.messages
        .slice(start)
        .filter(
          message =>
            message.participant_id === sender.identity.participant_id && message.kind === 'cursor'
        );
      expect({
        own: sender
          .getSnapshot()
          .members.find(member => member.participant_id === sender.identity.participant_id).cursor,
        remote: receiver
          .getSnapshot()
          .members.find(member => member.participant_id === sender.identity.participant_id).cursor,
        sent,
      }).toMatchObject({ own: null, remote: null, sent: [{ kind: 'cursor', cursor: null }] });
      if (role === 'source') {
        expect(pair.context.getSnapshot().view_ready).toBe(true);
      }
      sender.close();
      receiver.close();
      expect(pair.clock.timers.size).toBe(0);
    }
  );

  it('不可用期间隐藏立即清本地样本，持续暂停不发普通消息，关闭后不复活', async () => {
    const pair = setup();
    await enter(pair.viewer);
    pair.source.setViewReady(true);
    pair.source.sendCursor(cursor);
    pair.source.sendCursor({ ...cursor, column: 7 });
    const start = pair.bus.messages.length;
    const current = pair.sourceIdentity.isCurrent;
    pair.sourceIdentity.isCurrent = () => false;
    pair.source.sendCursor(null);
    pair.clock.advance(3000);
    expect(
      pair.bus.messages.slice(start).filter(message => message.participant_id === 'source')
    ).toHaveLength(0);
    expect(pair.source.getSnapshot().members[0].cursor).toBeNull();
    pair.source.close('identity_invalid');
    const closedCount = pair.bus.messages.length;
    pair.sourceIdentity.isCurrent = current;
    pair.source.sendCursor(cursor);
    pair.source.sendCursor(null);
    pair.clock.advance(5000);
    expect(pair.source.getSnapshot().phase).toBe('closed');
    expect(pair.viewer.getSnapshot().phase).toBe('closed');
    expect(pair.bus.messages).toHaveLength(closedCount);
    expect(pair.clock.timers.size).toBe(0);
  });
});
