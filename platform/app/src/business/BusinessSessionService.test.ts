import { createBusinessServices } from './createBusinessServices';
jest.mock('@ohif/core', () => ({ useSystem: jest.fn() }), { virtual: true });

const context = (username = 'alice') => ({
  user: { uid: username, username, avatar_url: null },
  expires_at: '2026-11-02T00:00:00Z',
  default_team_id: username + '-team',
  memberships: [{ team_id: username + '-team', name: '团队', owner_uid: username, role: 'owner' }],
});
const response = (status: number, data: unknown) =>
  ({
    ok: status < 300,
    status,
    json: () =>
      Promise.resolve(
        status < 300 ? { data } : { error: { code: 'UNAUTHORIZED', message: '认证失效' } }
      ),
  }) as Response;
const issued = (username = 'alice') => ({ ...context(username), token: username + '-token' });
const key = 'colla.phaseOne.session';

beforeEach(() => sessionStorage.clear());

test('登录与注册使用同一真实API边界，身份快照不泄露凭据', async () => {
  const transport = jest
    .fn()
    .mockResolvedValueOnce(response(201, issued()))
    .mockResolvedValueOnce(response(201, issued('bob')));
  const { session } = createBusinessServices(
    { enabled: true },
    { fetch: transport, storage: sessionStorage }
  );
  const listener = jest.fn();
  const unsubscribe = session.subscribe(listener);
  await session.login({ username: 'alice', password: 'x' });
  expect(session.getSnapshot()).toMatchObject({
    status: 'authenticated',
    currentTeamId: 'alice-team',
    context: context(),
  });
  expect(session.getSnapshot().context).not.toHaveProperty('token');
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
    token: 'alice-token',
    expires_at: context().expires_at,
    current_team_id: 'alice-team',
  });
  await session.register({ username: 'bob', password: 'x' });
  expect(transport.mock.calls.map(call => call[0])).toEqual([
    '/api/v1/auth/sessions',
    '/api/v1/users',
  ]);
  expect(listener).toHaveBeenCalled();
  unsubscribe();
  const count = listener.mock.calls.length;
  session.invalidate();
  expect(listener).toHaveBeenCalledTimes(count);
});

test('刷新只有候选凭据，服务端current确认后才认证，仍有效的团队候选保留', async () => {
  sessionStorage.setItem(
    key,
    JSON.stringify({
      token: 'stored',
      expires_at: context().expires_at,
      current_team_id: 'joined-team',
    })
  );
  const current = {
    ...context(),
    memberships: [
      ...context().memberships,
      { team_id: 'joined-team', name: '其他团队', owner_uid: 'other', role: 'annotator' },
    ],
  };
  const transport = jest.fn().mockResolvedValue(response(200, current));
  const { session } = createBusinessServices(
    { enabled: true },
    { fetch: transport, storage: sessionStorage }
  );
  expect(session.getSnapshot().status).toBe('unknown');
  expect(session.getSnapshot().context).toBeNull();
  await session.validateCurrent();
  expect(transport).toHaveBeenCalledWith('/api/v1/auth/sessions/current', expect.anything());
  expect(session.getSnapshot().currentTeamId).toBe('joined-team');
});

test('失效团队候选退回默认团队，未经服务器确认的身份不从存储恢复', async () => {
  sessionStorage.setItem(
    key,
    JSON.stringify({
      token: 'stored',
      expires_at: context().expires_at,
      current_team_id: 'forged-team',
      context: context('forged'),
    })
  );
  const { session } = createBusinessServices(
    { enabled: true },
    { fetch: jest.fn().mockResolvedValue(response(200, context())), storage: sessionStorage }
  );
  await session.validateCurrent();
  expect(session.getSnapshot().currentTeamId).toBe('alice-team');
  expect(session.getSnapshot().context?.user.uid).toBe('alice');
});

