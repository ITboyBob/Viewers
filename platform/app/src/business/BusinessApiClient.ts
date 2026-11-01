import type { BusinessApi, BusinessApiFailure, BusinessRequestOptions } from '@ohif/core';

export class BusinessApiError extends Error implements BusinessApiFailure {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public reason?: string
  ) {
    super(message);
    this.name = 'BusinessApiError';
  }
}

type ClientOptions = {
  fetch?: typeof fetch;
  getToken?: () => string | null;
  getRevision?: () => number;
  onUnauthorized?: () => void;
  timeoutMs?: number;
};

export class BusinessApiClient implements BusinessApi {
  constructor(private readonly options: ClientOptions = {}) {}

  async request<T>(path: string, options: BusinessRequestOptions = {}): Promise<T> {
    // 只接受业务域内的相对资源路径，防止把凭据带到 OIDC／PACS／其他站点。
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('\\') ||
      /%2f|%5c/i.test(path.split('?')[0])
    ) {
      throw new BusinessApiError(0, 'INVALID_PATH', '只允许请求业务接口');
    }
    const url = new URL('/api/v1' + path, 'https://phase-one.invalid');
    if (!url.pathname.startsWith('/api/v1/')) {
      throw new BusinessApiError(0, 'INVALID_PATH', '只允许请求业务接口');
    }
    if (
      options.idempotencyKey !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        options.idempotencyKey
      )
    ) {
      throw new BusinessApiError(422, 'INVALID_KEY', '登记键格式无效');
    }
    if (options.signal?.aborted) {
      throw new BusinessApiError(0, 'CANCELLED', '请求已取消');
    }

    const token = this.options.getToken?.() ?? null;
    const revision = this.options.getRevision?.() ?? 0;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (options.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? 15000);
    try {
      const transport = this.options.fetch ?? globalThis.fetch.bind(globalThis);
      const response = await transport(url.pathname + url.search, {
        method: options.method ?? 'GET',
        headers,
        credentials: 'omit',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      if (
        response.status === 401 &&
        token === (this.options.getToken?.() ?? null) &&
        revision === (this.options.getRevision?.() ?? 0)
      ) {
        this.options.onUnauthorized?.();
      }
      if (response.status === 204 && response.ok) {
        return undefined as T;
      }
      const data: unknown = await response.json().catch(() => {
        throw new BusinessApiError(response.status, 'INVALID_RESPONSE', '服务响应无法解析，请重试');
      });
      const payload =
        data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      if (!response.ok) {
        const detail =
          payload.error && typeof payload.error === 'object'
            ? (payload.error as Record<string, unknown>)
            : {};
        const reasons =
          detail.details && typeof detail.details === 'object'
            ? (detail.details as Record<string, unknown>)
            : {};
        throw new BusinessApiError(
          response.status,
          typeof detail.code === 'string' ? detail.code : 'HTTP_ERROR',
          typeof detail.message === 'string' ? detail.message : '请求失败，请重试',
          typeof reasons.reason === 'string' ? reasons.reason : undefined
        );
      }
      if (!Object.prototype.hasOwnProperty.call(payload, 'data')) {
        throw new BusinessApiError(502, 'INVALID_RESPONSE', '服务响应不符合业务契约');
      }
      return payload.data as T;
    } catch (error) {
      if (error instanceof BusinessApiError) {
        throw error;
      }
      if (timedOut) {
        throw new BusinessApiError(0, 'TIMEOUT', '请求超时，请重试');
      }
      if (controller.signal.aborted) {
        throw new BusinessApiError(0, 'CANCELLED', '请求已取消');
      }
      throw new BusinessApiError(0, 'NETWORK_ERROR', '无法连接服务，请重试');
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
}
