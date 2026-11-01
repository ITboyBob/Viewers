import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'fs';
import path from 'path';
import type { TaskColorRegistrySnapshot } from '@ohif/core';
import RemoteCursorOverlay, { layoutRemoteCursorLabel } from './RemoteCursorOverlay';
import type { RemoteCursorDisplay, RemoteCursorOverlayProps } from './RemoteCursorOverlay';

const registry: TaskColorRegistrySnapshot = {
  task_id: 'task-1',
  source_participant_id: 'source-1',
  revision: 2,
  assignments: [
    { uid: 'uid-local', color_key: 'cursor-v1-01', color_value: '#2563EB' },
    { uid: 'uid-remote', color_key: 'cursor-v1-02', color_value: '#C2410C' },
  ],
};

function display(overrides: Partial<RemoteCursorDisplay> = {}): RemoteCursorDisplay {
  return {
    participant: {
      participant_id: 'remote-1',
      user: { uid: 'uid-remote', username: '真实远端用户名' },
      color_key: 'cursor-v1-02',
    },
    point: { x: 100, y: 80 },
    ...overrides,
  };
}

function props(overrides: Partial<RemoteCursorOverlayProps> = {}): RemoteCursorOverlayProps {
  return {
    selfParticipantId: 'local-1',
    cursors: [display()],
    colorRegistry: registry,
    viewportSize: { width: 400, height: 300 },
    ...overrides,
  };
}

afterEach(cleanup);

