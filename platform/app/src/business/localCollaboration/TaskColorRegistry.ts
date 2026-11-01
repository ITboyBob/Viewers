import type {
  LocalParticipantSnapshot,
  TaskColorAssignment,
  TaskColorRegistrySnapshot,
} from '@ohif/core';

const candidates = Object.freeze([
  Object.freeze({ color_key: 'cursor-v1-01', color_value: '#2563EB' }),
  Object.freeze({ color_key: 'cursor-v1-02', color_value: '#C2410C' }),
]);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: TaskColorAssignment, b: TaskColorAssignment) =>
  a.uid === b.uid && a.color_key === b.color_key && a.color_value === b.color_value;

/** 当前分享内只追加；在线表的移除不会触碰这份历史登记。 */
export class TaskColorRegistry {
  private snapshot: TaskColorRegistrySnapshot;

  constructor(taskId: string, sourceId: string, sourceUid: string) {
    if (![taskId, sourceId, sourceUid].every(text)) {
      throw new Error('任务、源及源账户不能为空');
    }
    this.snapshot = Object.freeze({
      task_id: taskId,
      source_participant_id: sourceId,
      revision: 1,
      assignments: Object.freeze([Object.freeze({ uid: sourceUid, ...candidates[0] })]),
    });
  }

  assign(uid: string): TaskColorAssignment | null {
    const existing = this.snapshot.assignments.find(item => item.uid === uid);
    if (existing) {
      return existing;
    }
    const candidate = candidates[this.snapshot.assignments.length];
    if (!text(uid) || !candidate) {
      return null;
    }
    const assignment = Object.freeze({ uid, ...candidate });
    this.snapshot = Object.freeze({
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      assignments: Object.freeze([...this.snapshot.assignments, assignment]),
    });
    return assignment;
  }

  getSnapshot = (): TaskColorRegistrySnapshot => this.snapshot;
}

/** 返回冻结的可信投影；旧修订只能复用当前表，不能删除或重新解释历史项。 */
export function validateColorRegistry(
  value: unknown,
  taskId: string,
  sourceId: string,
  previous: TaskColorRegistrySnapshot | null,
  members: readonly LocalParticipantSnapshot[]
): TaskColorRegistrySnapshot | null {
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== 'assignments,revision,source_participant_id,task_id' ||
    value.task_id !== taskId ||
    value.source_participant_id !== sourceId ||
    !Array.isArray(value.assignments) ||
    !value.assignments.length ||
    value.assignments.length > candidates.length ||
    value.revision !== value.assignments.length
  ) {
    return null;
  }
  const assignments: TaskColorAssignment[] = [];
  const uids = new Set<string>();
  for (const [index, item] of value.assignments.entries()) {
    if (
      !record(item) ||
      Object.keys(item).sort().join() !== 'color_key,color_value,uid' ||
      !text(item.uid) ||
      uids.has(item.uid) ||
      item.color_key !== candidates[index].color_key ||
      item.color_value !== candidates[index].color_value
    ) {
      return null;
    }
    uids.add(item.uid);
    assignments.push(
      Object.freeze({
        uid: item.uid,
        ...candidates[index],
      })
    );
  }
  if (previous) {
    if (
      previous.task_id !== taskId ||
      previous.source_participant_id !== sourceId ||
      !assignments
        .slice(0, previous.assignments.length)
        .every((item, index) => same(item, previous.assignments[index]))
    ) {
      return null;
    }
    if (value.revision <= previous.revision) {
      return members.every(member =>
        previous.assignments.some(
          item => item.uid === member.user.uid && item.color_key === member.color_key
        )
      )
        ? previous
        : null;
    }
  }
  if (
    !members.every(member =>
      assignments.some(item => item.uid === member.user.uid && item.color_key === member.color_key)
    )
  ) {
    return null;
  }
  return Object.freeze({
    task_id: taskId,
    source_participant_id: sourceId,
    revision: value.revision as number,
    assignments: Object.freeze(assignments),
  });
}
