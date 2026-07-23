// apps/kimi-web/src/lib/turnStartTracker.test.ts
import { describe, expect, it } from 'vitest';
import { createTurnStartTracker } from './turnStartTracker';

describe('createTurnStartTracker', () => {
  it('records the anchor on the first ensureStarted call', () => {
    let now = 1_000_000;
    const tracker = createTurnStartTracker(() => now);
    expect(tracker.elapsedSeconds('s1')).toBeNull();

    tracker.ensureStarted('s1');
    now += 12_000;
    expect(tracker.elapsedSeconds('s1')).toBe(12);
  });

  it('keeps the original anchor on repeated ensureStarted calls', () => {
    let now = 1_000_000;
    const tracker = createTurnStartTracker(() => now);
    tracker.ensureStarted('s1');
    now += 5_000;
    tracker.ensureStarted('s1');
    now += 5_000;
    expect(tracker.elapsedSeconds('s1')).toBe(10);
  });

  it('tracks sessions independently', () => {
    let now = 1_000_000;
    const tracker = createTurnStartTracker(() => now);
    tracker.ensureStarted('s1');
    now += 3_000;
    tracker.ensureStarted('s2');
    now += 2_000;
    expect(tracker.elapsedSeconds('s1')).toBe(5);
    expect(tracker.elapsedSeconds('s2')).toBe(2);
  });

  it('clear drops the anchor so a later window restarts from zero', () => {
    let now = 1_000_000;
    const tracker = createTurnStartTracker(() => now);
    tracker.ensureStarted('s1');
    now += 30_000;
    tracker.clear('s1');
    expect(tracker.elapsedSeconds('s1')).toBeNull();

    tracker.ensureStarted('s1');
    now += 4_000;
    expect(tracker.elapsedSeconds('s1')).toBe(4);
  });

  it('floors sub-second remainders and never goes negative', () => {
    let now = 1_000_000;
    const tracker = createTurnStartTracker(() => now);
    tracker.ensureStarted('s1');
    now += 1_999;
    expect(tracker.elapsedSeconds('s1')).toBe(1);
    now -= 5_000; // clock skew guard
    expect(tracker.elapsedSeconds('s1')).toBe(0);
  });
});
