// 桌面壳用量(R1 订阅额度 / R2 当天 token 用量)。
// 类型镜像 apps/desktop/shared/types.ts(QuotaStatus / DailyUsageStats)——
// submodule 无法 import 壳侧文件,此处就地声明最小接口,保持字段对齐。
// 刷新模式与 useBackgroundStatus 一致:onMounted 启动轮询 + onBeforeUnmount
// 清理,单次失败保留上一份数据,下一轮自愈。

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

export interface QuotaWindow {
  label: string;
  used: number;
  limit: number;
  /** 剩余占比 0..1;limit 为 0 时 null */
  remainingPct: number | null;
  /** 重置时间 ISO 字符串;未知则 null */
  resetAt: string | null;
}

export interface BoosterInfo {
  balanceCents: number;
  totalCents: number;
  monthlyUsedCents: number;
  monthlyChargeLimitCents: number;
  monthlyChargeLimitEnabled: boolean;
  currency: string;
}

export type QuotaStatus =
  | {
      kind: 'ok';
      plan: string | null;
      weekly: QuotaWindow | null;
      fiveHour: QuotaWindow | null;
      others: QuotaWindow[];
      booster: BoosterInfo | null;
      fetchedAt: number;
      /** true = 本次拉取失败,展示的是上次成功的缓存 */
      stale: boolean;
    }
  | { kind: 'unauthorized' }
  | { kind: 'error'; error: string };

export interface DailyUsageTotals {
  date: string;
  cacheRead: number;
  inputMiss: number;
  output: number;
  /** 缓存命中率 0..1;总输入为 0 时 null */
  hitRate: number | null;
}

export type DailyUsageStats =
  | { kind: 'ok'; totals: DailyUsageTotals; stale: boolean }
  | { kind: 'error'; error: string };

/** 壳 preload 暴露的最小接口(每层可选;浏览器环境整个 desktop 不存在) */
export interface DesktopUsageApi {
  getQuota?: () => Promise<QuotaStatus>;
  getDailyStats?: () => Promise<DailyUsageStats>;
}

export interface DesktopUsageBridge {
  usage?: DesktopUsageApi;
}

/** 渲染门槛:两个接口都在才显示用量入口(组件的 v-if 条件)。 */
export function resolveUsageApi(
  bridge: DesktopUsageBridge | undefined,
): DesktopUsageApi | undefined {
  const usage = bridge?.usage;
  if (typeof usage?.getQuota === 'function' && typeof usage.getDailyStats === 'function') {
    return usage;
  }
  return undefined;
}

export const USAGE_REFRESH_INTERVAL_MS = 60_000;

/** 大数字缩写:12345 → "12.3K",12345678 → "12.3M"。 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  const units: Array<[number, string]> = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];
  for (const [base, suffix] of units) {
    if (n >= base) {
      const v = n / base;
      const text = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
      return `${text}${suffix}`;
    }
  }
  return String(Math.round(n));
}

/**
 * 重置时间:与 now 同一本地日 → "17:20 重置" / "Resets 17:20";
 * 跨天 → "7月29日 16:20 重置" / "Resets Jul 29, 16:20"(精确到分)。
 * 无法解析时返回空串。
 */
export function formatResetAt(iso: string | null, now: Date, zh: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return zh ? `${hh}:${mm} 重置` : `Resets ${hh}:${mm}`;
  }
  return zh
    ? `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm} 重置`
    : `Resets ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${hh}:${mm}`;
}

/** cents → 货币显示(如 $12.34 / ¥12.34)。 */
export function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** 命中率 0..1 → "78%";null → "—"。 */
export function formatHitRate(hitRate: number | null): string {
  if (hitRate === null) return '—';
  return `${Math.round(hitRate * 100)}%`;
}

/** 已用占比(由剩余占比换算)0..1 → "37%";null → "—"。 */
export function formatUsedPct(remainingPct: number | null): string {
  if (remainingPct === null) return '—';
  return `${Math.round((1 - remainingPct) * 100)}%`;
}

export interface UsageState {
  quota: QuotaStatus | null;
  daily: DailyUsageStats | null;
}

/**
 * 拉取两个接口写入 state:并行、互不影响;任一失败(throw)保留旧数据。
 * 接口自身的错误以 kind:'error' 表达(不算 throw),照常写入。
 */
export async function fetchUsageInto(
  api: DesktopUsageApi,
  state: UsageState,
): Promise<void> {
  const [q, d] = await Promise.all([
    api.getQuota?.().catch(() => null),
    api.getDailyStats?.().catch(() => null),
  ]);
  if (q) state.quota = q;
  if (d) state.daily = d;
}

export function useDesktopUsage(
  api: DesktopUsageApi | undefined,
  intervalMs: number = USAGE_REFRESH_INTERVAL_MS,
): {
  quota: Ref<QuotaStatus | null>;
  daily: Ref<DailyUsageStats | null>;
  refresh: () => Promise<void>;
} {
  const quota = ref<QuotaStatus | null>(null);
  const daily = ref<DailyUsageStats | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    if (!api) return;
    const state: UsageState = { quota: quota.value, daily: daily.value };
    await fetchUsageInto(api, state);
    quota.value = state.quota;
    daily.value = state.daily;
  }

  onMounted(() => {
    if (!api) return;
    void refresh();
    timer = setInterval(() => void refresh(), intervalMs);
  });
  onBeforeUnmount(() => {
    if (timer !== undefined) clearInterval(timer);
  });

  return { quota, daily, refresh };
}