test('401清理身份与当前团队，403和网络故障不删除候选凭据也不放行', async () => {
  sessionStorage.setItem(
    key,
    JSON.stringify({
      token: 'stored',
      expires_at: context().expires_at,
      current_team_id: 'alice-team',
    })
  );
  const transport = jest
    .fn()
    .mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValueOnce(response(403, null))
    .mockResolvedValueOnce(response(401, null));
  const { session } = createBusinessServices(
    { enabled: true },
    { fetch: transport, storage: sessionStorage }
  );
  await session.validateCurrent();
  expect(session.getSnapshot().status).toBe('error');
  expect(sessionStorage.getItem(key)).not.toBeNull();
  await session.validateCurrent();
  expect(session.getSnapshot().status).toBe('error');
  expect(sessionStorage.getItem(key)).not.toBeNull();
  await session.validateCurrent();
  expect(session.getSnapshot()).toMatchObject({
    status: 'invalid',
    context: null,
    currentTeamId: null,
  });
  expect(sessionStorage.getItem(key)).toBeNull();
});

test('迟到current成功不能复活已失效身份，较旧账号响应不能覆盖新账号', async () => {
  sessionStorage.setItem(
    key,
    JSON.stringify({
      token: 'stored',
      expires_at: context().expires_at,
      current_team_id: 'alice-team',
    })
  );
  let complete: (response: Response) => void;
  const transport = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          complete = resolve;
        })
    )
    .mockResolvedValueOnce(response(201, issued('bob')));
  const { session } = createBusinessServices(
    { enabled: true },
    { fetch: transport, storage: sessionStorage }
  );
  const pending = session.validateCurrent();
  await session.login({ username: 'bob', password: 'x' });
  complete!(response(200, context()));
  await pending;
  expect(session.getSnapshot().context?.user.uid).toBe('bob');
  let late: (response: Response) => void;
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>(resolve => {
        late = resolve;
      })
  );
  const second = session.validateCurrent();
  session.invalidate();
  late!(response(200, context()));
  await second;
  expect(session.getSnapshot().status).toBe('invalid');
});

test('旧current的401不能取消仍在等待的新登录，即使Token尚未替换', async () => {
  sessionStorage.setItem(
    key,
    JSON.stringify({
      token: 'stored',
      expires_at: context().expires_at,
      current_team_id: 'alice-team',
    })
  );
  let currentDone: (r: Response) => void, loginDone: (r: Response) => void;
  const transport = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          currentDone = resolve;
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          loginDone = resolve;
        })
    );
  const { session } = createBusinessServices(
    { enabled: true },
    { fetch: transport, storage: sessionStorage }
  );
  const current = session.validateCurrent();
  const login = session.login({ username: 'bob', password: 'x' });
  currentDone!(response(401, null));
  await current;
  loginDone!(response(201, issued('bob')));
  await login;
  expect(session.getSnapshot().context?.user.uid).toBe('bob');
});

test('损坏存储和无凭据不调用current，OIDC键不受影响，禁用存储可继续内存会话', async () => {
  sessionStorage.setItem(key, '{');
  sessionStorage.setItem('oidc.user', 'untouched');
  const transport = jest.fn().mockResolvedValue(response(201, issued()));
  const { session } = createBusinessServices(
    { enabled: true },
    { fetch: transport, storage: sessionStorage }
  );
  await session.validateCurrent();
  expect(session.getSnapshot().status).toBe('invalid');
  expect(transport).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('oidc.user')).toBe('untouched');
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  } as unknown as Storage;
  const inMemory = createBusinessServices(
    { enabled: true },
    { fetch: transport, storage: broken }
  ).session;
  await inMemory.login({ username: 'alice', password: 'x' });
  expect(inMemory.getSnapshot().status).toBe('authenticated');
  inMemory.invalidate();
});

