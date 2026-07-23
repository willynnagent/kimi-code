import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DESKTOP_TOGGLE_SIDEBAR_EVENT,
  onDesktopToggleSidebar,
} from '../src/lib/desktopEvents';
import { useSidebarLayout } from '../src/composables/useSidebarLayout';
import { STORAGE_KEYS } from '../src/lib/storage';

// F15:壳侧菜单(⌘B)经 preload 派发 window CustomEvent 'desktop:toggle-sidebar',
// kimi-web 收到即切换侧栏折叠;折叠状态持久化在 localStorage。
// 测试环境为 node(无 jsdom):window 用 EventTarget 桩、localStorage 用手动桩。

class LocalStorageStub implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const originalWindow = globalThis.window;

beforeEach(() => {
  globalThis.localStorage = new LocalStorageStub();
  globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
});

afterEach(() => {
  globalThis.window = originalWindow;
});

describe('desktop:toggle-sidebar 事件桥接', () => {
  it('收到事件 → 触发 handler;取消监听后不再触发', () => {
    let calls = 0;
    const off = onDesktopToggleSidebar(() => {
      calls += 1;
    });
    window.dispatchEvent(new Event(DESKTOP_TOGGLE_SIDEBAR_EVENT));
    expect(calls).toBe(1);
    window.dispatchEvent(new CustomEvent(DESKTOP_TOGGLE_SIDEBAR_EVENT));
    expect(calls).toBe(2);
    off();
    window.dispatchEvent(new Event(DESKTOP_TOGGLE_SIDEBAR_EVENT));
    expect(calls).toBe(2);
  });

  it('事件名契约固定为 desktop:toggle-sidebar', () => {
    expect(DESKTOP_TOGGLE_SIDEBAR_EVENT).toBe('desktop:toggle-sidebar');
  });
});

describe('侧栏折叠状态持久化(useSidebarLayout)', () => {
  it('toggle 往返写入 localStorage;重新 load 恢复状态', () => {
    const layout = useSidebarLayout();
    expect(layout.sidebarCollapsed.value).toBe(false);

    layout.toggleSidebarCollapse();
    expect(layout.sidebarCollapsed.value).toBe(true);
    expect(globalThis.localStorage.getItem(STORAGE_KEYS.sidebarCollapsed)).toBe('true');

    layout.toggleSidebarCollapse();
    expect(globalThis.localStorage.getItem(STORAGE_KEYS.sidebarCollapsed)).toBe('false');

    // 模拟重启:先有持久化的折叠状态,新实例 load 后恢复
    layout.toggleSidebarCollapse();
    const restored = useSidebarLayout();
    restored.loadSidebarCollapsed();
    expect(restored.sidebarCollapsed.value).toBe(true);
  });

  it('损坏的存储值 → 视为未折叠', () => {
    globalThis.localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, 'not-a-bool');
    const layout = useSidebarLayout();
    layout.loadSidebarCollapsed();
    expect(layout.sidebarCollapsed.value).toBe(false);
  });
});
