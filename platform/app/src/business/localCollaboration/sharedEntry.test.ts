import {
  sharedAuthSearch,
  sharedAuthTaskFromSearch,
  sharedLoginPath,
  sharedTaskFromSearch,
  sharedViewPath,
} from './sharedEntry';
const task = '12345678-1234-1234-1234-123456789abc';

test('分享目标只由合法UUID生成固定站内地址，登录意图不保存任意URL', () => {
  expect(sharedTaskFromSearch(`?task_id=${task}`)).toBe(task);
  expect(sharedViewPath(task)).toBe(`/local-shared?task_id=${task}`);
  expect(sharedAuthTaskFromSearch(sharedAuthSearch(task), '')).toBe(task);
  expect(sharedLoginPath('/local-shared/', `?task_id=${task}`, '')).toBe(
    `/account/login?shared_task_id=${task}`
  );
});

test.each([
  '',
  '?task_id=',
  '?task_id=//outside.test',
  '?task_id=javascript:alert(1)',
  `?task_id=${task}&task_id=${task}`,
  `?task_id=${task}&token=forbidden`,
])('非法共享搜索参数不提取目标：%s', search => {
  expect(sharedTaskFromSearch(search)).toBeNull();
  expect(sharedLoginPath('/local-shared', search, '')).toBe('/account/login');
});

test('非共享入口、hash和异常认证参数不产生回跳', () => {
  expect(sharedLoginPath('/segmentation/dicomlocal', `?task_id=${task}`, '')).toBe(
    '/account/login'
  );
  expect(sharedLoginPath('/local-shared', `?task_id=${task}`, '#token')).toBe('/account/login');
  expect(sharedAuthTaskFromSearch(sharedAuthSearch(task), '#hash')).toBeNull();
  expect(sharedAuthTaskFromSearch(`?shared_task_id=${task}&returnUrl=/outside`, '')).toBeNull();
  expect(sharedAuthTaskFromSearch('?returnUrl=https://outside.test', '')).toBeNull();
});
