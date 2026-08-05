import { describe, expect, it } from 'vitest';

import type { ChatTurn } from '../src/types';
import type { TranscriptTurn } from '../src/composables/useTurnDurations';
import {
  applyHistoricalDurations,
  buildDurationsFromNewest,
  parseTranscriptTurnId,
  transcriptTurnIdsFromNewest,
} from '../src/composables/useTurnDurations';

// F20:历史 turn 耗时——transcript turnId 与 wire durationMs 的从新数对齐映射。

describe('parseTranscriptTurnId', () => {
  it('解析 "t<N>" 形状', () => {
    expect(parseTranscriptTurnId('t0')).toBe(0);
    expect(parseTranscriptTurnId('t46')).toBe(46);
  });

  it('非 t<N> 形状返回 null', () => {
    expect(parseTranscriptTurnId('46')).toBeNull();
    expect(parseTranscriptTurnId('')).toBeNull();
    expect(parseTranscriptTurnId('t-1')).toBeNull();
    expect(parseTranscriptTurnId('tx')).toBeNull();
  });
});

describe('transcriptTurnIdsFromNewest', () => {
  it('升序 turns → 从新数(最新在前)的 user-origin turnId', () => {
    const turns = [
      { turnId: 't0', origin: { kind: 'user' } },
      { turnId: 't1', origin: { kind: 'user' } },
      { turnId: 't2', origin: { kind: 'user' } },
    ];
    expect(transcriptTurnIdsFromNewest(turns)).toEqual([2, 1, 0]);
  });

  it('跳过非 user origin(cron 等)与畸形 turnId', () => {
    const turns = [
      { turnId: 't0', origin: { kind: 'user' } },
      { turnId: 't1', origin: { kind: 'cron' } },
      { turnId: 'bad', origin: { kind: 'user' } },
      { turnId: 't2', origin: { kind: 'user' } },
    ];
    expect(transcriptTurnIdsFromNewest(turns)).toEqual([2, 0]);
  });

  it('marker 等无 turnId 条目跳过(不抛错)', () => {
    const turns = [
      { turnId: 't0', origin: { kind: 'user' } },
      { turnId: undefined, origin: undefined } as unknown as TranscriptTurn,
      { turnId: 't1', origin: { kind: 'user' } },
    ];
    expect(transcriptTurnIdsFromNewest(turns)).toEqual([1, 0]);
  });

  it('origin 缺省视为 user(兼容)', () => {
    expect(transcriptTurnIdsFromNewest([{ turnId: 't5' }])).toEqual([5]);
  });
});

describe('buildDurationsFromNewest', () => {
  it('按 turnId 取 durationMs,缺失为 undefined', () => {
    const wire = { '0': 100, '2': 300 };
    expect(buildDurationsFromNewest([2, 1, 0], wire)).toEqual([300, undefined, 100]);
  });
});

describe('applyHistoricalDurations', () => {
  function turn(over: Partial<ChatTurn> = {}): ChatTurn {
    return { id: 't', role: 'assistant', no: 1, text: '', ...over };
  }

  it('assistant 组从新数对齐 durationsFromNewest', () => {
    const turns = [
      turn({ id: 'a0' }),
      turn({ id: 'a1' }),
      turn({ id: 'a2' }),
    ];
    const out = applyHistoricalDurations(turns, [300, 200, 100]);
    // 从旧到新:a0↔100, a1↔200, a2↔300
    expect(out.map((t) => t.durationMs)).toEqual([100, 200, 300]);
  });

  it('非 assistant 组(user)不参与计数,不影响对齐', () => {
    const turns = [
      { id: 'u0', role: 'user' as const, no: 1, text: 'hi' },
      turn({ id: 'a0' }),
      { id: 'u1', role: 'user' as const, no: 2, text: 'hi2' },
      turn({ id: 'a1' }),
    ];
    const out = applyHistoricalDurations(turns, [200, 100]);
    expect(out[1]!.durationMs).toBe(100);
    expect(out[3]!.durationMs).toBe(200);
    expect(out[0]!.durationMs).toBeUndefined();
  });

  it('live 已有时长不覆盖;映射越界跳过', () => {
    const turns = [turn({ id: 'a0', durationMs: 999 }), turn({ id: 'a1' })];
    // live 组(a0)不参与从新数;映射只覆盖最新 pending 组(a1)
    const out = applyHistoricalDurations(turns, [50]);
    expect(out[0]!.durationMs).toBe(999);
    expect(out[1]!.durationMs).toBe(50);
  });

  it('live 完成组不参与从新数计数(transcript 未含最新 turn 时不错位)', () => {
    // 历史 t0/t1 + live 完成 t2(带投影时长):映射数组只覆盖 transcript 的
    // 两个历史 turn(从新数 [t1=200, t0=100])——live 组不占索引。
    const turns = [turn({ id: 'a0' }), turn({ id: 'a1' }), turn({ id: 'a2', durationMs: 999 })];
    const out = applyHistoricalDurations(turns, [200, 100]);
    expect(out[0]!.durationMs).toBe(100);
    expect(out[1]!.durationMs).toBe(200);
    expect(out[2]!.durationMs).toBe(999);
  });

  it('null/空数组 → 原样返回', () => {
    const turns = [turn({ id: 'a0' })];
    expect(applyHistoricalDurations(turns, null)).toBe(turns);
    expect(applyHistoricalDurations(turns, undefined)).toBe(turns);
    expect(applyHistoricalDurations(turns, [])).toBe(turns);
  });

  it('不修改原数组(纯函数)', () => {
    const turns = [turn({ id: 'a0' })];
    const out = applyHistoricalDurations(turns, [100]);
    expect(turns[0]!.durationMs).toBeUndefined();
    expect(out[0]!.durationMs).toBe(100);
    expect(out).not.toBe(turns);
  });
});
