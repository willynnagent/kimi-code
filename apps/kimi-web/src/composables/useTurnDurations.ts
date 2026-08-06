// apps/kimi-web/src/composables/useTurnDurations.ts
// F20 三轮:对话段(exchange)墙钟跨度——每段"已处理 Xh Ym Zs"。
//
// 关联设计(2026-08-05 实测):
//   - REST /messages 与官方 transcript 端点都不带时长;壳侧只读解析 main
//     wire.jsonl 的 turn.prompt(origin 切段)+ turn.ended(time 定段尾),
//     输出段列表(anchorTurnId / startTime / wallClockMs;AGENTS.md §3.4 ②)。
//   - transcript 端点(与 wire 同源冷重建)的 turnId "t<N>" 数字即 wire turnId;
//     REST 消息(before_id 游标分页,服务端新→旧)的 assistant 组与 transcript
//     user-origin turns 顺序同构 → "从新倒数"对齐:无 durationMs 的 assistant
//     组从新数 k ↔ transcript 倒数第 k 个 user turn → 段墙钟。
//   - 合成 turn(task 等)不切段:前端组是 user 消息硬边界分割的段级组,合成
//     turn 的消息并入段内组,天然不显示独立"已处理"。
//   - live:段锚点 = 真实用户提交时刻(合成 prompt 不重置);段进行中显示
//     "处理中 · Ns"(后台等待/提问等待期间表不停);最后 turn 结束且无进行中
//     后台任务才定格;上一段遇新真实 prompt 时若未定格则补定格。
//   - 浏览器环境(无壳桥)或无数据时返回 null,调用方保持现状不报错。

import type { ChatTurn } from '../types';
import { readKimiApiConfig } from '../api/config';
import { DaemonHttpClient } from '../api/daemon/http';

export interface TranscriptTurn {
  turnId: string;
  origin?: { kind?: string };
}

/** 壳 IPC 返回的段结构(wire turn.prompt/turn.ended 只读解析) */
export interface TurnDurationSegment {
  anchorTurnId: number;
  startTime: number;
  wallClockMs: number | null;
}

