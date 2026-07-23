// F17:项目置顶(桌面自有 UI 元数据,与 useLastSessionMap 同风格)。
// 置顶 id 存 localStorage(workspace_id 数组,纯 UI 元数据,不触碰官方
// workspace 数据);置顶项目排在列表最前,置顶组与非置顶组内部各自保持
// 官方 recent 排序(stable partition);workspace 被移除后由调用方 prune
// 残留 id。

import { safeGetJson, safeSetJson } from '../../lib/storage';

const STORAGE_KEY = 'codex.pinnedWorkspaces';

export function loadPinnedWorkspaces(): string[] {
  const parsed = safeGetJson<unknown>(STORAGE_KEY);
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const id of parsed) {
    if (typeof id === 'string' && id.length > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

export function savePinnedWorkspaces(ids: Iterable<string>): void {
  safeSetJson(STORAGE_KEY, Array.from(ids));
}

/** 切换置顶状态,返回新数组(不修改入参)。 */
export function toggleWorkspacePinned(
  pinned: readonly string[],
  workspaceId: string,
): string[] {
  return pinned.includes(workspaceId)
    ? pinned.filter((id) => id !== workspaceId)
    : [...pinned, workspaceId];
}

/**
 * 清理已失效(被移除)的置顶 id。返回清理后的数组与是否有变化,
 * 无变化时调用方不必回写存储。
 */
export function prunePinnedWorkspaces(
  pinned: readonly string[],
  validIds: ReadonlySet<string>,
): { next: string[]; changed: boolean } {
  const next = pinned.filter((id) => validIds.has(id));
  return { next, changed: next.length !== pinned.length };
}

/**
 * 置顶项排在最前;置顶组与非置顶组内部各自保持原顺序(stable partition,
 * 不打乱官方 recent 排序)。
 */
export function orderWithPinnedFirst<T>(
  items: readonly T[],
  pinned: readonly string[],
  getId: (item: T) => string,
): T[] {
  if (pinned.length === 0) return [...items];
  const set = new Set(pinned);
  const top: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    (set.has(getId(item)) ? top : rest).push(item);
  }
  return [...top, ...rest];
}
