import type { ReactNode } from 'react';

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
export type InvitationDecision = 'pending' | 'accepted' | 'rejected';
export type InvitationView = {
  invitation_id: string;
  team_id: string;
  team_name: string;
  inviter: BusinessUserSummary;
  invitee_uid: string;
  created_at: string;
  expires_at: string;
  decision: InvitationDecision;
  decided_at: string | null;
};
export type MemberView = BusinessUserSummary & {
  role: 'owner' | 'annotator';
  joined_at: string;
};
export interface TeamInvitationApi {
  send(teamId: string, username: string, signal?: AbortSignal): Promise<InvitationView>;
  listMembers(teamId: string, signal?: AbortSignal): Promise<MemberView[]>;
  listNotifications(signal?: AbortSignal): Promise<InvitationView[]>;
  decide(
    id: string,
    decision: Exclude<InvitationDecision, 'pending'>,
    signal?: AbortSignal
  ): Promise<InvitationView>;
}
export type CollaborationRecipient = BusinessUserSummary & { synthetic: true; in_team: boolean };
export type MockInvitation = {
  kind: 'collaboration_mock';
  mock_id: string;
  sender_uid: string;
  recipient_uid: string;
  recipient_username: string;
  created_at: number;
  expires_at: number;
  decision: InvitationDecision;
};
export type NotificationItem = { kind: 'team_join'; invitation: InvitationView } | MockInvitation;
export interface CollaborationMockApi {
  readonly recipients: readonly CollaborationRecipient[];
  list(): MockInvitation[];
  invite(username: string): MockInvitation;
  decide(id: string, decision: Exclude<InvitationDecision, 'pending'>): MockInvitation;
  isInvited(username: string): boolean;
  getError(): string | null;
  clockNow(): number;
}
export interface BusinessServices {
  api: BusinessApi;
  session: BusinessSession;
  projectRuntime?: BusinessRuntime;
  teamInvitations?: TeamInvitationApi;
  collaborationMock?: { forUser(user: BusinessUserSummary): CollaborationMockApi };
  ui?: { renderHeader(options: { page: 'import' | 'viewer' }): ReactNode };
}
