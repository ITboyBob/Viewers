import type {
  BusinessApi,
  BusinessCredentials,
  BusinessSession,
  BusinessSessionSnapshot,
  IssuedBusinessSession,
  SessionContext,
} from '@ohif/core';
import { BusinessApiError } from './BusinessApiClient';

const STORAGE_KEY = 'colla.phaseOne.session';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function isContext(value: unknown): value is SessionContext {
  if (!isRecord(value) || !isRecord(value.user)) {
    return false;
  }
  const user = value.user;
  if (
    ![user.uid, user.username, value.expires_at, value.default_team_id].every(nonEmpty) ||
    !(user.avatar_url === null || typeof user.avatar_url === 'string') ||
    !Number.isFinite(Date.parse(value.expires_at as string))
  ) {
    return false;
  }
  const memberships = value.memberships;
  if (
    !Array.isArray(memberships) ||
    memberships.length === 0 ||
    !memberships.every(
      (member: unknown) =>
        isRecord(member) &&
        [member.team_id, member.name, member.owner_uid].every(nonEmpty) &&
        (member.role === 'owner' || member.role === 'annotator')
    )
  ) {
    return false;
  }
  return memberships.some(member => member.team_id === value.default_team_id);
}
function normalizedContext(value: unknown): SessionContext {
  if (!isContext(value)) {
    throw new BusinessApiError(502, 'INVALID_RESPONSE', '服务返回的身份不完整，请重试');
  }
  // 白名单投影：不把意外返回的 Token／内部字段转发到公开身份快照。
  return {
    user: { uid: value.user.uid, username: value.user.username, avatar_url: value.user.avatar_url },
    expires_at: value.expires_at,
    default_team_id: value.default_team_id,
    ...(value.selected_team_id ? { selected_team_id: value.selected_team_id } : {}),
    memberships: value.memberships.map(({ team_id, name, owner_uid, role }) => ({
      team_id,
      name,
      owner_uid,
      role,
    })),
  };
}

export class BusinessSessionService implements BusinessSession {
  private token: string | null = null;
  private expiresAt: string | null = null;
  private teamCandidate: string | null = null;
  private revision = 0;
  private snapshot: BusinessSessionSnapshot = {
    status: 'unknown',
    context: null,
    currentTeamId: null,
    error: null,
  };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: BusinessApi,
    private readonly storage: Storage | null
  ) {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (typeof saved.token !== 'string' || typeof saved.expires_at !== 'string') {
          throw new Error('invalid storage');
        }
        this.token = saved.token;
        this.expiresAt = saved.expires_at;
        this.teamCandidate =
          typeof saved.current_team_id === 'string' ? saved.current_team_id : null;
      }
    } catch {
      this.removeStored();
    }
  }

  getToken = () => this.token;
  getRevision = () => this.revision;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: BusinessSessionSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }
  private removeStored() {
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      /* 存储不可用时仍可清理内存身份。 */
    }
  }
  private persist() {
    try {
      this.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({
          token: this.token,
          expires_at: this.expiresAt,
          current_team_id: this.teamCandidate,
        })
      );
    } catch {
      /* 不因浏览器禁用存储而伪造认证失败；刷新仍须服务端确认。 */
    }
  }
  invalidate = () => {
    this.revision++;
    this.token = null;
    this.expiresAt = null;
    this.teamCandidate = null;
    this.removeStored();
    this.publish({ status: 'invalid', context: null, currentTeamId: null, error: null });
  };
  logout = (): Promise<void> => {
    // request 在首个 await 前捕获当前凭证；同步清理本地，不等待网络。
    const pending = this.api.request<void>('/auth/sessions/current', { method: 'DELETE' });
    this.invalidate();
    return pending;
  };
  private authenticated(context: SessionContext, preserveCandidate: boolean, preserveView = false) {
    const validCandidate = context.memberships.some(
      member => member.team_id === this.teamCandidate
    );
    const remote = context.memberships.some(member => member.team_id === context.selected_team_id)
      ? context.selected_team_id
      : null;
    const candidate =
      preserveView && validCandidate
        ? this.teamCandidate
        : (remote ??
          (preserveCandidate && validCandidate ? this.teamCandidate : context.default_team_id));
    this.expiresAt = context.expires_at;
    this.teamCandidate = candidate;
    this.persist();
    this.publish({ status: 'authenticated', context, currentTeamId: candidate, error: null });
    return this.snapshot;
  }
  private failed(error: unknown) {
    this.publish({
      status: 'error',
      context: null,
      currentTeamId: null,
      error:
        error instanceof BusinessApiError
          ? error
          : new BusinessApiError(0, 'NETWORK_ERROR', '无法确认身份，请重试'),
    });
  }
  private async authenticate(path: string, input: BusinessCredentials) {
    const revision = ++this.revision;
    this.publish({ status: 'loading', context: null, currentTeamId: null, error: null });
    try {
      const issued = await this.api.request<IssuedBusinessSession>(path, {
        method: 'POST',
        body: input,
      });
      if (revision === this.revision) {
        if (!isRecord(issued) || !nonEmpty(issued.token)) {
          throw new BusinessApiError(502, 'INVALID_RESPONSE', '服务返回的凭据不完整，请重试');
        }
        const context = normalizedContext(issued);
        this.token = issued.token;
        return this.authenticated(context, false);
      }
      return this.snapshot;
    } catch (error) {
      if (revision === this.revision) {
        this.failed(error);
      }
      throw error;
    }
  }
  register = (input: BusinessCredentials) => this.authenticate('/users', input);
  login = (input: BusinessCredentials) => this.authenticate('/auth/sessions', input);
  refreshContext = async () => {
    if (this.snapshot.status !== 'authenticated') return this.snapshot;
    const revision = ++this.revision;
    const value = await this.api.request<SessionContext>('/auth/sessions/current');
    if (revision === this.revision) return this.authenticated(normalizedContext(value), true, true);
    return this.snapshot;
  };
  selectTeam = async (teamId: string) => {
    const snapshot = this.snapshot;
    if (
      snapshot.status !== 'authenticated' ||
      !snapshot.context?.memberships.some(m => m.team_id === teamId)
    )
      throw new BusinessApiError(403, 'FORBIDDEN', '没有该团队成员资格');
    const revision = ++this.revision;
    const context = normalizedContext(
      await this.api.request<SessionContext>('/auth/sessions/current/team', {
        method: 'PUT',
        body: { team_id: teamId },
      })
    );
    if (revision !== this.revision) return this.snapshot;
    this.teamCandidate = teamId;
    return this.authenticated(context, true);
  };
  validateCurrent = async () => {
    if (!this.token) {
      this.invalidate();
      return this.snapshot;
    }
    const revision = ++this.revision;
    this.publish({ status: 'loading', context: null, currentTeamId: null, error: null });
    try {
      const context = await this.api.request<SessionContext>('/auth/sessions/current');
      if (revision === this.revision) {
        return this.authenticated(normalizedContext(context), true);
      }
    } catch (error) {
      if (revision === this.revision) {
        this.failed(error);
      }
    }
    return this.snapshot;
  };
}