test.each([null, {}, { ...issued(), token: '' }, { ...issued(), user: null }])(
  '成功状态但身份响应损坏也不得冒充登录成功（%#）',
  async payload => {
    const { session } = createBusinessServices(
      { enabled: true },
      {
        fetch: jest.fn().mockResolvedValue(response(201, payload)),
        storage: sessionStorage,
      }
    );
    await expect(session.login({ username: 'alice', password: 'x' })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(session.getSnapshot()).toMatchObject({
      status: 'error',
      context: null,
      currentTeamId: null,
    });
    expect(sessionStorage.getItem(key)).toBeNull();
  }
);

test.each([
  null,
  {},
  { ...context(), user: null },
  { ...context(), memberships: null },
  { ...context(), memberships: [] },
  { ...context(), expires_at: 'not-a-date' },
  { ...context(), memberships: [{ ...context().memberships[0], role: 'admin' }] },
  { ...context(), default_team_id: 'not-a-member' },
])('刷新收到不完整或非法上下文必须拒绝放行（%#）', async payload => {
  sessionStorage.setItem(
    key,
    JSON.stringify({ token: 'stored', expires_at: context().expires_at })
  );
  const { session } = createBusinessServices(
    { enabled: true },
    {
      fetch: jest.fn().mockResolvedValue(response(200, payload)),
      storage: sessionStorage,
    }
  );
  await session.validateCurrent();
  expect(session.getSnapshot()).toMatchObject({
    status: 'error',
    context: null,
    currentTeamId: null,
    error: { code: 'INVALID_RESPONSE' },
  });
});

test.each([
  [true, []],
  [false, []],
  [false, { ...context(), user: { ...context().user, uid: '' } }],
  [false, { ...context(), user: { ...context().user, avatar_url: 25 } }],
  [false, { ...context(), memberships: [null] }],
  [false, { ...context(), memberships: [{ ...context().memberships[0], name: '' }] }],
])('拒绝数组、空身份字段及非法成员形状（%#）', async (authenticate, payload) => {
  if (!authenticate) {
    sessionStorage.setItem(
      key,
      JSON.stringify({ token: 'stored', expires_at: context().expires_at })
    );
  }
  const { session } = createBusinessServices(
    { enabled: true },
    {
      fetch: jest.fn().mockResolvedValue(response(authenticate ? 201 : 200, payload)),
      storage: sessionStorage,
    }
  );
  if (authenticate) {
    await expect(session.login({ username: 'alice', password: 'x' })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  } else {
    await session.validateCurrent();
  }
  expect(session.getSnapshot()).toMatchObject({
    status: 'error',
    context: null,
    currentTeamId: null,
  });
});

test('服务端额外返回的凭据或内部字段不进入公开快照，合法头像可保留', async () => {
  sessionStorage.setItem(
    key,
    JSON.stringify({ token: 'stored', expires_at: context().expires_at })
  );
  const projected = {
    ...context(),
    token: 'unexpected-field',
    user: {
      ...context().user,
      avatar_url: '/avatars/synthetic.svg',
      password_hash: 'unexpected-field',
    },
  };
  const { session } = createBusinessServices(
    { enabled: true },
    {
      fetch: jest.fn().mockResolvedValue(response(200, projected)),
      storage: sessionStorage,
    }
  );
  await session.validateCurrent();
  const snapshot = session.getSnapshot();
  expect(snapshot.status).toBe('authenticated');
  expect(snapshot.context?.user.avatar_url).toBe('/avatars/synthetic.svg');
  expect(Object.hasOwn(snapshot.context!, 'token')).toBe(false);
  expect(Object.hasOwn(snapshot.context!.user, 'password_hash')).toBe(false);
});

test('注销使用原凭证立即请求DELETE并同步清本地；晚到失败不能清除新登录', async () => {
  let rejectLogout!: (error: Error) => void;
  const transport = jest
    .fn()
    .mockResolvedValueOnce(response(201, issued()))
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLogout = reject;
        })
    )
    .mockResolvedValueOnce(response(201, issued('bob')));
  const { session } = createBusinessServices(
    { enabled: true },
    { fetch: transport, storage: sessionStorage }
  );
  await session.login({ username: 'alice', password: 'x' });
  const pending = session.logout();
  const failure = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  expect(transport.mock.calls[1][1]).toMatchObject({
    method: 'DELETE',
    headers: { Authorization: 'Bearer alice-token' },
  });
  expect(session.getSnapshot().status).toBe('invalid');
  expect(sessionStorage.getItem(key)).toBeNull();
  await session.login({ username: 'bob', password: 'x' });
  rejectLogout(new Error('synthetic network failure'));
  await failure;
  expect(session.getSnapshot().context?.user.uid).toBe('bob');
});
