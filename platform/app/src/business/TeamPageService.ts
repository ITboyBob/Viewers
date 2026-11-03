import type {
  BusinessApi,
  RecentTaskCard,
  RecentTaskList,
  TaskMemberList,
  TeamPageApi,
  TeamTaskCard,
  TeamTaskList,
} from '@ohif/core';
import { BusinessApiError } from './BusinessApiClient';

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const invalid = (message = '团队页演示读取响应无效，请重试。'): never => {
  throw new BusinessApiError(502, 'INVALID_RESPONSE', message);
};
const utc = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  ) {
    return false;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
};
// ISO UTC 同一秒内按原始小数位比较，避免 Date.parse 截断到毫秒改变排序。
const compareUtc = (left: string, right: string): number => {
  const seconds = left.slice(0, 19).localeCompare(right.slice(0, 19));
  if (seconds !== 0) {
    return seconds;
  }
  const a = left.slice(19, -1).replace(/^\./, '');
  const b = right.slice(19, -1).replace(/^\./, '');
  const length = Math.max(a.length, b.length);
  return a.padEnd(length, '0').localeCompare(b.padEnd(length, '0'));
};
const card = (value: unknown): value is TeamTaskCard =>
  record(value) &&
  uuid(value.task_id) &&
  uuid(value.team_id) &&
  text(value.title) &&
  text(value.subtitle) &&
  (value.preview_key === 'abdominal-ct' || value.preview_key === 'none');
const recentCard = (value: unknown): value is RecentTaskCard =>
  card(value) && utc((value as unknown as Record<string, unknown>).last_entered_at);

/** 请求和校验专用；没有跨账号缓存，不接入真实任务写入或访问历史。 */
export class TeamPageService implements TeamPageApi {
  constructor(private readonly api: BusinessApi) {}

  async listTeamTasks(teamId: string, signal?: AbortSignal): Promise<TeamTaskList> {
    const value = await this.api.request<unknown>(`/teams/${encodeURIComponent(teamId)}/tasks`, {
      signal,
    });
    const result = this.list(value, card);
    if (result.items.some(item => item.team_id !== teamId)) {
      invalid();
    }
    return result;
  }

  async listRecentTasks(signal?: AbortSignal): Promise<RecentTaskList> {
    const value = await this.api.request<unknown>('/tasks/recent', { signal });
    const result = this.list(value, recentCard);
    for (let index = 1; index < result.items.length; index++) {
      const before = result.items[index - 1];
      const after = result.items[index];
      const delta = compareUtc(before.last_entered_at, after.last_entered_at);
      if (delta < 0 || (delta === 0 && before.task_id > after.task_id)) {
        invalid();
      }
    }
    return result;
  }

  async listTaskMembers(taskId: string, signal?: AbortSignal): Promise<TaskMemberList> {
    const value = await this.api.request<unknown>(`/tasks/${encodeURIComponent(taskId)}/members`, {
      signal,
    });
    if (
      !record(value) ||
      value.mock !== false ||
      !uuid(value.task_id) ||
      value.task_id !== taskId ||
      !uuid(value.owner_uid) ||
      !Array.isArray(value.members)
    ) {
      return invalid('任务成员读取响应无效，请重试。');
    }
    const ids = new Set<string>();
    const members: TaskMemberList['members'] = value.members.map(member => {
      if (!record(member) || !uuid(member.uid) || !text(member.username) || ids.has(member.uid)) {
        return invalid('任务成员读取响应无效，请重试。');
      }
      ids.add(member.uid);
      return { uid: member.uid, username: member.username };
    });
    if (!ids.has(value.owner_uid)) {
      return invalid('任务成员读取响应无效，请重试。');
    }
    return { task_id: value.task_id, owner_uid: value.owner_uid, members, mock: false };
  }

  private list<T extends TeamTaskCard>(
    value: unknown,
    accepts: (item: unknown) => item is T
  ): { items: T[]; total: number; mock: true } {
    if (
      !record(value) ||
      value.mock !== true ||
      !Array.isArray(value.items) ||
      !Number.isSafeInteger(value.total) ||
      value.total !== value.items.length
    ) {
      return invalid();
    }
    const ids = new Set<string>();
    const items = value.items.map(item => {
      if (!accepts(item) || ids.has(item.task_id)) {
        return invalid();
      }
      ids.add(item.task_id);
      return item;
    });
    return { items, total: items.length, mock: true };
  }
}
