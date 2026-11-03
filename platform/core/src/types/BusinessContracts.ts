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
  idempotencyKey?: string;
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
/** 团队页第一阶段演示读取投影，不扩充真实 BusinessTask 或访问写入。 */
export type TeamTaskCard = {
  task_id: string;
  team_id: string;
  title: string;
  subtitle: string;
  preview_key: 'abdominal-ct' | 'none';
};
export type RecentTaskCard = TeamTaskCard & { last_entered_at: string };
export type TeamTaskList = { items: TeamTaskCard[]; total: number; mock: true };
export type RecentTaskList = { items: RecentTaskCard[]; total: number; mock: true };
export type TaskMemberList = {
  task_id: string;
  owner_uid: string;
  members: { uid: string; username: string }[];
  mock: true;
};
export interface TeamPageApi {
  listTeamTasks(teamId: string, signal?: AbortSignal): Promise<TeamTaskList>;
  listRecentTasks(signal?: AbortSignal): Promise<RecentTaskList>;
  listTaskMembers(taskId: string, signal?: AbortSignal): Promise<TaskMemberList>;
}

export interface BusinessServices {
  teamPage?: TeamPageApi;
  api: BusinessApi;
  session: BusinessSession;
  localProjects?: LocalProjects;
  tasks?: TaskApi;
  projectRuntime?: ProjectRuntime;
  teamInvitations?: TeamInvitationApi;
  collaborationMock?: { forUser(user: BusinessUserSummary): CollaborationMockApi };
  localCollaboration?: LocalCollaborationServices;
  ui?: { renderHeader(options: { page: 'import' | 'viewer'; taskMembers?: boolean }): ReactNode };
}

