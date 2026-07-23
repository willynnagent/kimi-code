// apps/kimi-web/src/lib/turnStartTracker.ts
// Per-session anchors for the live "working · Ns" turn timer (F20). Pure logic
// with an injectable clock so the recording rules are unit-testable without
// mounting the whole client composable.
//
// The anchor is recorded the first time a session's working window opens
// (optimistic submit, or turnActiveChanged(active) via the reducer). A
// mid-turn refresh/reconnect loses the original start time — the snapshot
// carries none — so the anchor is then the restore moment and the count
// restarts from there; the settled duration always comes from the server's
// turn.ended durationMs, so only the live label is approximate.

export interface TurnStartTracker {
  /** Record the anchor for a session if none exists; returns the anchor. */
  ensureStarted(sessionId: string): number;
  /** Drop the anchor when the session's working window closes. */
  clear(sessionId: string): void;
  /** Whole seconds since the anchor; null when the session has no anchor. */
  elapsedSeconds(sessionId: string): number | null;
}

export function createTurnStartTracker(now: () => number = Date.now): TurnStartTracker {
  const startedAtBySession = new Map<string, number>();
  return {
    ensureStarted(sessionId) {
      const existing = startedAtBySession.get(sessionId);
      if (existing !== undefined) return existing;
      const startedAt = now();
      startedAtBySession.set(sessionId, startedAt);
      return startedAt;
    },
    clear(sessionId) {
      startedAtBySession.delete(sessionId);
    },
    elapsedSeconds(sessionId) {
      const startedAt = startedAtBySession.get(sessionId);
      if (startedAt === undefined) return null;
      return Math.max(0, Math.floor((now() - startedAt) / 1000));
    },
  };
}