/** transcript turnId "t46" → 数字 46;非 "t<N>" 形状返回 null */
export function parseTranscriptTurnId(turnId: string): number | null {
  if (!turnId.startsWith('t')) return null;
  const n = Number(turnId.slice(1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * transcript turns(升序)→ 从新数(倒数第 1 = 最新)的 user-origin turnId 数字列表。
 * origin 缺失视为 user(与壳侧兜底一致);marker 等无 turnId 条目跳过。
 */
export function transcriptUserTurnIdsFromNewest(turns: TranscriptTurn[]): number[] {
  const ids: number[] = [];
  for (const t of turns) {
    if (t.origin !== undefined && t.origin.kind !== undefined && t.origin.kind !== 'user') {
      continue;
    }
    if (typeof t.turnId !== 'string') continue;
    const n = parseTranscriptTurnId(t.turnId);
    if (n !== null) ids.push(n);
  }
  return ids.reverse();
}

/** 段列表(anchorTurnId 升序)→ 从新数数组:index k = 倒数第 k+1 段的墙钟(进行中 null) */
export function buildSegmentsFromNewest(
  userTurnIdsFromNewest: number[],
  segments: TurnDurationSegment[],
): (number | null)[] {
  const byAnchor = new Map<number, number | null>();
  for (const s of segments) byAnchor.set(s.anchorTurnId, s.wallClockMs);
  return userTurnIdsFromNewest.map((id) => byAnchor.get(id) ?? null);
}

/**
 * 给 turns 附加历史段耗时:所有 assistant 组(段级组)从新数 k ↔
 * segmentsFromNewest[k - liveSegmentCount],**覆盖**组内已有的 engine
 * durationMs(合成 turn 的 durationMs 会被吸收进段组,段墙钟才是显示语义;
 * 单 turn 简单对话墙钟 ≈ engine duration,行为不变)。
 */
export function applyHistoricalDurations(
  turns: ChatTurn[],
  segmentsFromNewest: (number | null)[] | null | undefined,
  liveSegmentCount = 0,
): ChatTurn[] {
  if (!segmentsFromNewest || segmentsFromNewest.length === 0) return turns;
  const groupIdx: number[] = [];
  turns.forEach((t, i) => {
    if (t.role === 'assistant') groupIdx.push(i);
  });
  if (groupIdx.length === 0) return turns;
  const out = turns.slice();
  groupIdx.forEach((idx, fromOld) => {
    const fromNewest = groupIdx.length - 1 - fromOld;
    const segIdx = fromNewest - liveSegmentCount;
    const ms = segIdx >= 0 ? segmentsFromNewest[segIdx] : undefined;
    if (ms !== undefined && ms !== null) {
      out[idx] = { ...out[idx]!, durationMs: ms };
    }
  });
  return out;
}

/**
 * Live 段显示应用(在 applyHistoricalDurations 之后调用):
 *   - 最新段组(从新数 0):display 已定格 → durationMs(段墙钟,覆盖 engine 值);
 *     进行中 → segmentElapsedSeconds(清 durationMs,避免"已处理"残留)
 *   - 次新段组(从新数 1):backfill(上段补定格)有值 → durationMs(覆盖)
 * clock 为每秒递增的响应式值,只为让 computed 在 running 期间重算。
 */
export function applySegmentDisplay(
  turns: ChatTurn[],
  display: SegmentDisplay | null,
  backfillMs: number | null | undefined,
  clock: number,
): ChatTurn[] {
  void clock;
  if (display === null && backfillMs === undefined) return turns;
  // 最新两个 assistant 组(从新数 0 / 1)
  const groupIdx: number[] = [];
  turns.forEach((t, i) => {
    if (t.role === 'assistant') groupIdx.push(i);
  });
  if (groupIdx.length === 0) return turns;
  const out = turns.slice();
  const newest = groupIdx[groupIdx.length - 1]!;
  if (display !== null) {
    if (display.settledMs > 0) {
      out[newest] = { ...out[newest]!, durationMs: display.settledMs, segmentElapsedSeconds: undefined };
    } else {
      out[newest] = {
        ...out[newest]!,
        durationMs: undefined,
        segmentElapsedSeconds: display.runningSeconds,
      };
    }
  }
  if (backfillMs !== undefined && backfillMs !== null && groupIdx.length >= 2) {
    const prev = groupIdx[groupIdx.length - 2]!;
    out[prev] = { ...out[prev]!, durationMs: backfillMs };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live 段状态机:锚点(真实用户提交)+ 定格 + 补定格 + "处理中 · Ns"
// ---------------------------------------------------------------------------

export interface SegmentDisplay {
  /** 已定格段墙钟 ms */
  settledMs: number;
  /** 进行中段:从锚点起的整秒数(后台等待/提问等待期间持续走) */
  runningSeconds: number;
}

export interface SegmentTracker {
  /** 真实用户提交 → 新段(锚点 = now);上段未定格则补定格,返回补定格 ms */
  onUserPrompt(sessionId: string): number | null;
  /** 最近一次补定格值(上段定格,供 turns 渲染);无则 undefined */
  lastBackfill(sessionId: string): number | undefined;
  /** turn 结束 → 记录时刻;无进行中后台任务时定格当前段 */
  onTurnEnded(sessionId: string, hasRunningTasks: boolean): void;
  /** 当前会话是否有段锚点(无 → 调用方应从消息推导恢复) */
  hasAnchor(sessionId: string): boolean;
  /** 后台任务清空时调用:最后 turn 已结束且段未定格 → 补定格(后台完成无后续 turn 场景) */
  settleIfIdle(sessionId: string): void;
  /** 历史恢复:进行中段的锚点(壳段列表 startTime) */
  restoreAnchor(sessionId: string, anchor: number): void;
  /** 当前显示:settled / running / 无段 */
  display(sessionId: string, now?: number): SegmentDisplay | null;
  /** 段是否进行中(供每秒 tick 判断) */
  isRunning(sessionId: string): boolean;
  clear(sessionId: string): void;
}

interface SegmentState {
  anchor: number;
  settledMs: number | null;
  lastTurnEndedAt: number | null;
}

export function createSegmentTracker(now: () => number = Date.now): SegmentTracker {
  const bySession = new Map<string, SegmentState>();
  const backfilledBySession = new Map<string, number>();

  function state(sid: string): SegmentState | undefined {
    return bySession.get(sid);
  }

  return {
    onUserPrompt(sid) {
      const cur = state(sid);
      let backfill: number | null = null;
      if (cur !== undefined && cur.anchor !== null && cur.settledMs === null && cur.lastTurnEndedAt !== null) {
        // 上一段遇新真实 prompt 时若还没定格 → 用最后 turn.ended 时刻补定格
        backfill = Math.max(0, cur.lastTurnEndedAt - cur.anchor);
        backfilledBySession.set(sid, backfill);
      } else {
        backfilledBySession.delete(sid);
      }
      bySession.set(sid, { anchor: now(), settledMs: null, lastTurnEndedAt: null });
      return backfill;
    },
    lastBackfill(sid) {
      return backfilledBySession.get(sid);
    },
    onTurnEnded(sid, hasRunningTasks) {
      const cur = state(sid);
      if (cur === undefined || cur.anchor === null) return;
      const endedAt = now();
      if (!hasRunningTasks) {
        // 无后台任务:定格(若 settleIfIdle 已定格,以最后 turn 结束时刻推进段尾——
        // 后台完成通知 turn 结束后,墙钟必须含后台等待)
        bySession.set(sid, {
          ...cur,
          settledMs: Math.max(0, endedAt - cur.anchor),
          lastTurnEndedAt: endedAt,
        });
      } else {
        // 后台任务进行中:仅推进 lastTurnEndedAt;若此前被 settleIfIdle 定格
        // (新一轮后台出现),回到"处理中"
        bySession.set(sid, { ...cur, lastTurnEndedAt: endedAt, settledMs: null });
      }
    },
    hasAnchor(sid) {
      const cur = state(sid);
      return cur !== undefined && cur.anchor !== null;
    },
    settleIfIdle(sid) {
      const cur = state(sid);
      if (
        cur === undefined ||
        cur.anchor === null ||
        cur.settledMs !== null ||
        cur.lastTurnEndedAt === null
      ) {
        return;
      }
      bySession.set(sid, {
        ...cur,
        settledMs: Math.max(0, cur.lastTurnEndedAt - cur.anchor),
      });
    },
    restoreAnchor(sid, anchor) {
      const cur = state(sid);
      if (cur !== undefined && cur.anchor !== null && cur.settledMs === null) {
        // 已有 live 段(用户刚提交)——保留 live 锚点,不覆盖
        return;
      }
      bySession.set(sid, { anchor, settledMs: null, lastTurnEndedAt: null });
    },
    display(sid, at) {
      const cur = state(sid);
      if (cur === undefined || cur.anchor === null) return null;
      const t = at ?? now();
      if (cur.settledMs !== null) return { settledMs: cur.settledMs, runningSeconds: 0 };
      return { settledMs: 0, runningSeconds: Math.max(0, Math.floor((t - cur.anchor) / 1000)) };
    },
    isRunning(sid) {
      const cur = state(sid);
      return cur !== undefined && cur.anchor !== null && cur.settledMs === null;
    },
    clear(sid) {
      bySession.delete(sid);
    },
  };
}

/**
 * 拉取一个会话的历史段列表(壳 IPC,只读 wire 元数据)。
 * 浏览器环境(无壳桥)/transcript 或 wire 失败 → null(调用方静默跳过)。
 */
export async function fetchHistoricalSegments(
  sessionId: string,
  getSegments?: (sid: string) => Promise<unknown>,
): Promise<TurnDurationSegment[] | null> {
  if (typeof getSegments !== 'function') return null;
  try {
    const cfg = readKimiApiConfig();
    const http = new DaemonHttpClient(cfg.serverHttpUrl, {
      clientId: cfg.clientId,
      clientName: cfg.clientName,
      clientVersion: cfg.clientVersion,
      clientUiMode: cfg.clientUiMode,
    });
    const [tx, wire] = await Promise.all([
      http
        .get<{ items?: TranscriptTurn[] }>(
          `/sessions/${encodeURIComponent(sessionId)}/transcript`,
          { agent_id: 'main', page_size: 100 },
        )
        .catch(() => null),
      getSegments(sessionId).catch(() => null),
    ]);
    const items = tx?.items ?? [];
    if (
      wire === null ||
      typeof wire !== 'object' ||
      (wire as { kind?: unknown }).kind !== 'ok'
    ) {
      return null;
    }
    const segments = (wire as { segments: TurnDurationSegment[] }).segments;
    if (!Array.isArray(segments) || segments.length === 0) return null;
    // transcript 与 wire 的 user turn 对齐:确认段锚点都在 transcript 内
    const userIds = new Set(transcriptUserTurnIdsFromNewest(items));
    const known = segments.filter((s) => userIds.has(s.anchorTurnId));
    return known.length > 0 ? known : null;
  } catch {
    return null;
  }
}
