import { describe, expect, it } from 'vitest';

import type { ChatTurn } from '../src/types';
import {
  applyHistoricalDurations,
  applySegmentDisplay,
  buildSegmentsFromNewest,
  createSegmentTracker,
  parseTranscriptTurnId,
  transcriptUserTurnIdsFromNewest,
  type TurnDurationSegment,
} from '../src/composables/useTurnDurations';

// F20 三轮:对话段(exchange)墙钟——段映射对齐、live 锚点/定格/补定格。

describe('parseTranscriptTurnId', () => {
  it('解析 "t<N>" 形状', () => {
    expect(parseTranscriptTurnId('t0')).toBe(0);
    expect(parseTranscriptTurnId('t46')).toBe(46);
  });

  it('非 t<N> 形状返回 null', () => {
    expect(parseTranscriptTurnId('46')).toBeNull();
    expect(parseTranscriptTurnId('t-1')).toBeNull();
  });
});

describe('transcriptUserTurnIdsFromNewest', () => {
  it('只数 user-origin turn(合成 turn 不参与段对齐)', () => {
    const turns = [
      { turnId: 't0', origin: { kind: 'user' } },
      { turnId: 't1', origin: { kind: 'task' } },
      { turnId: 't2', origin: { kind: 'user' } },
      { turnId: 'bad', origin: { kind: 'user' } },
    ];
    expect(transcriptUserTurnIdsFromNewest(turns)).toEqual([2, 0]);
  });

  it('marker 等无 turnId 条目跳过;origin 缺失视为 user', () => {
    const turns = [
      { turnId: 't0', origin: { kind: 'user' } },
      { turnId: undefined, origin: undefined } as unknown as { turnId: string },
      { turnId: 't1' },
    ];
    expect(transcriptUserTurnIdsFromNewest(turns)).toEqual([1, 0]);
  });
});

describe('buildSegmentsFromNewest', () => {
  it('按 anchorTurnId 取段墙钟,缺失/进行中为 null', () => {
    const segments: TurnDurationSegment[] = [
      { anchorTurnId: 0, startTime: 1000, wallClockMs: 44_000 },
      { anchorTurnId: 1, startTime: 50_000, wallClockMs: null },
    ];
    // transcript 从新数 [2(live 新段), 1(进行中段), 0(完成段)]
    expect(buildSegmentsFromNewest([2, 1, 0], segments)).toEqual([null, null, 44_000]);
  });
});

describe('applyHistoricalDurations(段值应用)', () => {
  function turn(over: Partial<ChatTurn> = {}): ChatTurn {
    return { id: 't', role: 'assistant', no: 1, text: '', ...over };
  }

  it('assistant 组从新数对齐段列表', () => {
    const turns = [turn({ id: 'a0' }), turn({ id: 'a1' }), turn({ id: 'a2' })];
    const out = applyHistoricalDurations(turns, [300, 200, 100]);
    expect(out.map((t) => t.durationMs)).toEqual([100, 200, 300]);
  });

  it('live 组(liveSegmentCount=1)不参与历史对齐', () => {
    const turns = [turn({ id: 'a0' }), turn({ id: 'a1' }), turn({ id: 'a2' })];
    // a2 是 live 进行中段(不在壳段列表);历史段只有 a1/a0
    const out = applyHistoricalDurations(turns, [200, 100], 1);
    expect(out[0]!.durationMs).toBe(100);
    expect(out[1]!.durationMs).toBe(200);
    expect(out[2]!.durationMs).toBeUndefined();
  });

  it('段墙钟覆盖组内 engine durationMs(合成 turn 吸收值不算数)', () => {
    // 组吸收了合成 turn 的 engine duration(3688),段墙钟(44_000)必须覆盖
    const turns = [turn({ id: 'a0', durationMs: 3688 })];
    const out = applyHistoricalDurations(turns, [44_000]);
    expect(out[0]!.durationMs).toBe(44_000);
  });

  it('null(进行中)不覆盖', () => {
    const turns = [turn({ id: 'a0', durationMs: 999 })];
    const out = applyHistoricalDurations(turns, [null]);
    expect(out[0]!.durationMs).toBe(999);
  });
});

