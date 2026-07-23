import { beforeEach, describe, expect, it } from 'vitest';

import {
  loadPinnedWorkspaces,
  orderWithPinnedFirst,
  prunePinnedWorkspaces,
  savePinnedWorkspaces,
  toggleWorkspacePinned,
} from '../src/components/codex/usePinnedWorkspaces';

// F17:项目置顶(桌面自有 UI 元数据,localStorage `codex.pinnedWorkspaces`)。
// 测试环境为 node(无 jsdom),手动注入 localStorage 桩(同
// codex-last-session-map.test.ts 的模式)。

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

beforeEach(() => {
  globalThis.localStorage = new LocalStorageStub();
});

describe('usePinnedWorkspaces 存储', () => {
  it('空存储 → 空数组', () => {
    expect(loadPinnedWorkspaces()).toEqual([]);
  });

  it('save → load 往返', () => {
    savePinnedWorkspaces(['wd_a', 'wd_b']);
    expect(loadPinnedWorkspaces()).toEqual(['wd_a', 'wd_b']);
  });

  it('损坏/非字符串值 → 过滤或回退空数组', () => {
    globalThis.localStorage.setItem('codex.pinnedWorkspaces', 'not-json');
    expect(loadPinnedWorkspaces()).toEqual([]);
    globalThis.localStorage.setItem('codex.pinnedWorkspaces', '[1,"wd_a","wd_a",""]');
    expect(loadPinnedWorkspaces()).toEqual(['wd_a']);
  });

  it('toggle:置顶 → 取消置顶 → 再置顶', () => {
    let pinned: string[] = [];
    pinned = toggleWorkspacePinned(pinned, 'wd_a');
    pinned = toggleWorkspacePinned(pinned, 'wd_b');
    expect(pinned).toEqual(['wd_a', 'wd_b']);
    pinned = toggleWorkspacePinned(pinned, 'wd_a');
    expect(pinned).toEqual(['wd_b']);
    // toggle 不修改入参
    expect(toggleWorkspacePinned(pinned, 'wd_a')).toEqual(['wd_b', 'wd_a']);
    expect(pinned).toEqual(['wd_b']);
  });
});

describe('orderWithPinnedFirst 排序', () => {
  const groups = [
    { workspace: { id: 'wd_1' } },
    { workspace: { id: 'wd_2' } },
    { workspace: { id: 'wd_3' } },
    { workspace: { id: 'wd_4' } },
  ];
  const ids = (list: typeof groups) => list.map((g) => g.workspace.id);

  it('无置顶 → 原顺序', () => {
    expect(ids(orderWithPinnedFirst(groups, [], (g) => g.workspace.id))).toEqual([
      'wd_1',
      'wd_2',
      'wd_3',
      'wd_4',
    ]);
  });

  it('置顶在前;置顶组与非置顶组内部各自保持官方 recent 顺序', () => {
    expect(
      ids(orderWithPinnedFirst(groups, ['wd_3', 'wd_1'], (g) => g.workspace.id)),
    ).toEqual(['wd_1', 'wd_3', 'wd_2', 'wd_4']);
  });

  it('置顶 id 不在列表中(残留)→ 忽略,不影响其余顺序', () => {
    expect(
      ids(orderWithPinnedFirst(groups, ['wd_gone', 'wd_4'], (g) => g.workspace.id)),
    ).toEqual(['wd_4', 'wd_1', 'wd_2', 'wd_3']);
  });
});

describe('prunePinnedWorkspaces 失效清理', () => {
  it('清掉已移除的 workspace id,保留有效顺序', () => {
    const { next, changed } = prunePinnedWorkspaces(
      ['wd_a', 'wd_gone', 'wd_b'],
      new Set(['wd_a', 'wd_b']),
    );
    expect(next).toEqual(['wd_a', 'wd_b']);
    expect(changed).toBe(true);
  });

  it('全部有效 → changed=false(调用方不必回写)', () => {
    const { next, changed } = prunePinnedWorkspaces(['wd_a'], new Set(['wd_a', 'wd_b']));
    expect(next).toEqual(['wd_a']);
    expect(changed).toBe(false);
  });

  it('全部失效 → 清空', () => {
    const { next, changed } = prunePinnedWorkspaces(['wd_a'], new Set());
    expect(next).toEqual([]);
    expect(changed).toBe(true);
  });
});
