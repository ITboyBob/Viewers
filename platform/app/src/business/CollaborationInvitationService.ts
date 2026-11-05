import type {
  BusinessApi,
  CollaborationAcceptance,
  CollaborationInvitation,
  CollaborationInvitationApi,
  CollaborationPermission,
} from '@ohif/core';
import { BusinessApiError } from './BusinessApiClient';

const invalid = () => new BusinessApiError(502, 'INVALID_RESPONSE', '工作台协作响应不完整');
/** 不创建本地授权；列表、发送及决定全部以当前登录账号的真实后端记录为准。 */
export class CollaborationInvitationService implements CollaborationInvitationApi {
  constructor(private readonly api: BusinessApi) {}
  send(
    taskId: string,
    username: string,
    permission: CollaborationPermission,
    signal?: AbortSignal
  ) {
    if (!username.trim() || !['edit', 'view'].includes(permission)) {
      return Promise.reject(
        new BusinessApiError(422, 'VALIDATION_ERROR', '请输入用户名并选择有效权限')
      );
    }
    return this.api.request<CollaborationInvitation>(
      `/tasks/${encodeURIComponent(taskId)}/collaboration-invitations`,
      {
        method: 'POST',
        body: { username: username.trim(), permission },
        signal,
      }
    );
  }
  async listSent(taskId: string, signal?: AbortSignal) {
    type Page = {
      data: CollaborationInvitation[];
      meta: { page: number; page_size: number; total: number; server_time: string };
    };
    let previous = '';
    for (let round = 0; round < 3; round++) {
      const records = new Map<string, CollaborationInvitation>();
      let total: number | undefined,
        server_time = '',
        changed = false;
      for (let page = 1; ; page++) {
        const value = await this.api.request<Page>(
          `/tasks/${encodeURIComponent(taskId)}/collaboration-invitations/sent?page=${page}&page_size=100`,
          { responseType: 'page', signal }
        );
        const meta = value?.meta;
        if (
          !Array.isArray(value?.data) ||
          !meta ||
          meta.page !== page ||
          meta.page_size !== 100 ||
          !Number.isSafeInteger(meta.total) ||
          meta.total < 0 ||
          !Number.isFinite(Date.parse(meta.server_time))
        ) {
          throw invalid();
        }
        if (total !== undefined && total !== meta.total) {
          changed = true;
        }
        total ??= meta.total;
        server_time = meta.server_time;
        for (const item of value.data) {
          if (
            !item?.invitation_id ||
            item.task_id !== taskId ||
            !item.invitee?.uid ||
            !item.invitee.username ||
            !Number.isFinite(Date.parse(item.expires_at)) ||
            !Number.isFinite(Date.parse(item.created_at))
          ) {
            throw invalid();
          }
          if (records.has(item.invitation_id)) {
            changed = true;
          }
          records.set(item.invitation_id, item);
        }
        if (page * 100 >= total || value.data.length < 100) {
          break;
        }
      }
      if (records.size !== total) {
        changed = true;
      }
      const data = [...records.values()],
        signature = JSON.stringify(data.map(item => [item.invitation_id, item.expires_at]).sort());
      if (!changed && (total! <= 100 || signature === previous)) {
        return { data, server_time };
      }
      previous = changed ? '' : signature;
    }
    throw new BusinessApiError(409, 'INVITATION_LIST_CHANGED', '邀请记录正在变化，请重试读取');
  }
  async listNotifications(signal?: AbortSignal): Promise<CollaborationInvitation[]> {
    const result: CollaborationInvitation[] = [];
    for (let page = 1; ; page++) {
      const items = await this.api.request<CollaborationInvitation[]>(
        `/notifications/collaboration-invitations?page=${page}&page_size=100`,
        { signal }
      );
      if (!Array.isArray(items)) {
        throw invalid();
      }
      result.push(...items);
      if (items.length < 100) {
        return result;
      }
    }
  }
  async unreadCount(signal?: AbortSignal) {
    return this.count(
      await this.api.request<{ unread_count: number }>(
        '/notifications/collaboration-invitations/unread-count',
        { signal }
      )
    );
  }
  async markRead(ids: string[], signal?: AbortSignal) {
    return this.count(
      await this.api.request<{ unread_count: number }>(
        '/notifications/collaboration-invitations/read',
        { method: 'POST', body: { invitation_ids: ids }, signal }
      )
    );
  }
  private count(value: { unread_count: number }) {
    if (!Number.isSafeInteger(value?.unread_count) || value.unread_count < 0) {
      throw invalid();
    }
    return value.unread_count;
  }
  async accept(id: string, signal?: AbortSignal) {
    const value = await this.api.request<CollaborationAcceptance>(
      `/collaboration-invitations/${encodeURIComponent(id)}/accept`,
      { method: 'POST', signal }
    );
    if (
      !value?.task_id ||
      value.invitation?.task_id !== value.task_id ||
      value.invitation.decision !== 'accepted' ||
      !['segmentation/dicomlocal', 'microscopy'].includes(value.mode_path)
    ) {
      throw invalid();
    }
    return value;
  }
  reject(id: string, signal?: AbortSignal) {
    return this.api.request<CollaborationInvitation>(
      `/collaboration-invitations/${encodeURIComponent(id)}/reject`,
      { method: 'POST', signal }
    );
  }
}
