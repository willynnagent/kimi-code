<!-- apps/kimi-web/src/components/codex/CodexUsageBadge.vue -->
<!-- 桌面壳用量入口:侧栏 footer 的"剩余用量"文字按钮(样式对齐"设置"),
     hover / focus-visible 弹出悬浮层,展示 R1 订阅额度(5h/周/加量包)
     与 R2 当天 token 用量。数据经壳 preload
     的 window.desktop.usage(浏览器环境不存在 → 整个组件不渲染)。
     弹层显隐纯 CSS(:hover / :focus-within),无 JS 定时器。 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  formatCents,
  formatHitRate,
  formatResetAt,
  formatTokenCount,
  formatUsedPct,
  resolveUsageApi,
  useDesktopUsage,
  type DesktopUsageBridge,
  type QuotaWindow,
} from './useDesktopUsage';
import Button from '../ui/Button.vue';

const { locale } = useI18n();

const zhLabel = (zh: string, en: string): string =>
  locale.value.startsWith('zh') ? zh : en;
const zh = computed(() => locale.value.startsWith('zh'));

// 与 CodexSidebar 相同模式:就地声明最小接口,浏览器中不存在 → v-if 不渲染。
const desktopBridge: DesktopUsageBridge | undefined = (
  window as unknown as { desktop?: DesktopUsageBridge }
).desktop;
const usageApi = resolveUsageApi(desktopBridge);

const { quota, daily, refresh } = useDesktopUsage(usageApi);

// ── R1:额度窗口行(5h / 周 / 其他)────────────────────────────────────────
interface QuotaRow {
  key: string;
  label: string;
  /** 剩余占比 0..1(展示与进度条均换算为已用) */
  pct: number | null;
  reset: string;
}

const quotaRows = computed<QuotaRow[]>(() => {
  const q = quota.value;
  if (q?.kind !== 'ok') return [];
  const rows: QuotaRow[] = [];
  const push = (w: QuotaWindow | null, key: string, label: string): void => {
    if (!w) return;
    rows.push({
      key,
      label,
      pct: w.remainingPct,
      reset: formatResetAt(w.resetAt, new Date(), zh.value),
    });
  };
  push(q.fiveHour, 'fiveHour', zhLabel('5 小时额度', '5-hour quota'));
  push(q.weekly, 'weekly', zhLabel('本周额度', 'Weekly quota'));
  for (const [i, w] of q.others.entries()) push(w, `other-${i}`, w.label);
  return rows;
});

const boosterText = computed(() => {
  const q = quota.value;
  if (q?.kind !== 'ok' || !q.booster) return '';
  const b = q.booster;
  return zhLabel(
    `加量包余额 ${formatCents(b.balanceCents, b.currency)} · 本月已用 ${formatCents(b.monthlyUsedCents, b.currency)}`,
    `Booster balance ${formatCents(b.balanceCents, b.currency)} · used this month ${formatCents(b.monthlyUsedCents, b.currency)}`,
  );
});

// ── R2:当天 token 用量 ──────────────────────────────────────────────────
const dailyTotals = computed(() =>
  daily.value?.kind === 'ok' ? daily.value.totals : null,
);
const totalInput = computed(() => {
  const t = dailyTotals.value;
  return t ? t.cacheRead + t.inputMiss : 0;
});
</script>

