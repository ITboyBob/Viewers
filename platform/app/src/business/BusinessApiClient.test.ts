import { BusinessApiClient, BusinessApiError } from './BusinessApiClient';

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('BusinessApiClient', () => {
  test('只向同站点业务命名空间发送凭据，并拆开 data 包裹', async () => {
    const transport = jest.fn().mockResolvedValue(response(200, { data: { uid: 'u' } }));
    const api = new BusinessApiClient({ fetch: transport, getToken: () => 'business-token' });
    await expect(api.request('/auth/sessions/current')).resolves.toEqual({ uid: 'u' });
    expect(transport).toHaveBeenCalledWith(
      '/api/v1/auth/sessions/current',
      expect.objectContaining({
        credentials: 'omit',
        headers: expect.objectContaining({ Authorization: 'Bearer business-token' }),
      })
    );
    for (const path of [
      'https://outside.test',
      '//outside.test',
      '/../outside',
      '/%2e%2e/outside',
      '/a/../../outside',
      '/a\\outside',
    ]) {
      await expect(api.request(path)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('JSON请求、无凭据请求和204均正确处理', async () => {
    const transport = jest.fn().mockResolvedValue(response(204, undefined));
    const api = new BusinessApiClient({ fetch: transport });
    await expect(
      api.request('/auth/sessions/current', { method: 'DELETE' })
    ).resolves.toBeUndefined();
    await api.request('/users', { method: 'POST', body: { username: 'u', password: 'x' } });
    const init = transport.mock.calls[1][1];
    expect(init.body).toBe(JSON.stringify({ username: 'u', password: 'x' }));
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  test('401使当前身份失效，403保留身份，原因由结构化错误传递', async () => {
    const invalidate = jest.fn();
    const transport = jest
      .fn()
      .mockResolvedValueOnce(
        response(403, {
          error: { code: 'FORBIDDEN', message: '没有权限', details: { reason: 'NOT_OWNER' } },
        })
      )
      .mockResolvedValueOnce(
        response(401, { error: { code: 'UNAUTHORIZED', message: '认证失效', details: {} } })
      );
    const api = new BusinessApiClient({
      fetch: transport,
      getToken: () => 'one',
      onUnauthorized: invalidate,
    });
    await expect(api.request('/teams/t')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      reason: 'NOT_OWNER',
    });
    expect(invalidate).not.toHaveBeenCalled();
    await expect(api.request('/auth/sessions/current')).rejects.toBeInstanceOf(BusinessApiError);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  test('旧请求401不能使较新的凭据或认证代次失效', async () => {
    let complete: (value: Response) => void;
    let revision = 0;
    const invalidate = jest.fn();
    const transport = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          complete = resolve;
        })
    );
    const api = new BusinessApiClient({
      fetch: transport,
      getToken: () => 'same-token',
      getRevision: () => revision,
      onUnauthorized: invalidate,
    });
    const pending = api.request('/auth/sessions/current');
    revision++;
    complete!(response(401, { error: { code: 'UNAUTHORIZED' } }));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(invalidate).not.toHaveBeenCalled();
  });

  test('网络失败、无效包裹和无法解析响应不会伪造成功或注销', async () => {
    const invalidate = jest.fn();
    const transport = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(response(200, { wrong: true }))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: () => Promise.reject(new Error('html')),
      })
      .mockResolvedValueOnce(response(500, {}));
    const api = new BusinessApiClient({ fetch: transport, onUnauthorized: invalidate });
    await expect(api.request('/users')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    await expect(api.request('/users')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(api.request('/users')).rejects.toMatchObject({ status: 503 });
    await expect(api.request('/users')).rejects.toMatchObject({ status: 500, code: 'HTTP_ERROR' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  test('超时中止且不重试非幂等写入', async () => {
    jest.useFakeTimers();
    try {
      const transport = jest.fn(
        (url, init) =>
          new Promise<Response>((resolve, reject) =>
            init.signal.addEventListener('abort', () => reject(new Error('abort')))
          )
      );
      const api = new BusinessApiClient({ fetch: transport, timeoutMs: 20 });
      const promise = api.request('/users', { method: 'POST', body: {} });
      const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
      jest.advanceTimersByTime(20);
      await assertion;
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('外部取消和请求前取消不会自动重试', async () => {
    const transport = jest.fn(
      (url, init) =>
        new Promise<Response>((resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('abort')))
        )
    );
    const api = new BusinessApiClient({ fetch: transport });
    const controller = new AbortController();
    const pending = api.request('/users', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(api.request('/users', { signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

test('幂等键通过专用选项发送，不覆盖既有业务凭证，非法键不发送', async () => {
  const transport = jest.fn().mockResolvedValue(response(200, { data: {} }));
  const api = new BusinessApiClient({ fetch: transport, getToken: () => 'business' });
  const key = '00000000-0000-4000-8000-000000000001';
  await api.request('/teams/t/tasks', {
    method: 'POST',
    body: { title: '合成' },
    idempotencyKey: key,
  });
  expect(transport.mock.calls[0][1].headers).toEqual(
    expect.objectContaining({ 'Idempotency-Key': key, Authorization: 'Bearer business' })
  );
  await expect(api.request('/teams/t/tasks', { idempotencyKey: 'bad-key' })).rejects.toMatchObject({
    code: 'INVALID_KEY',
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
