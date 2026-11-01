import { TaskColorRegistry, validateColorRegistry } from './TaskColorRegistry';
import type { LocalParticipantSnapshot } from '@ohif/core';

describe('任务内配色登记', () => {
  it('先登记源，同 uid 幂等，历史颜色不回收，第三 uid 明确不可用', () => {
    const registry = new TaskColorRegistry('task', 'source', 'alice');
    expect(registry.getSnapshot().revision).toBe(1);
    expect(registry.assign('alice').color_value).toBe('#2563EB');
    expect(registry.assign('bob').color_value).toBe('#C2410C');
    expect(registry.assign('bob').color_key).toBe('cursor-v1-02');
    expect(registry.getSnapshot().revision).toBe(2);
    expect(registry.assign('carol')).toBeNull();
    expect(Object.isFrozen(registry.getSnapshot().assignments)).toBe(true);
  });

  it('完整快照保留已有登记，旧 revision 不回退，新 revision 只能追加', () => {
    const registry = new TaskColorRegistry('task', 'source', 'alice');
    const first = registry.getSnapshot();
    registry.assign('bob');
    const second = registry.getSnapshot();
    expect(validateColorRegistry(second, 'task', 'source', first, [])).toEqual(second);
    expect(validateColorRegistry(first, 'task', 'source', second, [])).toEqual(second);
    expect(validateColorRegistry(first, 'other', 'source', null, [])).toBeNull();
    expect(validateColorRegistry(first, 'task', 'other', null, [])).toBeNull();
  });

  it.each([
    value => ({ ...value, revision: 0 }),
    value => ({ ...value, assignments: [] }),
    value => ({ ...value, assignments: [value.assignments[0], value.assignments[0]] }),
    value => ({ ...value, assignments: [{ ...value.assignments[0], color_value: '#ffffff' }] }),
    value => ({ ...value, assignments: [{ ...value.assignments[0], color_key: 'unknown' }] }),
    value => ({ ...value, assignments: [{ ...value.assignments[0], token: 'secret' }] }),
    value => ({ ...value, assignments: [{ ...value.assignments[0], uid: '' }] }),
  ])('拒绝格式、颜色、修订号或白名单冲突 %#', change => {
    const value = new TaskColorRegistry('task', 'source', 'alice').getSnapshot();
    expect(validateColorRegistry(change(value), 'task', 'source', null, [])).toBeNull();
  });

  it('拒绝同修订变色、删除历史 uid、重复 RGB 及成员缺色', () => {
    const registry = new TaskColorRegistry('task', 'source', 'alice');
    const first = registry.getSnapshot();
    registry.assign('bob');
    const second = registry.getSnapshot();
    const changed = { ...first, assignments: [{ ...first.assignments[0], uid: 'bob' }] };
    expect(validateColorRegistry(changed, 'task', 'source', first, [])).toBeNull();
    expect(
      validateColorRegistry(
        { ...second, assignments: [second.assignments[1]] },
        'task',
        'source',
        second,
        []
      )
    ).toBeNull();
    expect(
      validateColorRegistry(
        { ...second, assignments: second.assignments.map(a => ({ ...a, color_value: '#2563EB' })) },
        'task',
        'source',
        null,
        []
      )
    ).toBeNull();
    expect(
      validateColorRegistry(first, 'task', 'source', null, [
        { user: { uid: 'bob' }, color_key: 'cursor-v1-02' },
      ] as unknown as LocalParticipantSnapshot[])
    ).toBeNull();
    expect(
      validateColorRegistry(first, 'task', 'source', null, [
        { user: { uid: 'alice' }, color_key: 'wrong' },
      ] as unknown as LocalParticipantSnapshot[])
    ).toBeNull();
  });

  it('固定两色白字实际对比达到 4.5', () => {
    const registry = new TaskColorRegistry('task', 'source', 'alice');
    registry.assign('bob');
    for (const { color_value } of registry.getSnapshot().assignments) {
      const rgb = color_value
        .slice(1)
        .match(/../g)
        .map(value => parseInt(value, 16) / 255);
      const linear = rgb.map(value =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      );
      const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
