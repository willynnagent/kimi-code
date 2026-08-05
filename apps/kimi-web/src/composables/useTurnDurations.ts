// apps/kimi-web/src/composables/useTurnDurations.ts
// F20:历史 turn 耗时的获取与映射(AGENTS.md §3.4 wire.jsonl 只读例外,经壳 IPC)。
//
// 关联设计(2026-08-05 实测):
//   - REST /messages 不带 durationMs;官方 transcript 端点也不带(实测确认)。
//   - 壳侧只读解析 main wire.jsonl 的 turn.ended → turnId → durationMs。
//   - transcript 端点(与 wire 同源冷重建)的 turnId "t<N>" 数字即 wire turnId;
//     REST 消息(before_id 游标分页,服务端新→旧)的 assistant 组与 transcript
//     user-origin turns 顺序同构 → "从新倒数"对齐:前端 turns 数组尾部(最新)
//     第 k 个 assistant 组 ↔ transcript 倒数第 k 个 user turn → durationMs。
//   - 分页:加载更早消息时新组插入头部,从新数序号稳定;transcript 只取第一页
//     (page_size=100),超长会话(>100 turn)更早的历史无耗时(务实取舍)。
//   - 浏览器环境(无壳桥)或无数据时返回 null,调用方保持现状不报错。

import type { ChatTurn } from '../types';
import { readKimiApiConfig } from '../api/config';
import { DaemonHttpClient } from '../api/daemon/http';

export interface TranscriptTurn {
  turnId: string;
  origin?: { kind?: string };
}

/** transcript turnId "t46" → 数字 46;非 "t<N>" 形状返回 null */
export function parseTranscriptTurnId(turnId: string): number | null {
  if (!turnId.startsWith('t')) return null;
  const n = Number(turnId.slice(1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** transcript turns(升序)→ 从新数(倒数第 1 = 最新)的 user-origin turnId 数字列表 */
export function transcriptTurnIdsFromNewest(turns: TranscriptTurn[]): number[] {
  const ids: number[] = [];
  for (const t of turns) {
    // 只数用户发起的 turn(cron / steer / marker 等不产生独立前端 assistant 组)
    if (t.origin !== undefined && t.origin.kind !== undefined && t.origin.kind !== 'user') {
      continue;
    }
    // marker 等条目无 turnId,跳过(parseTranscriptTurnId 只接受字符串)
    if (typeof t.turnId !== 'string') continue;
    const n = parseTranscriptTurnId(t.turnId);
    if (n !== null) ids.push(n);
  }
  return ids.reverse();
}

/** 从新数数组:index k = 倒数第 k+1 个 user turn 的 durationMs(无则 undefined) */
export function buildDurationsFromNewest(
  transcriptTurnIds: number[],
  wireDurations: Record<string, number>,
): (number | undefined)[] {
  return transcriptTurnIds.map((id) => wireDurations[String(id)]);
}

/**
 * 给 turns 附加历史耗时:无 durationMs 的 assistant 组从新数 k ↔
 * durationsFromNewest[k](durationsFromNewest 只覆盖 transcript 已持久化的
 * turn;live 完成 turn 已带投影时长,不参与计数也不覆盖)。
 */
export function applyHistoricalDurations(
  turns: ChatTurn[],
  durationsFromNewest: (number | undefined)[] | null | undefined,
): ChatTurn[] {
  if (!durationsFromNewest || durationsFromNewest.length === 0) return turns;
  // 只数"需要历史映射"的组(无 durationMs 的 assistant 组);live/已有时长
  // 的组不参与从新数,避免 transcript 未含最新 turn 时错位。
  const pendingIdx: number[] = [];
  turns.forEach((t, i) => {
    if (t.role === 'assistant' && t.durationMs === undefined) pendingIdx.push(i);
  });
  if (pendingIdx.length === 0) return turns;
  const out = turns.slice();
  pendingIdx.forEach((idx, fromOld) => {
    const fromNewest = pendingIdx.length - 1 - fromOld;
    const d = durationsFromNewest[fromNewest];
    if (d !== undefined && out[idx]!.durationMs === undefined) {
      out[idx] = { ...out[idx]!, durationMs: d };
    }
  });
  return out;
}

/**
 * 拉取一个会话的历史 duration 映射(从新数数组)。
 * 浏览器环境(无壳桥)/transcript 或 wire 失败 → null(调用方静默跳过)。
 */
export async function fetchHistoricalDurations(
  sessionId: string,
  getDurations?: (sid: string) => Promise<unknown>,
): Promise<(number | undefined)[] | null> {
  if (typeof getDurations !== 'function') return null;
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
      getDurations(sessionId).catch(() => null),
    ]);
    const items = tx?.items ?? [];
    if (
      wire === null ||
      typeof wire !== 'object' ||
      (wire as { kind?: unknown }).kind !== 'ok'
    ) {
      return null;
    }
    const ids = transcriptTurnIdsFromNewest(items);
    if (ids.length === 0) return null;
    return buildDurationsFromNewest(ids, (wire as { durations: Record<string, number> }).durations);
  } catch {
    return null;
  }
}
