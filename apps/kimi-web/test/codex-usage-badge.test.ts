import { describe, expect, it } from 'vitest';

import {
  fetchUsageInto,
  formatCents,
  formatHitRate,
  formatResetAt,
  formatTokenCount,
  formatUpdatedAt,
  formatUsedPct,
  resolveUpdatedAt,
  resolveUsageApi,
  type DesktopUsageApi,
  type QuotaStatus,
  type DailyUsageStats,
  type UsageState,
} from '../src/components/codex/useDesktopUsage';

// 桌面壳用量弹层(R1 额度 / R2 当天用量)的纯逻辑测试。
// 本包 vitest 运行在 node 环境(无 jsdom / 组件挂载,见 apps/kimi-web/AGENTS.md),
// 因此"无 desktopBridge 不渲染"通过渲染门槛 resolveUsageApi 覆盖。

const okQuota: QuotaStatus = {
  kind: 'ok',
  plan: null,
  weekly: null,
  fiveHour: null,
  others: [],
  booster: null,
  fetchedAt: 1,
  stale: false,
};
const okDaily: DailyUsageStats = {
  kind: 'ok',
  totals: { date: '2026-07-22', cacheRead: 100, inputMiss: 50, output: 10, hitRate: 2 / 3 },
  fetchedAt: 2,
  stale: false,
};

describe('resolveUsageApi(渲染门槛:浏览器环境不渲染)', () => {
  it('无 desktop bridge → undefined', () => {
    expect(resolveUsageApi(undefined)).toBeUndefined();
    expect(resolveUsageApi({})).toBeUndefined();
    expect(resolveUsageApi({ usage: {} })).toBeUndefined();
  });

  it('两个接口缺一 → undefined', () => {
    expect(resolveUsageApi({ usage: { getQuota: async () => okQuota } })).toBeUndefined();
    expect(resolveUsageApi({ usage: { getDailyStats: async () => okDaily } })).toBeUndefined();
  });

  it('两个接口齐全 → 返回 api', () => {
    const api: DesktopUsageApi = {
      getQuota: async () => okQuota,
      getDailyStats: async () => okDaily,
    };
    expect(resolveUsageApi({ usage: api })).toBe(api);
  });
});

