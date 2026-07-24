// apps/kimi-web/src/components/codex/useGitPanel.ts
// F11 Git stage / commit 面板(docs/10)的取数与状态逻辑。
//
// 数据源:桌面壳 window.desktop.git(IPC → 主进程 spawn git,数组参数 + cwd
// realpath 白名单,安全约束在壳侧 git-service.ts)。浏览器环境无桥 →
// resolveGitBridge 返回 null,CodexSidebar 隐藏入口,面板不会出现。
//
// 工作区级视角(daemon 无写端点,统一走壳侧 git,与 F9 的会话级只读归因互补)。
// 刷新策略(docs/10 §3):打开时拉 status;stage/unstage/commit 后重拉;
// 面板打开期间手动刷新,不做文件系统 watcher(KISS)。
//
// 测试友好:bridge 可注入(见 codex-git-panel.test.ts);纯函数
// (isStaged / isUnstaged / groupFiles / statusCodeOf / selectionKey)单独导出。

import { computed, ref, type ComputedRef, type Ref } from 'vue';

// ---------------------------------------------------------------------------
// 视图模型与桥类型(与壳侧 shared/types.ts 对齐)
// ---------------------------------------------------------------------------

export interface GitPanelFile {
  path: string;
  /** porcelain X:暂存区状态(' ' = 该侧干净) */
  index: string;
  /** porcelain Y:工作区状态 */
  workTree: string;
}

export type GitErrorKind = 'not_a_repo' | 'git_failed' | 'invalid_path';

export interface GitBridgeError {
  kind: GitErrorKind;
  message: string;
}

export type GitBridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GitBridgeError };

export interface GitBridge {
  status(workspacePath: string): Promise<GitBridgeResult<{ files: GitPanelFile[] }>>;
  diff(
    workspacePath: string,
    path: string,
    staged: boolean,
  ): Promise<GitBridgeResult<{ diff: string; truncated: boolean }>>;
  stage(workspacePath: string, paths: string[]): Promise<GitBridgeResult<null>>;
  unstage(workspacePath: string, paths: string[]): Promise<GitBridgeResult<null>>;
  commit(
    workspacePath: string,
    message: string,
  ): Promise<GitBridgeResult<{ hash: string }>>;
}

/** 从 window.desktop 解析 git 桥;任一方法缺失 → null(入口隐藏)。 */
export function resolveGitBridge(desktop: unknown): GitBridge | null {
  const git = (desktop as { git?: Partial<GitBridge> | undefined } | null | undefined)?.git;
  if (!git) return null;
  if (
    typeof git.status !== 'function' ||
    typeof git.diff !== 'function' ||
    typeof git.stage !== 'function' ||
    typeof git.unstage !== 'function' ||
    typeof git.commit !== 'function'
  ) {
    return null;
  }
  return git as GitBridge;
}

// ---------------------------------------------------------------------------
// 纯函数(单测直接覆盖)
// ---------------------------------------------------------------------------

/** 已暂存:X 列有实际状态(排除未跟踪 ?? 与 ignored !!)。 */
export function isStaged(f: GitPanelFile): boolean {
  return f.index !== ' ' && f.index !== '?' && f.index !== '!';
}

/** 有未暂存变更:Y 列非空(未跟踪 ?? 的 Y='?' 也算,暂存后才可提交)。 */
export function isUnstaged(f: GitPanelFile): boolean {
  return f.workTree !== ' ' && f.workTree !== '!';
}

/** 选中项的稳定 key:同一文件可能同时在两组(MM),组归属必须入 key。 */
export function selectionKey(path: string, staged: boolean): string {
  return `${staged ? 'S' : 'U'}:${path}`;
}

/** 分组 + 按路径排序(稳定展示,不随刷新跳动)。 */
export function groupFiles(files: GitPanelFile[]): {
  staged: GitPanelFile[];
  unstaged: GitPanelFile[];
} {
  const staged = files.filter(isStaged).sort((a, b) => a.path.localeCompare(b.path));
  const unstaged = files.filter(isUnstaged).sort((a, b) => a.path.localeCompare(b.path));
  return { staged, unstaged };
}

/** 行内状态码:已暂存组看 X,未暂存组看 Y。 */
export function statusCodeOf(f: GitPanelFile, staged: boolean): string {
  return staged ? f.index : f.workTree;
}

// ---------------------------------------------------------------------------
// 侧栏入口计数(有变更的项目行显示计数点)
// ---------------------------------------------------------------------------

/**
 * 批量拉各 workspace 的变更文件数。非 git 仓库 / 失败项静默跳过(无计数点),
 * 永不抛错——侧栏不能因为一个项目的状态失败而整体空白。
 */
export async function fetchGitChangeCounts(
  bridge: GitBridge,
  roots: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await Promise.all(
    roots.map(async (root) => {
      try {
        const r = await bridge.status(root);
        if (r.ok && r.value.files.length > 0) counts[root] = r.value.files.length;
      } catch {
        // ignore
      }
    }),
  );
  return counts;
}

// ---------------------------------------------------------------------------
// 面板 Store
// ---------------------------------------------------------------------------

export type GitPanelLoadState = 'loading' | 'ok' | 'not_a_repo' | 'failed';

export interface GitPanelDeps {
  bridge: GitBridge;
}