describe('applySegmentDisplay(live 显示)', () => {
  function turn(over: Partial<ChatTurn> = {}): ChatTurn {
    return { id: 't', role: 'assistant', no: 1, text: '', ...over };
  }

  it('进行中段 → segmentElapsedSeconds(每秒)并清 durationMs;定格段 → durationMs', () => {
    const turns = [turn({ id: 'a0', durationMs: 999 }), turn({ id: 'a1', durationMs: 888 })];
    const running = applySegmentDisplay(turns, { settledMs: 0, runningSeconds: 42 }, undefined, 0);
    expect(running[1]).toMatchObject({ segmentElapsedSeconds: 42 });
    expect(running[1]!.durationMs).toBeUndefined();
    expect(running[0]!.durationMs).toBe(999);

    const settled = applySegmentDisplay(turns, { settledMs: 44_000, runningSeconds: 0 }, undefined, 0);
    expect(settled[1]).toMatchObject({ durationMs: 44_000 });
  });

  it('补定格(backfill)应用到次新组', () => {
    const turns = [turn({ id: 'a0' }), turn({ id: 'a1' }), turn({ id: 'a2' })];
    const out = applySegmentDisplay(turns, { settledMs: 0, runningSeconds: 3 }, 44_000, 0);
    // a2 = 当前段(running);a1 = 上段(补定格 44s)
    expect(out[2]).toMatchObject({ segmentElapsedSeconds: 3 });
    expect(out[1]).toMatchObject({ durationMs: 44_000 });
  });

  it('display/backfill 为空 → 原样返回', () => {
    const turns = [turn({ id: 'a0' })];
    expect(applySegmentDisplay(turns, null, undefined, 0)).toBe(turns);
  });
});

describe('createSegmentTracker(live 状态机)', () => {
  it('onUserPrompt 设锚点;display 从锚点起算(running)', () => {
    let t = 1000;
    const tr = createSegmentTracker(() => t);
    expect(tr.display('s1')).toBeNull();
    tr.onUserPrompt('s1');
    expect(tr.isRunning('s1')).toBe(true);
    t = 3000;
    expect(tr.display('s1')).toEqual({ settledMs: 0, runningSeconds: 2 });
  });

  it('onTurnEnded 无后台任务 → 定格(墙钟 = 锚点到结束);有后台任务 → 保持 running', () => {
    let t = 1000;
    const tr = createSegmentTracker(() => t);
    tr.onUserPrompt('s1');
    t = 10_000;
    tr.onTurnEnded('s1', false);
    expect(tr.display('s1')).toEqual({ settledMs: 9000, runningSeconds: 0 });
    expect(tr.isRunning('s1')).toBe(false);
  });

  it('后台任务进行中不定格(表不停),结束后下一 turn 结束才定格', () => {
    let t = 1000;
    const tr = createSegmentTracker(() => t);
    tr.onUserPrompt('s1');
    t = 20_000;
    tr.onTurnEnded('s1', true); // 后台子 agent 还在跑
    expect(tr.isRunning('s1')).toBe(true);
    expect(tr.display('s1')).toEqual({ settledMs: 0, runningSeconds: 19 });
    t = 30_000;
    tr.onTurnEnded('s1', false); // 后台完成通知 turn 结束
    expect(tr.display('s1')).toEqual({ settledMs: 29_000, runningSeconds: 0 });
  });

  it('合成 prompt 不重置锚点:onTurnEnded 不设新锚点,后续 turn 归同一段', () => {
    let t = 1000;
    const tr = createSegmentTracker(() => t);
    tr.onUserPrompt('s1');
    t = 15_000;
    tr.onTurnEnded('s1', true);
    t = 20_000;
    // 后台通知 turn 结束(合成),不应有 onUserPrompt——锚点仍是 1000
    tr.onTurnEnded('s1', false);
    expect(tr.display('s1')).toEqual({ settledMs: 19_000, runningSeconds: 0 });
  });

  it('上段未定格遇新真实 prompt → 补定格(lastBackfill)', () => {
    let t = 1000;
    const tr = createSegmentTracker(() => t);
    tr.onUserPrompt('s1');
    t = 5000;
    tr.onTurnEnded('s1', true); // 后台还在跑,未定格;最后 turn 结束时刻 = 5000
    t = 10_000;
    const backfill = tr.onUserPrompt('s1'); // 用户又提交
    expect(backfill).toBe(4000); // 最后 turn.ended 时刻 5000 − 锚点 1000
    expect(tr.lastBackfill('s1')).toBe(4000);
    // 新段从 10s 起算
    t = 12_000;
    expect(tr.display('s1')).toEqual({ settledMs: 0, runningSeconds: 2 });
  });

  it('已定格段遇新 prompt 不补定格', () => {
    let t = 1000;
    const tr = createSegmentTracker(() => t);
    tr.onUserPrompt('s1');
    t = 6000;
    tr.onTurnEnded('s1', false);
    t = 8000;
    expect(tr.onUserPrompt('s1')).toBeNull();
    expect(tr.lastBackfill('s1')).toBeUndefined();
  });

  it('restoreAnchor 恢复进行中段锚点;已有 live 段不覆盖', () => {
    let t = 1000;
    const tr = createSegmentTracker(() => t);
    tr.restoreAnchor('s1', 500);
    expect(tr.display('s1')).toEqual({ settledMs: 0, runningSeconds: 0 });
    tr.onUserPrompt('s1'); // 用户提交(live 锚点 1000)
    tr.restoreAnchor('s1', 999999); // 迟到的历史恢复不覆盖
    t = 2000;
    expect(tr.display('s1')).toEqual({ settledMs: 0, runningSeconds: 1 });
  });
});

