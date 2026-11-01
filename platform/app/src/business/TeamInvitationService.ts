import type {
  BusinessApi,
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