export interface GitPanelStore {
  files: Ref<GitPanelFile[] | null>;
  loadState: Ref<GitPanelLoadState>;
  errorMessage: Ref<string>;
  stagedFiles: ComputedRef<GitPanelFile[]>;
  unstagedFiles: ComputedRef<GitPanelFile[]>;
  /** 当前选中查看 diff 的文件(selectionKey 形式);null = 未选。 */
  selected: Ref<string | null>;
  /** stage/unstage 进行中的路径(行内按钮禁用/loading)。 */
  pendingPaths: Ref<Record<string, boolean>>;
  message: Ref<string>;
  committing: Ref<boolean>;
  commitError: Ref<string | null>;
  /** 最近一次成功 commit 的 hash(成功提示,下次 refresh 清除)。 */
  committedHash: Ref<string | null>;
  canCommit: ComputedRef<boolean>;
  open(workspacePath: string): void;
  refresh(): Promise<void>;
  select(path: string, staged: boolean): void;
  /** 取 diff;失败(桥错误/异常)返回 null,由组件降级展示。 */
  fetchDiff(path: string, staged: boolean): Promise<{ diff: string; truncated: boolean } | null>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  commit(): Promise<void>;
}

export function createGitPanelStore(deps: GitPanelDeps): GitPanelStore {
  const files = ref<GitPanelFile[] | null>(null);
  const loadState = ref<GitPanelLoadState>('loading');
  const errorMessage = ref('');
  const selected = ref<string | null>(null);
  const pendingPaths = ref<Record<string, boolean>>({});
  const message = ref('');
  const committing = ref(false);
  const commitError = ref<string | null>(null);
  const committedHash = ref<string | null>(null);

  let workspacePath = '';

  const grouped = computed(() => groupFiles(files.value ?? []));
  const stagedFiles = computed(() => grouped.value.staged);
  const unstagedFiles = computed(() => grouped.value.unstaged);

  const canCommit = computed(
    () => stagedFiles.value.length > 0 && message.value.trim().length > 0 && !committing.value,
  );

  /** 刷新后校正选中项:文件从对应组消失(被 stage/commit/还原)则取消选中。 */
  function reconcileSelection(): void {
    const key = selected.value;
    if (key === null) return;
    const stillThere =
      stagedFiles.value.some((f) => selectionKey(f.path, true) === key) ||
      unstagedFiles.value.some((f) => selectionKey(f.path, false) === key);
    if (!stillThere) selected.value = null;
  }

  async function refresh(): Promise<void> {
    if (!workspacePath) return;
    if (files.value === null) loadState.value = 'loading';
    let r: GitBridgeResult<{ files: GitPanelFile[] }>;
    try {
      r = await deps.bridge.status(workspacePath);
    } catch (err) {
      loadState.value = 'failed';
      errorMessage.value = String(err);
      return;
    }
    if (!r.ok) {
      loadState.value = r.error.kind === 'not_a_repo' ? 'not_a_repo' : 'failed';
      errorMessage.value = r.error.message;
      return;
    }
    files.value = r.value.files;
    loadState.value = 'ok';
    errorMessage.value = '';
    reconcileSelection();
  }

  function open(path: string): void {
    workspacePath = path;
    void refresh();
  }

  function select(path: string, staged: boolean): void {
    const key = selectionKey(path, staged);
    // 再点同一行 = 取消选中(收起 diff)
    selected.value = selected.value === key ? null : key;
  }

  async function fetchDiff(
    path: string,
    staged: boolean,
  ): Promise<{ diff: string; truncated: boolean } | null> {
    try {
      const r = await deps.bridge.diff(workspacePath, path, staged);
      return r.ok ? r.value : null;
    } catch {
      return null;
    }
  }

  async function mutate(kind: 'stage' | 'unstage', paths: string[]): Promise<void> {
    const pending = { ...pendingPaths.value };
    for (const p of paths) pending[p] = true;
    pendingPaths.value = pending;
    try {
      const r =
        kind === 'stage'
          ? await deps.bridge.stage(workspacePath, paths)
          : await deps.bridge.unstage(workspacePath, paths);
      if (!r.ok) {
        // 操作失败:整体错误条展示(保留当前列表)
        loadState.value = 'failed';
        errorMessage.value = r.error.message;
        return;
      }
      committedHash.value = null;
      await refresh();
    } finally {
      const next = { ...pendingPaths.value };
      for (const p of paths) delete next[p];
      pendingPaths.value = next;
    }
  }

  function stage(paths: string[]): Promise<void> {
    return mutate('stage', paths);
  }

  function unstage(paths: string[]): Promise<void> {
    return mutate('unstage', paths);
  }

  async function commit(): Promise<void> {
    if (!canCommit.value) return;
    committing.value = true;
    commitError.value = null;
    try {
      const r = await deps.bridge.commit(workspacePath, message.value.trim());
      if (!r.ok) {
        commitError.value = r.error.message;
        return;
      }
      committedHash.value = r.value.hash;
      message.value = '';
      await refresh();
    } catch (err) {
      commitError.value = String(err);
    } finally {
      committing.value = false;
    }
  }

  return {
    files,
    loadState,
    errorMessage,
    stagedFiles,
    unstagedFiles,
    selected,
    pendingPaths,
    message,
    committing,
    commitError,
    committedHash,
    canCommit,
    open,
    refresh,
    select,
    fetchDiff,
    stage,
    unstage,
    commit,
  };
}