/** 本地影像及project仅保存在当前页面内存，不进入业务请求或浏览器存储。 */
export type ImportSelection = {
  files: readonly File[];
  kind: 'files' | 'folder';
  folderName?: string;
};
export type BatchSuccess = {
  readonly selection_index: number;
  readonly file_name: string;
  readonly relative_path?: string;
  readonly image_id: string;
  readonly study_uid: string;
  readonly series_uid: string;
  readonly sop_uid: string;
  readonly dataset: Record<string, unknown>;
};
export type BatchFailure = {
  selection_index: number;
  file_name: string;
  reason: 'PARSE_FAILED' | 'INVALID_DATASET' | 'CLEANUP_FAILED';
};
export type ImportBatch = {
  readonly batch_id: string;
  readonly kind: 'files' | 'folder';
  readonly folder_name?: string;
  readonly successes: readonly BatchSuccess[];
  readonly failures: readonly BatchFailure[];
  readonly study_uids: readonly string[];
};
export type LocalProject = ImportBatch & {
  readonly importer_uid: string;
  readonly team_id: string;
  readonly title: string;
  readonly registration_key: string;
  readonly mode_path: 'segmentation/dicomlocal' | 'microscopy';
  task_id?: string;
  created_at?: string;
  updated_at?: string;
  phase: 'parsing' | 'ready' | 'registering' | 'registered' | 'invalid' | 'disposed';
};
export interface LocalProjects {
  create(input: ImportSelection, microscopyLoaded?: boolean): Promise<LocalProject | null>;
  getCurrent(): LocalProject | null;
  getFailures(): readonly BatchFailure[];
  isCurrent(project: LocalProject): boolean;
  invalidate(project: LocalProject): void;
  updateTimestamp(project: LocalProject, value: BusinessTaskTimestamp): boolean;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export type BusinessTask = {
  task_id: string;
  team_id: string;
  title: string;
  assignee_uid: string;
  metadata: Record<string, never>;
  created_at: string;
  updated_at: string;
};
export interface TaskApi {
  register(project: LocalProject): Promise<BusinessTask>;
  touch(project: LocalProject, signal: AbortSignal): Promise<BusinessTaskTimestamp>;
  cancel(project: LocalProject): void;
}
export type BusinessTaskTimestamp = { task_id: string; updated_at: string };
export type LocalImportScope = { activate(): void; release(): void; isActive?(): boolean };
export type ProjectLifecycleHandle = { deactivate(): void; releaseScope(): void };
export type ProjectModeLifecycle = { setNativeExit(exit: () => void): () => void; dispose(): void };
export interface ProjectRuntime extends BusinessRuntime {
  bind(project: LocalProject, scope: LocalImportScope): ProjectLifecycleHandle;
  getCurrent(): LocalProject | null;
  getHandle(): ProjectLifecycleHandle | null;
  getModeLifecycle(): ProjectModeLifecycle | null;
  beginMode(services: ProjectAnnotationServices, dataSourceName?: string): () => void;
}
export type ProjectEventService = {
  EVENTS: Record<string, string>;
  subscribe(event: string, callback: (payload: unknown) => void): { unsubscribe(): void };
  getMeasurements?(): unknown[];
  getMeasurement?(uid: string): unknown;
  getSegmentations?(): unknown[];
  getSegmentation?(uid: string): unknown;
};
export type ProjectAnnotationServices = {
  measurementService?: ProjectEventService;
  segmentationService?: ProjectEventService;
  uiNotificationService?: {
    show(value: { title: string; message: string; type: 'warning' }): unknown;
  };
};

/** 同文件共享的唯一公共实体。文件／凭证／本窗句柄不得进入通信信封。 */
export type LocalSharingUser = Pick<BusinessUserSummary, 'uid' | 'username'>;
export type LocalSharingRole = 'source' | 'viewer';
export type LocalSharingLeaveReason = 'exit' | 'identity_invalid' | 'source_invalid';
export type SharedPublicationPhase = 'waiting' | 'writing' | 'ready' | 'failed' | 'cancelled';
export type SharedFileItem = Pick<
  BatchSuccess,
  'selection_index' | 'file_name' | 'study_uid' | 'series_uid' | 'sop_uid'
> & { readonly byte_length: number };
export type SharedFileManifest = {
  readonly cache_version: 1;
  readonly cache_state: 'ready';
  readonly task_id: string;
  readonly batch_id: string;
  readonly source_participant_id: string;
  readonly title: string;
  readonly team_id: string;
  readonly importer_uid: string;
  readonly mode_path: LocalProject['mode_path'];
  readonly files: readonly SharedFileItem[];
};
export type SharedFileRecord = {
  readonly batch_id: string;
  readonly selection_index: number;
  readonly blob: Blob;
};
export type SharedFileBundle = {
  readonly manifest: SharedFileManifest;
  readonly files: readonly SharedFileRecord[];
};
export interface SharedFilePort {
  publish(bundle: SharedFileBundle, signal: AbortSignal): Promise<SharedFileManifest>;
  read(
    taskId: string,
    batchId: string,
    sourceId: string,
    signal: AbortSignal
  ): Promise<SharedFileBundle>;
}
export interface LocalParticipantIdentity {
  readonly participant_id: string;
  readonly task_id: string;
  readonly user: Readonly<LocalSharingUser>;
  readonly role: LocalSharingRole;
  readonly session_generation: number;
  isCurrent(): boolean;
  nextSeq(): number;
  close(reason?: LocalSharingLeaveReason): void;
  subscribe(listener: () => void): () => void;
}
export type SharedPublicationSnapshot = {
  readonly publication_phase: SharedPublicationPhase;
  readonly manifest: SharedFileManifest | null;
  readonly view_ready: boolean;
  readonly error: string | null;
};
export interface SharedPublicationContext {
  readonly identity: LocalParticipantIdentity;
  readonly task_id: string;
  readonly batch_id: string;
  isCurrent(): boolean;
  getSnapshot(): SharedPublicationSnapshot;
  subscribe(listener: () => void): () => void;
  setPublication(
    phase: SharedPublicationPhase,
    manifest?: SharedFileManifest,
    error?: string
  ): boolean;
  setViewReady(value: boolean): void;
  close(reason?: LocalSharingLeaveReason): void;
}
export interface LocalParticipationIdentities {
  source(project: LocalProject): SharedPublicationContext;
  viewer(taskId: string): LocalParticipantIdentity;
  getSource(): SharedPublicationContext | null;
  close(reason?: LocalSharingLeaveReason): void;
}
export type TaskColorAssignment = {
  readonly uid: string;
  readonly color_key: string;
  readonly color_value: string;
};
export type TaskColorRegistrySnapshot = {
  readonly task_id: string;
  readonly source_participant_id: string;
  readonly revision: number;
  readonly assignments: readonly TaskColorAssignment[];
};
export type SharedCursorPosition = {
  readonly selection_index: number;
  readonly study_uid: string;
  readonly series_uid: string;
  readonly sop_uid: string;
  readonly frame_number: number;
  readonly coordinate_space: 'image-pixel-center';
  readonly column: number;
  readonly row: number;
  readonly columns: number;
  readonly rows: number;
};
export type LocalParticipantSnapshot = {
  readonly participant_id: string;
  readonly user: Readonly<LocalSharingUser>;
  readonly role: LocalSharingRole;
  readonly color_key: string;
  readonly cursor_seq: number;
  readonly cursor: SharedCursorPosition | null;
};
export type LocalSharingEnvelope = {
  readonly protocol_version: 1;
  readonly task_id: string;
  readonly source_participant_id: string | null;
  readonly participant_id: string;
  readonly seq: number;
};
export type LocalSharingUnavailableReason =
  | 'not_ready'
  | 'source_closed'
  | 'identity_invalid'
  | 'cache_invalid'
  | 'color_unavailable';
export type LocalReadyState = LocalSharingEnvelope & {
  readonly kind: 'state';
  readonly source_participant_id: string;
  readonly target_participant_id: string;
  readonly reply_to_seq: number;
  readonly result: 'ready';
  readonly batch_id: string;
  readonly members: readonly LocalParticipantSnapshot[];
  readonly color_registry: TaskColorRegistrySnapshot;
};
export type LocalSharingMessage =
  | (LocalSharingEnvelope & {
      kind: 'join';
      user: LocalSharingUser;
      join_phase: 'loading' | 'active';
    })
  | LocalReadyState
  | (LocalSharingEnvelope & {
      kind: 'state';
      target_participant_id: string;
      reply_to_seq: number;
      result: 'unavailable';
      reason: LocalSharingUnavailableReason;
    })
  | (LocalSharingEnvelope & { kind: 'heartbeat' })
  | (LocalSharingEnvelope & { kind: 'cursor'; cursor: SharedCursorPosition | null })
  | (LocalSharingEnvelope & { kind: 'leave'; reason: LocalSharingLeaveReason });
export interface LocalChannelPort {
  postMessage(message: LocalSharingMessage): void;
  subscribe(listener: (message: unknown) => void): () => void;
  close(): void;
}
export interface LocalClockPort {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface SourceSessionVerificationPort {
  verify(): Promise<boolean>;
}
export type LocalParticipationSnapshot = {
  readonly phase: 'idle' | 'loading' | 'active' | 'closed';
  readonly source_participant_id: string | null;
  readonly batch_id: string | null;
  readonly members: readonly LocalParticipantSnapshot[];
  readonly color_registry: TaskColorRegistrySnapshot | null;
  readonly error: string | null;
};
export interface LocalParticipationPort {
  readonly identity: LocalParticipantIdentity;
  getSnapshot(): LocalParticipationSnapshot;
  subscribe(listener: () => void): () => void;
  join(phase: 'loading' | 'active'): Promise<LocalReadyState>;
  setViewReady(ready: boolean): void;
  sendCursor(cursor: SharedCursorPosition | null): void;
  close(reason?: LocalSharingLeaveReason): void;
}
export type LocalParticipationOptions = {
  identity: LocalParticipantIdentity;
  channel: LocalChannelPort;
  clock: LocalClockPort;
  source?: SharedPublicationContext;
  verifier?: SourceSessionVerificationPort;
};
export interface SharedFilePublicationPort {
  prepare(input: ImportSelection): { attach(project: LocalProject): void; cancel(): void };
  publish(project: LocalProject): Promise<void>;
  cancel(project?: LocalProject): void;
  subscribe(listener: () => void): () => void;
}
export type SharedViewContext = {
  readonly task_id: string;
  readonly batch_id: string;
  readonly source_participant_id: string;
  readonly title: string;
  readonly team_id: string;
  readonly importer_uid: string;
  readonly viewer_uid: string;
  readonly session_generation: number;
  readonly load_generation: number;
  readonly phase: 'joining' | 'loading' | 'active' | 'detached' | 'invalid' | 'disposed';
  readonly view_ready: boolean;
  readonly mode_path: LocalProject['mode_path'];
  readonly study_uids: readonly string[];
  readonly local_files: readonly BatchSuccess[];
  readonly scope_id: string;
  readonly scope_handle: LocalImportScope | null;
};
export interface SharedViewPort {
  getSnapshot(): SharedViewContext | null;
  subscribe(listener: () => void): () => void;
  open(taskId: string): Promise<void>;
  markSetupComplete(loadGeneration: number): void;
  markViewReady(loadGeneration: number): void;
  getModeLifecycle(): ProjectModeLifecycle | null;
  dispose(): void;
}
export interface LocalCollaborationServices {
  readonly identities: LocalParticipationIdentities;
  createViewerParticipation?(taskId: string): LocalParticipationPort;
  readonly files?: SharedFilePort;
  readonly publisher?: SharedFilePublicationPort;
  readonly sharedView?: SharedViewPort;
  participation?: LocalParticipationPort;
}
