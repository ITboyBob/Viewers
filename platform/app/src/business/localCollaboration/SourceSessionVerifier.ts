import type {
  BusinessApi,
  BusinessSession,
  LocalParticipantIdentity,
  SessionContext,
  SourceSessionVerificationPort,
} from '@ohif/core';

type Options = { api: BusinessApi; session: BusinessSession; identity: LocalParticipantIdentity };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function currentResponse(value: unknown): value is SessionContext {
  if (!record(value) || !record(value.user)) {
    return false;
  }
  return (
    [value.user.uid, value.user.username, value.expires_at, value.default_team_id].every(text) &&
    (value.user.avatar_url === null || typeof value.user.avatar_url === 'string') &&
    Number.isFinite(Date.parse(value.expires_at as string)) &&
    Array.isArray(value.memberships) &&
    value.memberships.length > 0 &&
    value.memberships.every(
      member =>
        record(member) &&
        [member.team_id, member.name, member.owner_uid].every(text) &&
        (member.role === 'owner' || member.role === 'annotator')
    ) &&
    value.memberships.some(member => member.team_id === value.default_team_id)
  );
}

/** 独立复核，不调用会暂时清空 authenticated 快照的入口 validateCurrent。 */
export class SourceSessionVerifier implements SourceSessionVerificationPort {
  constructor(private readonly options: Options) {}

  async verify(): Promise<boolean> {
    const { api, session, identity } = this.options;
    const current = () =>
      identity.isCurrent() &&
      session.getSnapshot().status === 'authenticated' &&
      session.getSnapshot().context?.user.uid === identity.user.uid;
    if (!current()) {
      return false;
    }
    try {
      const response = await api.request<unknown>('/auth/sessions/current');
      if (!current() || !currentResponse(response)) {
        return false;
      }
      if (response.user.uid !== identity.user.uid) {
        // 已确认当前凭据与原身份矛盾；沿原失效链同步停止项目和 FIFO 写资格。
        session.invalidate();
        identity.close('identity_invalid');
        return false;
      }
      return true;
    } catch (error) {
      // 真实 API 负责 401 凭据失效；替身也不能把仍有效的旧源保留为可分享。
      if (current() && record(error) && error.status === 401) {
        identity.close('identity_invalid');
      }
      throw error;
    }
  }
}
