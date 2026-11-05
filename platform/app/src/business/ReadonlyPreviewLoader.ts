import type {
  BusinessApi,
  ReadonlyPreviewInput,
  ReadonlyPreviewResult,
  TaskMaterials,
  TaskResults,
} from '@ohif/core';

const check = (value: TaskResults) => {
  if (
    !Number.isSafeInteger(value?.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.objects) ||
    !value.access?.owner_uid ||
    typeof value.access.can_edit !== 'boolean' ||
    value.objects.some(o => !o.object_id || !['SR', 'SEG', 'RTSTRUCT'].includes(o.type)) ||
    new Set(value.objects.map(o => o.object_id)).size !== value.objects.length
  )
    throw new Error('成果清单不完整');
  return value;
};
const same = (a: TaskResults, b: TaskResults) =>
  a.revision === b.revision && JSON.stringify(a.objects) === JSON.stringify(b.objects);
/** 整版重取边界。只有成果对象404且清单确实换版才重试；权限及解码错误直接上报。 */
export async function loadReadonlyPreview(
  api: BusinessApi,
  accountUid: string,
  taskId: string,
  signal: AbortSignal,
  compose: (
    input: ReadonlyPreviewInput,
    materials: TaskMaterials,
    signal: AbortSignal
  ) => Promise<ReadonlyPreviewResult>
): Promise<ReadonlyPreviewResult> {
  const root = `/tasks/${encodeURIComponent(taskId)}`;
  const materials = await api.request<TaskMaterials>(root + '/materials', { signal });
  const file = [...(materials?.source?.files ?? [])].sort(
    (a, b) => a.selection_index - b.selection_index
  )[0];
  if (
    !accountUid ||
    materials?.task?.task_id !== taskId ||
    !materials.task.team_id ||
    !file ||
    !file.study_uid ||
    !file.series_uid ||
    !file.sop_uid ||
    !materials.access?.owner_uid ||
    typeof materials.access.can_edit !== 'boolean'
  )
    throw new Error('任务材料或读取上下文不完整');
  const sourceBlob = await api.request<Blob>(`${root}/files/${encodeURIComponent(file.file_id)}`, {
    signal,
    responseType: 'blob',
  });
  const read = async () => check(await api.request<TaskResults>(root + '/results', { signal }));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new Error('预览读取已取消');
    const value = await read();
    const objects: ReadonlyPreviewInput['objects'] = [];
    try {
      for (const object of value.objects)
        objects.push({
          ...object,
          blob: await api.request<Blob>(
            `${root}/result-files/${encodeURIComponent(object.object_id)}`,
            { signal, responseType: 'blob', timeoutMs: 300000 }
          ),
        });
    } catch (failure) {
      if ((failure as { status?: number })?.status !== 404) throw failure;
      const latest = await read();
      if (!same(value, latest)) continue;
      throw failure;
    }
    // 下载期间旧版可能已被替换：先确认整版仍有效，再分配解码与绘制资源。
    if (!same(value, await read())) continue;
    let result: ReadonlyPreviewResult | undefined;
    try {
      if (signal.aborted) throw new Error('预览读取已取消');
      result = await compose(
        {
          account_uid: accountUid,
          team_id: materials.task.team_id,
          task_id: taskId,
          source_file_id: file.file_id,
          study_uid: file.study_uid,
          series_uid: file.series_uid,
          sop_uid: file.sop_uid,
          frame_index: 0,
          revision: value.revision,
          render_rule_version: 1,
          sourceBlob,
          objects,
          access: value.access,
        },
        materials,
        signal
      );
      const latest = await read();
      if (signal.aborted) throw new Error('预览读取已取消');
      if (same(value, latest)) return result;
    } catch (failure) {
      result?.release?.();
      throw failure;
    }
    result?.release?.();
  }
  throw new Error('成果修订持续变化，预览未完成，请重试。');
}
