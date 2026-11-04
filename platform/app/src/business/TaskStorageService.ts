import type {
  BusinessApi,
  BusinessSession,
  BusinessTask,
  LocalProject,
  LocalProjects,
  TaskStorageApi,
  SourceFileSpec,
  TaskMaterials,
  TaskResults,
  ResultArtifact,
  ResultObject,
} from '@ohif/core';
import { BusinessApiError } from './BusinessApiClient';

/** 原图与成果均经集中鉴权客户端；不复用另一账号的缓存或不透明对象URL。 */
export class TaskStorageService implements TaskStorageApi {
  private imports = new WeakMap<LocalProject, SourceFileSpec[]>();
  private operations = new Map<
    string,
    { taskId: string; base: number; artifacts: ResultArtifact[]; objects: ResultObject[] }
  >();
  constructor(
    private api: BusinessApi,
    private projects: LocalProjects,
    private session: BusinessSession
  ) {}
  forgetPending(taskId: string) {
    for (const [id, value] of this.operations) {
      if (value.taskId === taskId) {
        this.operations.delete(id);
      }
    }
  }
  async register(project: LocalProject, signal: AbortSignal): Promise<BusinessTask> {
    const selection = this.projects.getSelection(project);
    if (!selection) {
      throw new Error('原始文件未保留，无法上传');
    }
    let files = this.imports.get(project);
    if (!files) {
      files = project.successes.map(item => ({
        file_id: crypto.randomUUID(),
        selection_index: item.selection_index,
        file_name: item.file_name,
        relative_path: item.relative_path,
        size: selection.files[item.selection_index].size,
        study_uid: item.study_uid,
        series_uid: item.series_uid,
        sop_uid: item.sop_uid,
      }));
      this.imports.set(project, files);
    }
    const start = await this.api.request<{ import_id: string; uploaded_files: string[] }>(
      `/teams/${project.team_id}/task-imports`,
      {
        method: 'POST',
        signal,
        body: {
          registration_key: project.registration_key,
          title: project.title,
          kind: project.kind,
          folder_name: project.folder_name,
          mode_path: project.mode_path,
          files,
        },
      }
    );
    if (!start?.import_id || !Array.isArray(start.uploaded_files)) {
      throw new BusinessApiError(502, 'INVALID_RESPONSE', '导入响应不完整');
    }
    // 两个受控上传工人，不为整组Study同时创建全部网络请求。
    const pending = files.filter(f => !start.uploaded_files.includes(f.file_id));
    let cursor = 0;
    const upload = async () => {
      while (cursor < pending.length) {
        const item = pending[cursor++];
        await this.api.request(`/task-imports/${start.import_id}/files/${item.file_id}`, {
          method: 'PUT',
          binaryBody: selection.files[item.selection_index],
          signal,
          timeoutMs: 300000,
        });
      }
    };
    await Promise.all([upload(), upload()]);
    return this.api.request(`/task-imports/${start.import_id}/complete`, {
      method: 'POST',
      signal,
    });
  }
  async open(taskId: string, signal: AbortSignal): Promise<LocalProject> {
    const uid = this.session.getSnapshot().context?.user.uid;
    const value = await this.api.request<TaskMaterials>(
      `/tasks/${encodeURIComponent(taskId)}/materials`,
      { signal }
    );
    if (
      value?.task?.task_id !== taskId ||
      !Array.isArray(value.source?.files) ||
      !value.source.files.length ||
      typeof value.access?.can_edit !== 'boolean'
    ) {
      throw new BusinessApiError(502, 'INVALID_RESPONSE', '任务材料响应不完整');
    }
    const files: File[] = [];
    for (const item of [...value.source.files].sort(
      (a, b) => a.selection_index - b.selection_index
    )) {
      const blob = await this.api.request<Blob>(
        `/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(item.file_id)}`,
        { responseType: 'blob', signal, timeoutMs: 300000 }
      );
      if (blob.size !== item.size) {
        throw new Error('原始影像大小不匹配');
      }
      const file = new File([blob], item.file_name, { type: 'application/dicom' });
      if (item.relative_path) {
        Object.defineProperty(file, 'webkitRelativePath', { value: item.relative_path });
      }
      files.push(file);
    }
    if (signal.aborted || uid !== this.session.getSnapshot().context?.user.uid) {
      throw new Error('账号变化，任务加载已取消');
    }
    if (!this.projects.restoreStored) {
      throw new Error('任务恢复服务不可用');
    }
    return this.projects.restoreStored(
      value,
      { files, kind: value.source.kind, folderName: value.source.folder_name },
      signal
    );
  }
  results(taskId: string, signal?: AbortSignal): Promise<TaskResults> {
    return this.api.request(`/tasks/${encodeURIComponent(taskId)}/results`, { signal });
  }
  async readArtifacts(
    taskId: string,
    value: TaskResults,
    signal: AbortSignal
  ): Promise<ResultArtifact[]> {
    if (
      !Number.isSafeInteger(value?.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.objects)
    ) {
      throw new Error('成果清单不完整');
    }
    const items: ResultArtifact[] = [];
    for (const item of value.objects) {
      if (!['SR', 'SEG', 'RTSTRUCT'].includes(item.type)) {
        throw new Error('不支持的成果类型');
      }
      const blob = await this.api.request<Blob>(
        `/tasks/${encodeURIComponent(taskId)}/result-files/${encodeURIComponent(item.object_id)}`,
        { responseType: 'blob', signal, timeoutMs: 300000 }
      );
      items.push({ type: item.type, blob });
    }
    return items;
  }
  async save(
    taskId: string,
    base: number,
    artifacts: ResultArtifact[],
    operationId: string,
    signal: AbortSignal
  ): Promise<TaskResults> {
    let pending = this.operations.get(operationId);
    if (!pending) {
      pending = {
        taskId,
        base,
        artifacts,
        objects: artifacts.map(a => ({ object_id: crypto.randomUUID(), type: a.type })),
      };
      this.operations.set(operationId, pending);
    }
    if (pending.taskId !== taskId || pending.base !== base) {
      throw new Error('保存操作身份不匹配');
    }
    for (let i = 0; i < pending.objects.length; i++) {
      await this.api.request(`/tasks/${taskId}/result-files/${pending.objects[i].object_id}`, {
        method: 'PUT',
        binaryBody: pending.artifacts[i].blob,
        signal,
        timeoutMs: 300000,
      });
    }
    const result = await this.api.request<TaskResults>(`/tasks/${taskId}/results/commit`, {
      method: 'POST',
      signal,
      body: { base_revision: base, operation_id: operationId, objects: pending.objects },
    });
    this.operations.delete(operationId);
    return result;
  }
}
