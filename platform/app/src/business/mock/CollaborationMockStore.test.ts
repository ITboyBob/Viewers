import { CollaborationMockStore } from './CollaborationMockStore';

const user = { uid: 'real-owner', username: 'owner', avatar_url: null };
let now: number;
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}
function setup() {
  const disk = storage();
  return { disk, store: new CollaborationMockStore(user, disk, () => now) };
}
beforeEach(() => {
  now = 1000000;
});

test('只包含明确合成的已注册用户名和团队成员，记录有独立 kind 与 mock_id', () => {
  const { store } = setup();
  expect(store.recipients.every(item => item.synthetic === true)).toBe(true);
  expect(store.recipients.some(item => item.in_team)).toBe(true);
  expect(store.recipients.some(item => !item.in_team)).toBe(true);
  const sent = store.invite('陈晨');
  expect(sent).toMatchObject({
    kind: 'collaboration_mock',
    sender_uid: user.uid,
    recipient_username: '陈晨',
    created_at: now,
    expires_at: now + 300000,
    decision: 'pending',
  });
  expect(sent.mock_id).toBeTruthy();
  expect(sent).not.toHaveProperty('invitation_id');
  expect(sent).not.toHaveProperty('task_id');
});

test.each([0, 299999])('%dms 未到期，同一发起者＋被邀用户拒绝重复', offset => {
  const { store } = setup();
  const first = store.invite('陈晨');
  now += offset;
  expect(store.isInvited('陈晨')).toBe(true);
  expect(() => store.invite('陈晨')).toThrow();
  expect(store.list()[0].expires_at).toBe(first.expires_at);
});

test.each([300000, 300001])('%dms 恰到期／之后恢复邀请，旧通知保留', offset => {
  const { store } = setup();
  const first = store.invite('陈晨');
  now += offset;
  expect(store.isInvited('陈晨')).toBe(false);
  const second = store.invite('陈晨');
  expect(second.mock_id).not.toBe(first.mock_id);
  expect(store.list()).toHaveLength(2);
});

test.each(['accepted', 'rejected'] as const)(
  '%s 只改 decision，不提前解锁，刷新保持原截止',
  decision => {
    const { disk, store } = setup();
    const first = store.invite('陈晨');
    now += 100000;
    const decided = store.decide(first.mock_id, decision);
    expect(decided.expires_at).toBe(first.expires_at);
    const reopened = new CollaborationMockStore(user, disk, () => now);
    expect(reopened.list()[0].decision).toBe(decision);
    expect(reopened.list()[0].expires_at).toBe(first.expires_at);
    expect(reopened.isInvited('陈晨')).toBe(true);
    now = first.expires_at;
    expect(reopened.isInvited('陈晨')).toBe(false);
    expect(reopened.list()).toHaveLength(1);
  }
);

test('同页刷新不重计时，数据无 team／project／task，恢复 pending', () => {
  const { disk, store } = setup();
  const first = store.invite('陈晨');
  now += 100000;
  const reopened = new CollaborationMockStore({ ...user }, disk, () => now);
  expect(reopened.list()).toEqual([first]);
  const json = disk.setItem.mock.calls[0][1];
  expect(json).not.toMatch(/task_id|project|team_id|token/);
  expect(
    disk.getItem.mock.calls.every(
      call => call[0] === 'colla.phaseOne.collaborationMock.v1.real-owner'
    )
  ).toBe(true);
});

test('发起者、被邀者互相隔离，后续实例发送会原子重读同标签页存储', () => {
  const { disk, store } = setup();
  const anotherInstance = new CollaborationMockStore(user, disk, () => now);
  store.invite('陈晨');
  expect(() => anotherInstance.invite('陈晨')).toThrow();
  expect(() => anotherInstance.invite('李敏')).not.toThrow();
  const anotherUser = new CollaborationMockStore({ ...user, uid: 'other' }, disk, () => now);
  expect(anotherUser.list()).toEqual([]);
  expect(() => anotherUser.invite('陈晨')).not.toThrow();
});

test.each(['owner', '未知用户名', '   '])('拒绝自己／未知合成用户 %p', username => {
  const { store, disk } = setup();
  expect(() => store.invite(username)).toThrow();
  expect(disk.setItem).not.toHaveBeenCalled();
});

test('会话用户名恰好与 fixture 同名，也排除本人，不以不同 uid 绕过', () => {
  const store = new CollaborationMockStore({ ...user, username: '陈晨' }, storage(), () => now);
  expect(store.recipients.some(item => item.username === '陈晨')).toBe(false);
  expect(() => store.invite('陈晨')).toThrow();
});

test('未到期同决策重试幂等，相反决策／不存在／到期动作失败', () => {
  const { store } = setup();
  const first = store.invite('陈晨');
  expect(() => store.decide('no-such-id', 'accepted')).toThrow();
  store.decide(first.mock_id, 'accepted');
  expect(store.decide(first.mock_id, 'accepted').decision).toBe('accepted');
  expect(() => store.decide(first.mock_id, 'rejected')).toThrow();
  now = first.expires_at;
  expect(() => store.decide(first.mock_id, 'accepted')).toThrow();
  expect(store.list()[0].decision).toBe('accepted');
});

