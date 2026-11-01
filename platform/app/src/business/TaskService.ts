import type {
  BusinessApi,
  BusinessApiFailure,
  BusinessTask,
  LocalProject,
  LocalProjects,
  TaskApi,
} from '@ohif/core';
import { BusinessApiError } from './BusinessApiClient';

const fields = [
  'task_id',
  'team_id',
  'title',
  'assignee_uid',
  'metadata',
  'created_at',
  'updated_at',
];
function validatedTask(value: unknown, project: LocalProject): BusinessTask {
  const data =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const metadata = data.metadata;
  if (
    Object.keys(data).length !== fields.length ||
    fields.some(field => !Object.hasOwn(data, field)) ||
    typeof data.task_id !== 'string' ||
    !data.task_id.trim() ||
    data.team_id !== project.team_id ||
    data.assignee_uid !== project.importer_uid ||
    data.title !== project.title ||
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    Object.keys(metadata).length !== 0 ||
    typeof data.created_at !== 'string' ||
    typeof data.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(data.created_at)) ||
    !Number.isFinite(Date.parse(data.updated_at)) ||
    Date.parse(data.updated_at) < Date.parse(data.created_at)
  ) {
    throw new BusinessApiError(
      502,
      'INVALID_RESPONSE',
      '任务登记响应不完整或与当前批次不匹配，请保留原批次重试'
    );
  }
  return {
    task_id: data.task_id,
    team_id: project.team_id,
    title: project.title,
    assignee_uid: project.importer_uid,
    metadata: {},
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}
export class TaskService implements TaskApi {
  private readonly flights = new WeakMap<
    LocalProject,
    { promise: Promise<BusinessTask>; controller: AbortController }
  >();
  private readonly accepted = new WeakMap<LocalProject, BusinessTask>();
  constructor(
    private readonly api: BusinessApi,
    private readonly projects: LocalProjects
  ) {}
  register(project: LocalProject): Promise<BusinessTask> {
    if (
      !this.projects.isCurrent(project) ||
      project.phase === 'disposed' ||
      project.phase === 'invalid'
    ) {
      return Promise.reject(new BusinessApiError(0, 'CANCELLED', '当前批次资格已失效，请重新导入'));
    }
    const flight = this.flights.get(project);
    if (flight) {
      return flight.promise;
    }
    const accepted = this.accepted.get(project);
    if (accepted) {
      return Promise.resolve(accepted);
    }
    const controller = new AbortController();
    project.phase = 'registering';
    const promise = this.send(project, controller).finally(() => this.flights.delete(project));
    this.flights.set(project, { promise, controller });
    return promise;
  }
  private async send(project: LocalProject, controller: AbortController): Promise<BusinessTask> {
    try {
      const value = await this.api.request<unknown>(
        `/teams/${encodeURIComponent(project.team_id)}/tasks`,
        {
          method: 'POST',
          body: { title: project.title },
          idempotencyKey: project.registration_key,
          signal: controller.signal,
        }
      );
      if (controller.signal.aborted || !this.projects.isCurrent(project)) {
        throw new BusinessApiError(0, 'CANCELLED', '已离开原批次或身份变化，忽略晚响应');
      }
      const task = validatedTask(value, project);
      Object.assign(project, {
        task_id: task.task_id,
        created_at: task.created_at,
        updated_at: task.updated_at,
        phase: 'registered',
      });
      this.accepted.set(project, task);
      return task;
    } catch (error) {
      if (this.projects.isCurrent(project)) {
        project.phase = [401, 403, 404].includes((error as BusinessApiFailure).status)
          ? 'invalid'
          : 'ready';
      }
      throw error;
    }
  }
  cancel(project: LocalProject) {
    this.flights.get(project)?.controller.abort();
  }
}
