import type {
  BusinessApi,
  SentInvitationDeadline,
  SentInvitationDeadlines,
  InvitationDecision,
  InvitationView,
  MemberView,
  TeamInvitationApi,
} from '@ohif/core';
import { BusinessApiError } from './BusinessApiClient';

/** 只使用集中客户端；列表取全分页，失败不能伪装成已完成成员排除。 */
export class TeamInvitationService implements TeamInvitationApi {
  constructor(private readonly api: BusinessApi) {}

  send(teamId: string, username: string, signal?: AbortSignal): Promise<InvitationView> {
    const value = username.trim();
    if (!value) {
      return Promise.reject(new BusinessApiError(422, 'VALIDATION_ERROR', '请输入对方用户名。'));
    }
    return this.api.request(`/teams/${encodeURIComponent(teamId)}/invitations`, {
      method: 'POST',
      body: { username: value },
      signal,
    });
  }

  decide(
    id: string,
    decision: Exclude<InvitationDecision, 'pending'>,
    signal?: AbortSignal
  ): Promise<InvitationView> {
    return this.api.request(
      `/invitations/${encodeURIComponent(id)}/${decision === 'accepted' ? 'accept' : 'reject'}`,
      {
        method: 'POST',
        signal,
      }
    );
  }

  listMembers(teamId: string, signal?: AbortSignal): Promise<MemberView[]> {
    return this.allPages(`/teams/${encodeURIComponent(teamId)}/members`, signal);
  }

  listNotifications(signal?: AbortSignal): Promise<InvitationView[]> {
    return this.allPages('/notifications/team-invitations', signal);
  }

  async listSent(teamId: string, signal?: AbortSignal): Promise<SentInvitationDeadlines> {
    type Page = {
      data: SentInvitationDeadline[];
      meta: { page: number; page_size: number; total: number; server_time: string };
    };
    let previous = '';
    for (let round = 0; round < 3; round++) {
      const records = new Map<string, SentInvitationDeadline>();
      let total: number | undefined,
        server_time = '',
        changed = false;
      for (let page = 1; ; page++) {
        const value = await this.api.request<Page>(
          `/teams/${encodeURIComponent(teamId)}/invitations/sent?page=${page}&page_size=100`,
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
        )
          throw new BusinessApiError(502, 'INVALID_RESPONSE', '本人邀请期限响应不完整');
        if (total !== undefined && total !== meta.total) changed = true;
        total ??= meta.total;
        server_time = meta.server_time;
        for (const item of value.data) {
          if (
            !item?.invitation_id ||
            item.team_id !== teamId ||
            !item.invitee?.uid ||
            !item.invitee.username ||
            !Number.isFinite(Date.parse(item.created_at)) ||
            !Number.isFinite(Date.parse(item.expires_at))
          )
            throw new BusinessApiError(502, 'INVALID_RESPONSE', '本人邀请期限记录不完整');
          if (records.has(item.invitation_id)) changed = true;
          records.set(item.invitation_id, item);
        }
        if (page * 100 >= total || value.data.length < 100) break;
      }
      if (records.size !== total) changed = true;
      const data = [...records.values()].filter(
        item => Date.parse(item.expires_at) > Date.parse(server_time)
      );
      const signature = JSON.stringify(
        data.map(item => [item.invitation_id, item.expires_at]).sort()
      );
      if (!changed && (total! <= 100 || signature === previous)) return { data, server_time };
      previous = changed ? '' : signature;
    }
    throw new BusinessApiError(409, 'INVITATION_LIST_CHANGED', '邀请期限正在变化，请重试恢复');
  }
  async unreadCount(signal?: AbortSignal): Promise<number> {
    const value = await this.api.request<{ unread_count: number }>(
      '/notifications/team-invitations/unread-count',
      { signal }
    );
    if (!Number.isSafeInteger(value?.unread_count) || value.unread_count < 0)
      throw new BusinessApiError(502, 'INVALID_RESPONSE', '未读状态响应不完整');
    return value.unread_count;
  }
  async markRead(ids: string[], signal?: AbortSignal): Promise<number> {
    const value = await this.api.request<{ unread_count: number }>(
      '/notifications/team-invitations/read',
      { method: 'POST', body: { invitation_ids: ids }, signal }
    );
    if (!Number.isSafeInteger(value?.unread_count) || value.unread_count < 0)
      throw new BusinessApiError(502, 'INVALID_RESPONSE', '标读响应不完整');
    return value.unread_count;
  }
  private async allPages<T>(resource: string, signal?: AbortSignal): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page++) {
      const items = await this.api.request<T[]>(`${resource}?page=${page}&page_size=100`, {
        signal,
      });
      if (!Array.isArray(items)) {
        throw new BusinessApiError(502, 'INVALID_RESPONSE', '列表响应不符合业务契约。');
      }
      result.push(...items);
      if (items.length < 100) {
        return result;
      }
    }
  }
}
