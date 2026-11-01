/** 一期跨包业务契约：实体只在此定义，app 提供实现。 */
export type BusinessConfiguration = { enabled: boolean };
export type BusinessCredentials = { username: string; password: string };
export type BusinessUserSummary = { uid: string; username: string; avatar_url: string | null };
export type BusinessTeamMembership = {
  team_id: string;
  name: string;
  owner_uid: string;
  role: 'owner' | 'annotator';
};
export type SessionContext = {
  user: BusinessUserSummary;
  expires_at: string;
  default_team_id: string;
  memberships: BusinessTeamMembership[];
};
export type IssuedBusinessSession = SessionContext & { token: string };
export interface BusinessApiFailure extends Error {
  status: number;
  code: string;
  reason?: string;
}
export type BusinessRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};
export interface BusinessApi {
  request<T>(path: string, options?: BusinessRequestOptions): Promise<T>;
}
export type BusinessSessionSnapshot = {
  status: 'unknown' | 'loading' | 'authenticated' | 'invalid' | 'error';
  context: SessionContext | null;
  currentTeamId: string | null;
  error: BusinessApiFailure | null;
};
export interface BusinessSession {
  register(input: BusinessCredentials): Promise<BusinessSessionSnapshot>;
  login(input: BusinessCredentials): Promise<BusinessSessionSnapshot>;
  validateCurrent(): Promise<BusinessSessionSnapshot>;
  invalidate(): void;
  getSnapshot(): BusinessSessionSnapshot;
  subscribe(listener: () => void): () => void;
}
/** 路由标记不是身份凭证；C 在现有运行时中扩充 project 上下文，不复制该标记。 */
export type PhaseOneRouteState = { phaseOneMask?: boolean };
export type BusinessRuntime = Readonly<Required<PhaseOneRouteState>>;
export interface BusinessServices {
  api: BusinessApi;
  session: BusinessSession;
  projectRuntime?: BusinessRuntime;
}
