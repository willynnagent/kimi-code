import { describe, expect, it } from 'vitest';

import { resolveStatus, type BackgroundStatus } from '../src/components/codex/useBackgroundStatus';

// M3 Task 3.4:后台状态合并策略——overlay(REST 全局源)优先,缺失时回退门面。

describe('resolveStatus', () => {
  const facade = { busy: false, pending: 'none' as const };

  it('overlay 命中时以 overlay 为准(busy)', () => {
    const overlay = new Map<string, BackgroundStatus>([
      ['s1', { busy: true, pending: 'none' }],
    ]);
    expect(resolveStatus('s1', facade, overlay)).toEqual({ busy: true, pending: 'none' });
  });

  it('overlay 命中时以 overlay 为准(pending approval)', () => {
    const overlay = new Map<string, BackgroundStatus>([
      ['s1', { busy: false, pending: 'approval' }],
    ]);
    expect(
      resolveStatus('s1', { busy: true, pending: 'none' }, overlay),
    ).toEqual({ busy: false, pending: 'approval' });
  });

  it('overlay 未命中时回退门面值(订阅会话的实时状态)', () => {
    const overlay = new Map<string, BackgroundStatus>();
    expect(resolveStatus('s2', { busy: true, pending: 'question' }, overlay)).toEqual({
      busy: true,
      pending: 'question',
    });
  });

  it('overlay 的 false 也覆盖门面的 stale true(完成态以全局源为准)', () => {
    const overlay = new Map<string, BackgroundStatus>([
      ['s1', { busy: false, pending: 'none' }],
    ]);
    expect(resolveStatus('s1', { busy: true, pending: 'none' }, overlay).busy).toBe(false);
  });
});