describe('createSegmentTracker settleIfIdle(后台完成无通知 turn)', () => {
  it('最后 turn 已结束 + 后台清空 → 补定格(墙钟到 lastTurnEndedAt)', () => {
    let t = 1000;
    const tr = createSegmentTracker(() => t);
    tr.onUserPrompt('s1');
    t = 5000;
    tr.onTurnEnded('s1', true); // 后台还在跑
    expect(tr.isRunning('s1')).toBe(true);
    t = 20_000; // 后台完成(无新 turn)
    tr.settleIfIdle('s1');
    expect(tr.display('s1')).toEqual({ settledMs: 4000, runningSeconds: 0 });
    expect(tr.isRunning('s1')).toBe(false);
  });

  it('无锚点/已定格/无 turn 结束记录 → 不动', () => {
    const tr = createSegmentTracker(() => 1000);
    tr.settleIfIdle('s1'); // 无段
    tr.onUserPrompt('s1');
    tr.settleIfIdle('s1'); // 无 lastTurnEndedAt
    expect(tr.isRunning('s1')).toBe(true);
    tr.onTurnEnded('s1', false); // 已定格
    tr.settleIfIdle('s1');
    expect(tr.display('s1')).toEqual({ settledMs: 0, runningSeconds: 0 });
  });
});

describe('createSegmentTracker 段尾推进(settleIfIdle 后通知 turn)', () => {
  it('settleIfIdle 定格后,通知 turn 结束推进段尾(墙钟含后台等待)', () => {
    let t = 1000;
    const tr = createSegmentTracker(() => t);
    tr.onUserPrompt('s1');
    t = 5000;
    tr.onTurnEnded('s1', true); // 主回复 turn,后台跑
    t = 20_000;
    tr.settleIfIdle('s1'); // 后台清空(通知 turn 尚未结束),定格 4s
    expect(tr.display('s1')).toEqual({ settledMs: 4000, runningSeconds: 0 });
    t = 30_000;
    tr.onTurnEnded('s1', false); // 通知 turn 结束 → 段尾推进到 29s
    expect(tr.display('s1')).toEqual({ settledMs: 29_000, runningSeconds: 0 });
  });

  it('已定格后新一轮后台出现 → 回到处理中', () => {
    let t = 1000;
    const tr = createSegmentTracker(() => t);
    tr.onUserPrompt('s1');
    t = 5000;
    tr.onTurnEnded('s1', false); // 定格 4s
    expect(tr.isRunning('s1')).toBe(false);
    t = 10_000;
    tr.onTurnEnded('s1', true); // 新一轮后台任务开始
    expect(tr.isRunning('s1')).toBe(true);
    expect(tr.display('s1')).toEqual({ settledMs: 0, runningSeconds: 9 });
  });
});
