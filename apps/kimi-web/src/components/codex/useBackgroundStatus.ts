// M3 Task 3.4:非当前视图会话的后台状态(busy / pending_interaction)。
// 门面只实时跟踪 LRU 4 个已订阅会话;REST /sessions 列表是全局权威源
// (与壳内通知轮询同一数据源),这里以 ≤intervalMs 的频率覆盖全部会话,
// 让侧栏角标对"在其他项目后台执行/等待审批"的会话同样准确。

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

import { getKimiWebApi } from '../../api';

export interface BackgroundStatus {
  busy: boolean;
  pending: 'none' | 'approval' | 'question';
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export const BG_STATUS_INTERVAL_MS = 5000;

export function useBackgroundStatus(intervalMs: number = BG_STATUS_INTERVAL_MS): {
  statusById: Ref<Map<string, BackgroundStatus>>;
} {
  const statusById = ref<Map<string, BackgroundStatus>>(new Map());
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    try {
      const page = await getKimiWebApi().listSessions({ pageSize: 100 });
      const next = new Map<string, BackgroundStatus>();
      for (const s of page.items) {
        next.set(s.id, {
          busy: s.busy,
          pending: s.pendingInteraction ?? 'none',
          ...(s.lastTurnReason !== undefined ? { lastTurnReason: s.lastTurnReason } : {}),
        });
      }
      statusById.value = next;
    } catch {
      // daemon 短暂不可达(重启中):保留上一份数据,下一轮自愈
    }
  }

  onMounted(() => {
    void refresh();
    timer = setInterval(() => void refresh(), intervalMs);
  });
  onBeforeUnmount(() => {
    if (timer !== undefined) clearInterval(timer);
  });

  return { statusById };
}

/** 合并策略:overlay(REST 全局源)优先;无覆盖时回退门面(订阅会话的实时值) */
export function resolveStatus(
  sessionId: string,
  facade: { busy: boolean; pending: 'none' | 'approval' | 'question' },
  overlay: ReadonlyMap<string, BackgroundStatus>,
): { busy: boolean; pending: 'none' | 'approval' | 'question' } {
  const o = overlay.get(sessionId);
  if (o !== undefined) return { busy: o.busy, pending: o.pending };
  return facade;
}