describe('远端箭头和真实用户名', () => {
  it('仅过滤自身 participant，保留同 uid 的其他实例与完整颜色登记', () => {
    const local = display({ participant: { ...display().participant, participant_id: 'local-1' } });
    const view = render(
      React.createElement(RemoteCursorOverlay, props({ cursors: [local, display()] }))
    );
    expect(view.container.querySelectorAll('[data-remote-cursor]')).toHaveLength(1);
    expect(view.getByText('真实远端用户名')).toBeTruthy();
    expect(registry.assignments).toHaveLength(2);
  });

  it('用户名按纯文本展示，没有 tooltip、点击或悬停补全', () => {
    const username = '<img src=x onerror=alert(1)>';
    const remote = display({
      participant: { ...display().participant, user: { uid: 'uid-remote', username } },
    });
    const view = render(React.createElement(RemoteCursorOverlay, props({ cursors: [remote] })));
    expect(view.getByText(username)).toBeTruthy();
    expect(view.container.querySelector('img, [title], button, a, [role="tooltip"]')).toBeNull();
  });

  it('箭头填充和标签背景只取该 uid 的登记值', () => {
    const view = render(React.createElement(RemoteCursorOverlay, props()));
    expect(view.container.querySelector('path').getAttribute('fill')).toBe('#C2410C');
    expect(
      (view.container.querySelector('[data-cursor-label]') as HTMLElement).style.backgroundColor
    ).toBe('rgb(194, 65, 12)');
    const swapped = {
      ...registry,
      assignments: registry.assignments.map(value =>
        value.uid === 'uid-remote'
          ? { ...value, color_value: '#2563EB' }
          : { ...value, color_value: '#C2410C' }
      ),
    };
    view.rerender(React.createElement(RemoteCursorOverlay, props({ colorRegistry: swapped })));
    expect(view.container.querySelector('path').getAttribute('fill')).toBe('#2563EB');
  });

  it('缺失登记或成员 key 不匹配时隐藏，不猜色', () => {
    const view = render(
      React.createElement(
        RemoteCursorOverlay,
        props({ colorRegistry: { ...registry, assignments: [] } })
      )
    );
    expect(view.container.querySelector('[data-remote-cursor]')).toBeNull();
    view.rerender(
      React.createElement(
        RemoteCursorOverlay,
        props({
          cursors: [display({ participant: { ...display().participant, color_key: 'unknown' } })],
        })
      )
    );
    expect(view.container.querySelector('[data-remote-cursor]')).toBeNull();
  });

  it('CSS 尺寸、白描边与实际尖端锚点固定，不随影像 zoom 变化', () => {
    const view = render(React.createElement(RemoteCursorOverlay, props()));
    const svg = view.container.querySelector('svg');
    const arrow = view.container.querySelector('path');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('height')).toBe('24');
    expect(svg.getAttribute('viewBox')).toBe('0 0 20 24');
    expect(arrow.getAttribute('stroke')).toBe('#FFFFFF');
    expect(arrow.getAttribute('stroke-width')).toBe('1.5');
    expect(arrow.getAttribute('stroke-linejoin')).toBe('round');
    expect(arrow.getAttribute('d')).toMatch(/^M 0\.75 0\.75 /);
    expect(svg.style.left).toBe('-0.75px');
    expect(svg.style.top).toBe('-0.75px');
    const marker = view.container.querySelector('[data-remote-cursor]') as HTMLElement;
    expect(marker.style.left).toBe('100px');
    expect(marker.style.top).toBe('80px');
  });

  it('真实 CSS 保持白字、单行省略、固定标签和透明指针层', () => {
    const sheet = document.createElement('style');
    sheet.textContent = readFileSync(path.join(__dirname, 'RemoteCursorOverlay.css'), 'utf8');
    document.head.appendChild(sheet);
    try {
      const view = render(React.createElement(RemoteCursorOverlay, props()));
      const overlay = view.container.firstElementChild;
      const label = view.container.querySelector('[data-cursor-label]');
      const text = view.container.querySelector('[data-cursor-username]');
      expect(getComputedStyle(overlay).pointerEvents).toBe('none');
      expect(getComputedStyle(overlay).overflow).toBe('hidden');
      expect(getComputedStyle(label).pointerEvents).toBe('none');
      expect(getComputedStyle(label).color).toBe('rgb(255, 255, 255)');
      expect(getComputedStyle(label).fontSize).toBe('12px');
      expect(getComputedStyle(label).lineHeight).toBe('16px');
      expect(getComputedStyle(label).fontWeight).toBe('500');
      expect(getComputedStyle(label).height).toBe('22px');
      expect(getComputedStyle(label).padding).toBe('3px 6px');
      expect(getComputedStyle(label).borderRadius).toBe('4px');
      expect(getComputedStyle(label).maxWidth).toBe('132px');
      expect(getComputedStyle(text).maxWidth).toBe('120px');
      // jsdom 不计算 max-content，直接核验样式声明；真实字体布局另由浏览器验证。
      const textRule = Array.from((sheet.sheet as CSSStyleSheet).cssRules).find(
        rule => (rule as CSSStyleRule).selectorText === '.remote-cursor-username'
      ) as CSSStyleRule;
      expect(textRule.style.getPropertyValue('width')).toBe('max-content');
      expect(getComputedStyle(text).whiteSpace).toBe('nowrap');
      expect(getComputedStyle(text).textOverflow).toBe('ellipsis');
      expect(getComputedStyle(text).overflow).toBe('hidden');
    } finally {
      sheet.remove();
    }
  });

  it('DOM 字体宽度变化后重新测量，保持右边距及尖端位置', () => {
    let textWidth = 24;
    const scrollWidth = jest
      .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockImplementation(() => textWidth);
    const observers: Array<() => void> = [];
    const disconnect = jest.fn();
    const previous = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(callback => {
      observers.push(callback);
      return { observe: jest.fn(), disconnect };
    });
    try {
      const view = render(
        React.createElement(
          RemoteCursorOverlay,
          props({
            cursors: [display({ point: { x: 150, y: 80 } })],
            viewportSize: { width: 220, height: 200 },
          })
        )
      );
      const marker = view.container.querySelector('[data-remote-cursor]') as HTMLElement;
      const label = view.container.querySelector('[data-cursor-label]') as HTMLElement;
      expect(label.style.left).toBe('24px');
      expect(label.style.width).toBe('36px');
      textWidth = 180;
      act(() => observers.forEach(callback => callback()));
      expect(label.style.width).toBe('132px');
      expect(label.style.left).toBe('-146px');
      expect(marker.style.left).toBe('150px');
      view.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      scrollWidth.mockRestore();
      globalThis.ResizeObserver = previous;
    }
  });

  it('投影点出视口时隐藏，靠边的有效尖端保持原坐标', () => {
    const view = render(
      React.createElement(
        RemoteCursorOverlay,
        props({ cursors: [display({ point: { x: 0, y: 0 } })] })
      )
    );
    const marker = view.container.querySelector('[data-remote-cursor]') as HTMLElement;
    expect(marker.style.left).toBe('0px');
    expect(marker.style.top).toBe('0px');
    view.rerender(
      React.createElement(
        RemoteCursorOverlay,
        props({ cursors: [display({ point: { x: 400, y: 10 } })] })
      )
    );
    expect(view.container.querySelector('[data-remote-cursor]')).toBeNull();
  });

  it.each(['#2563EB', '#C2410C'])('候选 %s 与白字的实际对比超过 4.5', value => {
    const channels = [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255);
    const linear = channels.map(channel =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    );
    const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('标签纯布局', () => {
  it('默认从尖端向右 24、向下 16，使用测量文字宽度', () => {
    expect(layoutRemoteCursorLabel({ x: 100, y: 80 }, { width: 400, height: 300 }, 40)).toEqual({
      left: 124,
      top: 96,
      width: 52,
      textWidth: 40,
    });
  });

  it('长姓名最大文字 120、外宽 132，右下角优先向左及向上翻转', () => {
    expect(layoutRemoteCursorLabel({ x: 390, y: 290 }, { width: 400, height: 300 }, 300)).toEqual({
      left: 234,
      top: 252,
      width: 132,
      textWidth: 120,
    });
  });

  it('翻转空间不足时只缩短标签并保留四边 4px', () => {
    expect(layoutRemoteCursorLabel({ x: 30, y: 20 }, { width: 50, height: 40 }, 120)).toEqual({
      left: 4,
      top: 4,
      width: 42,
      textWidth: 30,
    });
  });

  it.each([
    [{ x: -1, y: 0 }, { width: 400, height: 300 }, 40],
    [{ x: NaN, y: 0 }, { width: 400, height: 300 }, 40],
    [{ x: 0, y: 300 }, { width: 400, height: 300 }, 40],
    [{ x: 0, y: 0 }, { width: Infinity, height: 300 }, 40],
    [{ x: 0, y: 0 }, { width: 20, height: 29 }, 40],
    [{ x: 0, y: 0 }, { width: 19, height: 100 }, 40],
    [{ x: 0, y: 0 }, { width: 400, height: 300 }, NaN],
    [{ x: 0, y: 0 }, { width: 400, height: 300 }, -1],
  ])('无效几何或无法满足边距时不生成标签', (point, size, textWidth) => {
    expect(layoutRemoteCursorLabel(point, size, textWidth)).toBeNull();
  });
});
