/** 分享认证只携带任务 UUID；不接收任意跳转地址或凭证。 */
const taskPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function taskFromSearch(search: string, key: string): string | null {
  const entries = [...new URLSearchParams(search).entries()];
  return entries.length === 1 && entries[0][0] === key && taskPattern.test(entries[0][1])
    ? entries[0][1]
    : null;
}
export const sharedTaskFromSearch = (search: string) => taskFromSearch(search, 'task_id');
export const sharedAuthTaskFromSearch = (search: string, hash: string) =>
  hash ? null : taskFromSearch(search, 'shared_task_id');
export const sharedViewPath = (taskId: string) =>
  `/local-shared?task_id=${encodeURIComponent(taskId)}`;
export const sharedAuthSearch = (taskId: string) => `?shared_task_id=${encodeURIComponent(taskId)}`;
export function sharedLoginPath(pathname: string, search: string, hash: string): string {
  const taskId =
    pathname.replace(/\/$/, '') === '/local-shared' && !hash ? sharedTaskFromSearch(search) : null;
  return `/account/login${taskId ? sharedAuthSearch(taskId) : ''}`;
}