describe('formatTokenCount(K/M/B 缩写)', () => {
  it('小于 1000 原样', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('K 段保留一位小数并去尾零', () => {
    expect(formatTokenCount(1000)).toBe('1K');
    expect(formatTokenCount(12345)).toBe('12.3K');
    expect(formatTokenCount(999999)).toBe('1000K');
  });

  it('M / B 段', () => {
    expect(formatTokenCount(12345678)).toBe('12.3M');
    expect(formatTokenCount(2_000_000)).toBe('2M');
    expect(formatTokenCount(3_400_000_000)).toBe('3.4B');
  });

  it('非法输入归 0', () => {
    expect(formatTokenCount(Number.NaN)).toBe('0');
    expect(formatTokenCount(-5)).toBe('0');
  });
});

describe('formatResetAt(重置时间)', () => {
  const now = new Date(2026, 6, 22, 12, 0, 0); // 2026-07-22 12:00 本地时间

  it('同一本地日 → 时分', () => {
    const iso = new Date(2026, 6, 22, 17, 20, 0).toISOString();
    expect(formatResetAt(iso, now, true)).toBe('17:20 重置');
    expect(formatResetAt(iso, now, false)).toBe('Resets 17:20');
  });

  it('跨天 → 日期 + 时分(精确到分)', () => {
    const iso = new Date(2026, 6, 29, 9, 5, 0).toISOString();
    expect(formatResetAt(iso, now, true)).toBe('7月29日 09:05 重置');
    expect(formatResetAt(iso, now, false)).toBe('Resets Jul 29, 09:05');
  });

  it('null / 非法 → 空串', () => {
    expect(formatResetAt(null, now, true)).toBe('');
    expect(formatResetAt('not-a-date', now, true)).toBe('');
  });
});

describe('formatCents / formatHitRate / formatUsedPct', () => {
  it('cents → 货币', () => {
    expect(formatCents(1234, 'USD')).toContain('12.34');
    expect(formatCents(0, 'CNY')).toContain('0.00');
  });

  it('命中率:null → "—",否则整数百分比', () => {
    expect(formatHitRate(null)).toBe('—');
    expect(formatHitRate(2 / 3)).toBe('67%');
    expect(formatHitRate(1)).toBe('100%');
    expect(formatHitRate(0.3286)).toBe('33%');
  });

  it('已用占比(剩余换算):null → "—",否则整数百分比', () => {
    expect(formatUsedPct(null)).toBe('—');
    expect(formatUsedPct(0.81)).toBe('19%');
    expect(formatUsedPct(0)).toBe('100%');
    expect(formatUsedPct(0.6714)).toBe('33%');
  });
});

describe('formatUpdatedAt(F22:取数时间)', () => {
  const at = new Date(2026, 6, 22, 14, 3, 5).getTime(); // 14:03:05 本地时间

  it('正常 → "更新于 HH:mm:ss" / "Updated HH:mm:ss"', () => {
    expect(formatUpdatedAt(at, false, true)).toBe('更新于 14:03:05');
    expect(formatUpdatedAt(at, false, false)).toBe('Updated 14:03:05');
  });

  it('stale → 追加缓存标注', () => {
    expect(formatUpdatedAt(at, true, true)).toBe('更新于 14:03:05(缓存)');
    expect(formatUpdatedAt(at, true, false)).toBe('Updated 14:03:05 (cached)');
  });

  it('非法时间戳 → 空串', () => {
    expect(formatUpdatedAt(Number.NaN, false, true)).toBe('');
  });
});

describe('resolveUpdatedAt(F22:取较旧的取数时刻)', () => {
  const quotaAt = (fetchedAt: number, stale = false): QuotaStatus => ({
    kind: 'ok',
    plan: null,
    weekly: null,
    fiveHour: null,
    others: [],
    booster: null,
    fetchedAt,
    stale,
  });
  const dailyAt = (fetchedAt: number, stale = false): DailyUsageStats =>
    okDaily.kind === 'ok'
      ? { kind: 'ok', totals: okDaily.totals, fetchedAt, stale }
      : { kind: 'error', error: 'unreachable' };

  it('两边都 ok → 取较旧者;任一侧 stale 即整体 stale', () => {
    expect(resolveUpdatedAt(quotaAt(200), dailyAt(100))).toEqual({ at: 100, stale: false });
    expect(resolveUpdatedAt(quotaAt(100), dailyAt(200))).toEqual({ at: 100, stale: false });
    expect(resolveUpdatedAt(quotaAt(200, true), dailyAt(100))).toEqual({ at: 100, stale: true });
    expect(resolveUpdatedAt(quotaAt(200), dailyAt(100, true))).toEqual({ at: 100, stale: true });
  });

  it('仅一侧 ok → 用该侧;另一侧 error/unauthorized 不参与', () => {
    expect(resolveUpdatedAt(quotaAt(150), { kind: 'error', error: 'x' })).toEqual({
      at: 150,
      stale: false,
    });
    expect(resolveUpdatedAt({ kind: 'unauthorized' }, dailyAt(160, true))).toEqual({
      at: 160,
      stale: true,
    });
    expect(resolveUpdatedAt(null, dailyAt(170))).toEqual({ at: 170, stale: false });
  });

  it('两边都未取到 → null(不渲染该行)', () => {
    expect(resolveUpdatedAt(null, null)).toBeNull();
    expect(
      resolveUpdatedAt({ kind: 'error', error: 'x' }, { kind: 'error', error: 'y' }),
    ).toBeNull();
  });
});

describe('fetchUsageInto(并行拉取,失败保留旧数据)', () => {
  function state(): UsageState {
    return { quota: { kind: 'unauthorized' }, daily: { kind: 'error', error: 'old' } };
  }

  it('两个接口都成功 → 都更新', async () => {
    const s = state();
    await fetchUsageInto(
      { getQuota: async () => okQuota, getDailyStats: async () => okDaily },
      s,
    );
    expect(s.quota).toBe(okQuota);
    expect(s.daily).toBe(okDaily);
  });

  it('一个 throw → 该段保留旧数据,另一段照常更新(互不影响)', async () => {
    const s = state();
    await fetchUsageInto(
      {
        getQuota: async () => {
          throw new Error('ipc down');
        },
        getDailyStats: async () => okDaily,
      },
      s,
    );
    expect(s.quota).toEqual({ kind: 'unauthorized' });
    expect(s.daily).toBe(okDaily);
  });

  it('两个都 throw → 都保留旧数据', async () => {
    const s = state();
    await fetchUsageInto(
      {
        getQuota: async () => {
          throw new Error('x');
        },
        getDailyStats: async () => {
          throw new Error('y');
        },
      },
      s,
    );
    expect(s.quota).toEqual({ kind: 'unauthorized' });
    expect(s.daily).toEqual({ kind: 'error', error: 'old' });
  });

  it('接口自身的 kind:error 照常写入(由 UI 展示错误态)', async () => {
    const s: UsageState = { quota: okQuota, daily: okDaily };
    await fetchUsageInto(
      {
        getQuota: async () => ({ kind: 'error', error: 'HTTP 500' }),
        getDailyStats: async () => ({ kind: 'error', error: 'scan failed' }),
      },
      s,
    );
    expect(s.quota).toEqual({ kind: 'error', error: 'HTTP 500' });
    expect(s.daily).toEqual({ kind: 'error', error: 'scan failed' });
  });
});
