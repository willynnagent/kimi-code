import { beforeEach, describe, expect, it } from 'vitest';

import {
  loadLastSessionMap,
  recallLastSession,
  rememberLastSession,
} from '../src/components/codex/useLastSessionMap';

// M3 Task 3.3:workspace_id → last_session_id 映射(桌面自有 UI 元数据)。
// 测试环境为 node(无 jsdom),手动注入 localStorage 桩。

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

describe('useLastSessionMap', () => {
  it('空存储 → 空映射', () => {
    expect(loadLastSessionMap()).toEqual({});
  })

  it('remember → recall 往返;重复记录不膨胀', () => {
    rememberLastSession('wd_a', 's1');
    rememberLastSession('wd_a', 's2');
    rememberLastSession('wd_b', 's9');
    expect(loadLastSessionMap()).toEqual({ wd_a: 's2', wd_b: 's9' });
    expect(recallLastSession('wd_a', () => true)).toBe('s2');
    expect(recallLastSession('wd_b', () => true)).toBe('s9');
  });

  it('会话不存在 → 返回 null 并清理失效记录(回退语义)', () => {
    rememberLastSession('wd_a', 's1');
    expect(recallLastSession('wd_a', () => false)).toBeNull();
    expect(loadLastSessionMap()).toEqual({});
  });

  it('未记录的项目 → null', () => {
    expect(recallLastSession('wd_x', () => true)).toBeNull();
  });

  it('损坏的存储值 → 空映射', () => {
    globalThis.localStorage.setItem('codex.lastSessionByWorkspace', 'not-json');
    expect(loadLastSessionMap()).toEqual({});
    globalThis.localStorage.setItem('codex.lastSessionByWorkspace', '[1,2]');
    expect(loadLastSessionMap()).toEqual({});
  });
});
