// M3 Task 3.3:每项目记住最后查看的 Session(桌面自有 UI 元数据,docs/02 §8.2)。
// 官方 openWorkspace 回退到"最近更新"的会话;Codex 语义是"最后查看",
// 用 localStorage 维护 workspace_id → session_id 映射,只存 UI 元数据,
// 不触碰 Kimi 原生 Session 数据。

import { safeGetString, safeSetString } from '../../lib/storage';

const STORAGE_KEY = 'codex.lastSessionByWorkspace';

type LastSessionMap = Record<string, string>;

export function loadLastSessionMap(): LastSessionMap {
  try {
    const raw = safeGetString(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: LastSessionMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLastSessionMap(map: LastSessionMap): void {
  safeSetString(STORAGE_KEY, JSON.stringify(map));
}

/** 记录某项目最后查看的会话 */
export function rememberLastSession(workspaceId: string, sessionId: string): void {
  const map = loadLastSessionMap();
  if (map[workspaceId] === sessionId) return;
  map[workspaceId] = sessionId;
  saveLastSessionMap(map);
}

/**
 * 查询某项目最后查看的会话;会话已不存在(删除/归档)时返回 null,
 * 调用方回退到官方"最近更新"语义。
 */
export function recallLastSession(
  workspaceId: string,
  exists: (sessionId: string) => boolean,
): string | null {
  const id = loadLastSessionMap()[workspaceId];
  if (id === undefined) return null;
  if (!exists(id)) {
    // 清理失效记录
    const map = loadLastSessionMap();
    delete map[workspaceId];
    saveLastSessionMap(map);
    return null;
  }
  return id;
}