<template>
  <div v-if="usageApi" class="codex-usage">
    <!-- 文字触发器(2026-07-23 用户评审):样式与左侧"设置"按钮一致 -->
    <button type="button" class="codex-usage-btn">
      {{ zhLabel('剩余用量', 'Usage') }}
    </button>

    <div class="codex-usage-pop" role="tooltip">
      <!-- R1:订阅额度 -->
      <div class="codex-usage-section">
        <div class="codex-usage-title">{{ zhLabel('订阅额度', 'Subscription quota') }}</div>

        <template v-if="quota">
          <template v-if="quota.kind === 'ok'">
            <div v-if="quota.plan" class="codex-usage-row">
              <span class="codex-usage-label">{{ zhLabel('套餐', 'Plan') }}</span>
              <span class="codex-usage-value">{{ quota.plan }}</span>
            </div>
            <div v-for="row in quotaRows" :key="row.key" class="codex-usage-quota">
              <div class="codex-usage-row">
                <span class="codex-usage-label">{{ row.label }}</span>
                <span class="codex-usage-value">
                  {{ zhLabel(`已用 ${formatUsedPct(row.pct)}`, `${formatUsedPct(row.pct)} used`) }}
                </span>
              </div>
              <div v-if="row.pct !== null" class="codex-usage-bar">
                <div class="codex-usage-fill" :style="{ width: `${Math.round((1 - row.pct) * 100)}%` }" />
              </div>
              <div v-if="row.reset" class="codex-usage-sub">{{ row.reset }}</div>
            </div>
            <div v-if="boosterText" class="codex-usage-sub">{{ boosterText }}</div>
            <div v-if="quota.stale" class="codex-usage-stale">
              {{ zhLabel('数据可能过期', 'Data may be stale') }}
            </div>
          </template>

          <div v-else-if="quota.kind === 'unauthorized'" class="codex-usage-sub">
            {{ zhLabel('未登录', 'Not logged in') }}
          </div>

          <div v-else class="codex-usage-error">
            <span class="codex-usage-sub">{{ quota.error }}</span>
            <Button variant="secondary" size="sm" @click="void refresh()">
              {{ zhLabel('重试', 'Retry') }}
            </Button>
          </div>
        </template>
        <div v-else class="codex-usage-sub">{{ zhLabel('加载中…', 'Loading…') }}</div>
      </div>

      <div class="codex-usage-divider" />

      <!-- R2:当天 token 用量 -->
      <div class="codex-usage-section">
        <div class="codex-usage-title">{{ zhLabel('今日用量', "Today's usage") }}</div>

        <template v-if="daily">
          <template v-if="dailyTotals">
            <div class="codex-usage-row">
              <span class="codex-usage-label">{{ zhLabel('缓存命中率', 'Cache hit rate') }}</span>
              <span class="codex-usage-value">{{ formatHitRate(dailyTotals.hitRate) }}</span>
            </div>
            <div class="codex-usage-row">
              <span class="codex-usage-label">{{ zhLabel('总输入', 'Total input') }}</span>
              <span class="codex-usage-value">{{ formatTokenCount(totalInput) }}</span>
            </div>
            <div class="codex-usage-row">
              <span class="codex-usage-label codex-usage-sub">{{ zhLabel('命中 / 未命中', 'Hit / miss') }}</span>
              <span class="codex-usage-value codex-usage-sub">
                {{ formatTokenCount(dailyTotals.cacheRead) }} / {{ formatTokenCount(dailyTotals.inputMiss) }}
              </span>
            </div>
            <div class="codex-usage-row">
              <span class="codex-usage-label">{{ zhLabel('总输出', 'Total output') }}</span>
              <span class="codex-usage-value">{{ formatTokenCount(dailyTotals.output) }}</span>
            </div>
            <div v-if="daily.kind === 'ok' && daily.stale" class="codex-usage-stale">
              {{ zhLabel('数据可能过期', 'Data may be stale') }}
            </div>
          </template>

          <div v-else-if="daily.kind === 'error'" class="codex-usage-error">
            <span class="codex-usage-sub">{{ daily.error }}</span>
            <Button variant="secondary" size="sm" @click="void refresh()">
              {{ zhLabel('重试', 'Retry') }}
            </Button>
          </div>
        </template>
        <div v-else class="codex-usage-sub">{{ zhLabel('加载中…', 'Loading…') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 触发器:footer 右侧的文字按钮,字号/字体与左侧"设置"一致
   (CodexSidebar .codex-btn-settings);弹层绝对定位于按钮上方、右对齐
   (侧栏 overflow:hidden,弹层宽度须收在侧栏内)。 */
.codex-usage {
  position: relative;
  flex: none;
  display: inline-flex;
}
.codex-usage-btn {
  padding: 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  line-height: var(--leading-tight);
  cursor: pointer;
  white-space: nowrap;
}
.codex-usage-btn:hover {
  background: var(--color-hover);
}
.codex-usage-btn:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

/* 悬浮层:纯 CSS 显隐(hover + 键盘 focus-within),无 JS 定时器。 */
.codex-usage-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: var(--z-dropdown);
  width: 208px;
  padding: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-lg);
  font-family: var(--font-ui);
  visibility: hidden;
  opacity: 0;
  transition:
    opacity var(--duration-base) var(--ease-out),
    visibility var(--duration-base);
}
.codex-usage:hover .codex-usage-pop,
.codex-usage:focus-within .codex-usage-pop {
  visibility: visible;
  opacity: 1;
}

.codex-usage-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.codex-usage-title {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-faint);
  text-transform: uppercase;
  user-select: none;
}
.codex-usage-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--ui-font-size-sm);
  line-height: var(--leading-tight);
}
.codex-usage-label {
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-usage-value {
  flex: none;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}
.codex-usage-quota {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.codex-usage-bar {
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  overflow: hidden;
}
.codex-usage-fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}
.codex-usage-sub {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  line-height: var(--leading-tight);
  overflow-wrap: anywhere;
}
.codex-usage-stale {
  font-size: var(--text-xs);
  color: var(--color-warning);
  line-height: var(--leading-tight);
}
.codex-usage-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.codex-usage-divider {
  height: 1px;
  margin: var(--space-3) 0;
  background: var(--line);
}
</style>