test.each([
  '{',
  'null',
  '[]',
  '{"version":2,"sender_uid":"real-owner","invitations":[]}',
  '{"version":1,"sender_uid":"other","invitations":[]}',
  '{"version":1,"sender_uid":"real-owner","invitations":[{}]}',
])('损坏／错版本／错身份 %p fail-closed，不覆盖旧数据', raw => {
  const disk = storage();
  disk.getItem.mockReturnValue(raw);
  const store = new CollaborationMockStore(user, disk, () => now);
  expect(() => store.list()).toThrow();
  expect(store.getError()).toBeTruthy();
  expect(store.isInvited('陈晨')).toBe(true);
  expect(() => store.invite('陈晨')).toThrow();
  expect(disk.setItem).not.toHaveBeenCalled();
});

test('记录截止时间被改写／重复 ID 都拒绝，不自动重置窗口', () => {
  const { disk, store } = setup();
  store.invite('陈晨');
  const data = JSON.parse(disk.setItem.mock.calls[0][1]);
  data.invitations[0].expires_at++;
  disk.getItem.mockReturnValue(JSON.stringify(data));
  expect(() => new CollaborationMockStore(user, disk, () => now).list()).toThrow();
  data.invitations[0].expires_at--;
  data.invitations.push(data.invitations[0]);
  disk.getItem.mockReturnValue(JSON.stringify(data));
  expect(() => new CollaborationMockStore(user, disk, () => now).list()).toThrow();
});

test('读取存储失败和存储不可用时阻止发送，不静默内存成功', () => {
  const disk = storage();
  disk.getItem.mockImplementation(() => {
    throw new Error('拒绝');
  });
  expect(() => new CollaborationMockStore(user, disk, () => now).invite('陈晨')).toThrow();
  const absent = new CollaborationMockStore(user, null, () => now);
  expect(absent.getError()).toBeTruthy();
  expect(() => absent.invite('陈晨')).toThrow();
});

test('写入失败不报发送成功，内存保持禁用并提示刷新保证丢失', () => {
  const { disk, store } = setup();
  disk.setItem.mockImplementation(() => {
    throw new Error('quota');
  });
  expect(() => store.invite('陈晨')).toThrow(/刷新/);
  expect(store.isInvited('陈晨')).toBe(true);
  expect(store.getError()).toMatch(/刷新/);
  expect(() => store.invite('李敏')).toThrow();
});

test('读取结果不能被外部修改而破坏防重记录', () => {
  const { store } = setup();
  store.invite('陈晨');
  const copy = store.list();
  copy[0].expires_at = now;
  expect(store.isInvited('陈晨')).toBe(true);
});

test('发送、接受、拒绝的所有路径零真实网络／零导航', () => {
  const old = globalThis.fetch;
  const forbidden = jest.fn(() => {
    throw new Error('不允许真实请求');
  });
  globalThis.fetch = forbidden;
  const nav = jest.spyOn(window.history, 'pushState').mockImplementation(() => {
    throw new Error('不允许导航');
  });
  try {
    const { store } = setup();
    store.decide(store.invite('陈晨').mock_id, 'accepted');
    store.decide(store.invite('李敏').mock_id, 'rejected');
    store.list();
    expect(forbidden).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = old;
    nav.mockRestore();
  }
});

test.each([
  { decision: ['accepted'] },
  { recipient_uid: 'no-such-user' },
  { recipient_username: '伪造用户' },
  { sender_uid: 'other' },
  { created_at: null },
  { kind: 'team_join' },
  { mock_id: '' },
])('严格检查记录字段，拒绝结构合法但类型错误的 %p', patch => {
  const { disk, store } = setup();
  store.invite('陈晨');
  const data = JSON.parse(disk.setItem.mock.calls[0][1]);
  Object.assign(data.invitations[0], patch);
  disk.getItem.mockReturnValue(JSON.stringify(data));
  expect(() => new CollaborationMockStore(user, disk, () => now).list()).toThrow();
});

test.each(['missing', 'empty', 'retimed', 'changed-recipient', 'reset-decision'])(
  '已见到的记录被 %s 时 fail-closed，不静默重置五分钟状态',
  scenario => {
    const { disk, store } = setup();
    const record = store.invite('陈晨');
    if (scenario === 'reset-decision') {
      store.decide(record.mock_id, 'accepted');
    }
    const data = JSON.parse(disk.setItem.mock.calls.at(-1)![1]);
    if (scenario === 'missing') {
      disk.getItem.mockReturnValue(null);
    } else {
      if (scenario === 'empty') {
        data.invitations = [];
      }
      if (scenario === 'retimed') {
        data.invitations[0].created_at++;
        data.invitations[0].expires_at++;
      }
      if (scenario === 'changed-recipient') {
        data.invitations[0].recipient_uid = 'synthetic:li';
        data.invitations[0].recipient_username = '李敏';
      }
      if (scenario === 'reset-decision') {
        data.invitations[0].decision = 'pending';
      }
      disk.getItem.mockReturnValue(JSON.stringify(data));
    }
    expect(store.isInvited('陈晨')).toBe(true);
    expect(() => store.list()).toThrow();
  }
);
