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
export interface BusinessServices {
  api: BusinessApi;
  session: BusinessSession;
  localProjects?: LocalProjects;
  tasks?: TaskApi;
  projectRuntime?: ProjectRuntime;
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
