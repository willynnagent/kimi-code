// apps/kimi-web/src/components/codex/useTurnChanges.ts
// F9 按 turn 改动文件 + diff 预览(只读版,docs/09)。
//
// 数据源(全部官方只读面,零壳侧/daemon 改动):
//   - Edit/Write 精确归因:直接解析 ChatTurn.tools 的 name + arg(实时 WS 与
//     历史快照在 kimi-web 里汇入同一条消息流,tool 卡本就靠它渲染——比另起
//     WS 旁路 / transcript 端点更稳:ChatTurn.id 是消息组 id,与 daemon
//     turnId 无可靠映射,走 turnId Map 反而要靠脆弱的序号对齐)。
//   - Bash 盲区:turn 结束(main agent turnActive 下降沿)对工作区跑一次官方
//     fs:git_status,把"本轮新增脏文件"并入该 turn 并标记 source='other'。
//     基线在打开会话时建立,因此历史 turn 的未提交改动不会误归入后续 turn。
//     归属键 = 该 turn 最后一个工具调用的 toolCallId(turn.id 与数组下标
//     在消息流重算后都会漂移,两轮实机走查打回;toolCallId 持久化在消息
//     content 里,重算稳定);下降沿时 turns 尚未出现刚结束的 turn 则先入
//     pending,等 observeTurns 看到 turns 增长再归属(走查实测错挂上一轮)。
//   - diff 预览:fs:diff,语义是"该文件当前相对 HEAD 的 diff"(非该 turn 的
//     增量补丁——那需要快照,正是只读版砍掉的部分;UI 文案写明"当前 diff")。
//   - 非 git 工作区:fs:git_status 抛 40908(FS_GIT_UNAVAILABLE)→ 仅展示
//     Edit/Write 精确归因,diff 禁用。
//
// 已知边界(与 docs/09 §3 一致):
//   - shell 命令(Bash)改的文件只能经 git_status 归入"其他改动",无命令级归因。
//   - 历史 turn(页面打开前结束)只有 Edit/Write 精确归因,无"其他改动"。
//   - turn 结束时 git_status 瞬时失败:本轮跳过合并,脏文件会归入下一 turn。
//
// 测试友好:api 可注入(见 codex-turn-changes.test.ts);纯函数
// (extractEditedPaths / mergeTurnFiles / pathsOverlap)单独导出。

import { reactive } from 'vue';

import { getKimiWebApi } from '../../api';
import type { ChatTurn } from '../../types';
import { normalizeToolName } from '../../lib/toolMeta';

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

export interface TurnChangeFile {
  path: string;
  /** agent = Edit/Write 精确归因;other = turn 结束 git_status 并入的其他改动 */
  source: 'agent' | 'other';
}

/** daemon fs:git_status 对非 git 工作区返回的错误码(kap-server error-codes)。 */
export const FS_GIT_UNAVAILABLE_CODE = 40908;

// ---------------------------------------------------------------------------
// 纯函数(单测直接覆盖)
// ---------------------------------------------------------------------------

function parseToolArg(arg: string): Record<string, unknown> | null {
  const s = arg.trim();
  if (!s.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 从 Edit/Write 工具调用的 arg 里取目标路径(兼容 path / file_path 两种键)。 */
function extractPathFromArg(arg: string): string | undefined {
  const d = parseToolArg(arg);
  if (d === null) return undefined;
  const p = d['path'] ?? d['file_path'];
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

/** 一个 turn 的 Edit/Write 精确归因路径(去重、保序;忽略其他工具)。 */
export function extractEditedPaths(tools: { name: string; arg: string }[] | undefined): string[] {
  const out: string[] = [];
  for (const tool of tools ?? []) {
    const kind = normalizeToolName(tool.name);
    if (kind !== 'edit' && kind !== 'write') continue;
    const p = extractPathFromArg(tool.arg);
    if (p !== undefined && !out.some((x) => pathsOverlap(x, p))) out.push(p);
  }
  return out;
}

function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * 路径宽松匹配:Edit/Write 的 args 路径(相对 session cwd,可能绝对)与
 * git_status 的仓库相对路径未必逐字符一致,按"规范化后相等或为后缀边界"
 * 判定同一路径,避免同一文件在列表里出现两次(agent 编辑 + 其他改动)。
 */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na === nb) return true;
  return na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

/** 合并精确归因与 git 并入的其他改动:agent 来源优先,other 去重、保序。 */
export function mergeTurnFiles(agentPaths: string[], otherPaths: string[]): TurnChangeFile[] {
  const files: TurnChangeFile[] = agentPaths.map((path) => ({ path, source: 'agent' as const }));
  for (const p of otherPaths) {
    if (files.some((f) => pathsOverlap(f.path, p))) continue;
    files.push({ path: p, source: 'other' });
  }
  return files;
}

/** DaemonApiError(或任何带 code 的错误)是否为 FS_GIT_UNAVAILABLE。 */
export function isGitUnavailableError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === FS_GIT_UNAVAILABLE_CODE
  );
}

// ---------------------------------------------------------------------------
// 依赖注入面(测试用)
// ---------------------------------------------------------------------------

export interface TurnChangesApi {
  getGitStatus(sessionId: string): Promise<{ entries: Record<string, string> }>;
  getFileDiff(sessionId: string, path: string): Promise<{ path: string; diff: string }>;
}

export interface TurnChangesDeps {
  api?: TurnChangesApi;
}

interface SessionGitState {
  /** 打开会话时的脏文件基线;null = 尚未成功建立(或已确认非 git)。 */
  baseline: string[] | null;
  /** true = fs:git_status 返回 40908,该工作区不是 git 仓库。 */
  gitUnavailable: boolean;
  /**
   * 该 turn 最后一个工具调用的 toolCallId → turn 结束时 git_status 并入的
   * 新增脏文件。键的稳定性考证(两轮实机走查打回后定稿):
   * - turn.id 不稳:是"组内第一条 assistant 消息 id",流式副本与持久化
   *   副本 id 不同(messagesToTurns fold 注释),重算即漂移(走查 1)。
   * - 数组下标不稳:任意消息更新(usage 推送等)触发 turns 整体重算,
   *   同长度替换也会让归属错位(走查 2)。
   * - ChatTurn.tools[].id 稳定:取自 daemon tool.call 事件的 tool_call_id,
   *   持久化在消息 tool_use content 里(mappers.ts tool_use ↔ toolCallId),
   *   重算前后是同一个值——工具卡本就靠它渲染。
   * 逻辑前提:能产生 git_status delta 的 turn 必然至少执行过一个工具,
   * 所以"最后一个 tool call id"总是存在;无工具调用的 turn 不可能有
   * "其他改动",查表时安全退化为仅精确归因。
   */
  otherByToolKey: Record<string, string[]>;
  /**
   * 归属待定批次:turnActive 下降沿时 props.turns 可能还没出现刚结束的
   * assistant turn(实机走查实测:delta 错挂上一个 turn),此时 delta 先
   * 入 pending,observeTurns 看到 turns 里长出新的 assistant turn 后再按
   * 顺序归属。pending 期间不落任何 turn。
   */
  pending: string[][];
  /**
   * 已"入账"的 assistant turn 数:上次归属/初始化时 turns 里已确认的
   * assistant turn 个数。turn 结束时 n > assistantCount 视为"刚结束的
   * turn 已在 turns 里",可直接归属;否则入 pending。
   */
  assistantCount: number;
  /** 是否已做过首次观察(初始化 assistantCount)。 */
  observed: boolean;
}

export interface TurnChangesStore {
  /** ChatPane 挂载/切换会话时调用:建立 git 基线(幂等)。 */
  noteSession(sessionId: string): void;
  /** turns 数组每次变化时调用:初始化计数、undo 回收、pending 归属。 */
  observeTurns(sessionId: string, turns: ChatTurn[], turnActive: boolean): void;
  /** main agent turn 结束(turnActive 下降沿)时调用:git_status 合并。 */
  noteTurnEnd(sessionId: string, turns: ChatTurn[]): void;
  /** 该 turn 的完整改动文件列表(精确归因 + 其他改动合并)。响应式。
   *  归属键从 tools 的最后一个 toolCallId 推导;无工具调用 → 仅精确归因。 */
  filesFor(sessionId: string, tools: ChatTurn['tools']): TurnChangeFile[];
  /** 该会话 git 是否可用(未知时按可用处理,避免闪烁禁用)。 */
  gitAvailable(sessionId: string): boolean;
  /** 取某文件当前相对 HEAD 的 diff(失败抛错,由调用方降级)。 */
  fetchDiff(sessionId: string, path: string): Promise<string>;
  /** 清空全部状态(测试用)。 */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createTurnChangesStore(deps: TurnChangesDeps = {}): TurnChangesStore {
  const sessions = reactive<Record<string, SessionGitState>>({});
  /** 每会话串行链:基线建立与 turn 结束合并按序执行,避免并发竞争。 */
  const chains = new Map<string, Promise<void>>();

  let apiCache: TurnChangesApi | null = null;
  function api(): TurnChangesApi {
    if (deps.api) return deps.api;
    apiCache ??= getKimiWebApi();
    return apiCache;
  }

  function stateOf(sessionId: string): SessionGitState {
    let s = sessions[sessionId];
    if (s === undefined) {
      s = {
        baseline: null,
        gitUnavailable: false,
        otherByToolKey: {},
        pending: [],
        assistantCount: 0,
        observed: false,
      };
      sessions[sessionId] = s;
    }
    return s;
  }

  function enqueue(sessionId: string, job: () => Promise<void>): void {
    const prev = chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(job, job);
    chains.set(sessionId, next);
  }

  // ---------------------------------------------------------------------------
  // turns 观察:计数初始化 / undo 回收 / pending 归属
  // ---------------------------------------------------------------------------

  function assistantCount(turns: ChatTurn[]): number {
    let n = 0;
    for (const t of turns) {
      if (t.role === 'assistant') n += 1;
    }
    return n;
  }

  /** 归属键:该 turn 最后一个工具调用的 toolCallId;无工具 → undefined。 */
  function toolKeyOf(turn: ChatTurn | undefined): string | undefined {
    const tools = turn?.tools;
    if (tools === undefined || tools.length === 0) return undefined;
    return tools[tools.length - 1]!.id;
  }

  function lastAssistant(turns: ChatTurn[]): ChatTurn | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]!.role === 'assistant') return turns[i];
    }
    return undefined;
  }

  function mergeInto(s: SessionGitState, key: string, paths: string[]): void {
    const existing = s.otherByToolKey[key] ?? [];
    const merged = existing.slice();
    for (const p of paths) {
      if (!merged.some((x) => pathsOverlap(x, p))) merged.push(p);
    }
    s.otherByToolKey = { ...s.otherByToolKey, [key]: merged };
  }

  /**
   * 把一个 delta 批次归属到目标 turn。目标无工具调用时丢弃(逻辑上不会
   * 发生:有 git delta 必有工具执行;防御 turns 里工具 content 缺失的
   * 异常重算,丢弃优于错挂到下一轮)。
   */
  function attributeTo(s: SessionGitState, turn: ChatTurn | undefined, paths: string[]): void {
    const key = toolKeyOf(turn);
    if (key === undefined) return;
    mergeInto(s, key, paths);
  }

  function observeTurns(sessionId: string, turns: ChatTurn[], turnActive: boolean): void {
    const s = stateOf(sessionId);
    const n = assistantCount(turns);

    if (!s.observed) {
      // 首次观察:把现存 assistant turn 全部视为已入账(历史轮);若正有一个
      // turn 在跑,其 assistant turn 不算入账——它结束时应被视为新出现的。
      const running =
        turnActive && turns.length > 0 && turns[turns.length - 1]!.role === 'assistant';
      s.assistantCount = n - (running ? 1 : 0);
      s.observed = true;
      return;
    }

    // turns 变少(undo 撤销最后一轮):回收计数,保证 resent turn 结束时被
    // 视作新 turn。归属键与位置无关,被撤 turn 的孤儿键无害(展示端按自己
    // 的 tools 查表,永远不会查到已删除 turn 的 key)。
    if (n < s.assistantCount) s.assistantCount = n;

    // pending 归属:turns 里长出了 pending 批次等待的 assistant turn。
    // 按顺序一一对应:最老的 pending 批次归"已入账之后第一个"新 turn。
    if (s.pending.length > 0 && n > s.assistantCount) {
      const assistants = turns.filter((t) => t.role === 'assistant');
      let k = Math.min(s.pending.length, n - s.assistantCount);
      while (k > 0) {
        const batch = s.pending.shift()!;
        attributeTo(s, assistants[s.assistantCount], batch);
        s.assistantCount += 1;
        k -= 1;
      }
    }
  }

  /** 建立(或重建)基线。40908 → 标记非 git;其他错误 → 保持 null 留待重试。 */
  async function ensureBaseline(sessionId: string): Promise<void> {
    const s = stateOf(sessionId);
    if (s.baseline !== null || s.gitUnavailable) return;
    try {
      const status = await api().getGitStatus(sessionId);
      s.baseline = Object.keys(status.entries);
    } catch (err) {
      if (isGitUnavailableError(err)) s.gitUnavailable = true;
      // 其余失败(会话 404、网络等):baseline 保持 null,下次 noteSession/
      // noteTurnEnd 会重试——绝不能把"未知基线"当空基线,否则整份脏文件
      // 清单会倒进下一个 turn。
    }
  }

  function noteSession(sessionId: string): void {
    stateOf(sessionId);
    enqueue(sessionId, () => ensureBaseline(sessionId));
  }

  function noteTurnEnd(sessionId: string, turns: ChatTurn[]): void {
    enqueue(sessionId, async () => {
      await ensureBaseline(sessionId);
      const s = stateOf(sessionId);
      if (s.gitUnavailable || s.baseline === null) return;

      let status: { entries: Record<string, string> };
      try {
        status = await api().getGitStatus(sessionId);
      } catch (err) {
        if (isGitUnavailableError(err)) s.gitUnavailable = true;
        // 瞬时失败:保留旧基线,本轮不合并(脏文件顺延到下一 turn)。
        return;
      }
      const current = Object.keys(status.entries);
      const delta = current.filter((p) => !s.baseline!.some((b) => pathsOverlap(b, p)));
      // 无论 delta 是否为空都推进基线,防止同一批脏文件重复计入后续 turn。
      s.baseline = current;
      if (delta.length === 0) return;

      // 归属:turns 里最后一个 assistant turn 是不是"刚结束的这一轮"?
      // 判定靠计数而非 id(时序与 id/下标漂移见 SessionGitState 注释):
      // n > assistantCount → 新 turn 已出现,直接归属;否则入 pending,
      // 等 observeTurns 看到 turns 增长后再归属。
      const n = assistantCount(turns);
      if (!s.observed) {
        // 未经 observeTurns 初始化(防御:生产路径 observeTurns 总是先到):
        // 乐观假设最后一个 assistant turn 就是刚结束的这轮。
        s.assistantCount = Math.max(0, n - 1);
        s.observed = true;
      }
      if (n > s.assistantCount) {
        attributeTo(s, lastAssistant(turns), delta);
        s.assistantCount = n;
      } else {
        s.pending.push(delta);
      }
    });
  }

  function filesFor(sessionId: string, tools: ChatTurn['tools']): TurnChangeFile[] {
    const key = tools !== undefined && tools.length > 0 ? tools[tools.length - 1]!.id : undefined;
    const other = key !== undefined ? (sessions[sessionId]?.otherByToolKey[key] ?? []) : [];
    return mergeTurnFiles(extractEditedPaths(tools), other);
  }

  function gitAvailable(sessionId: string): boolean {
    return sessions[sessionId]?.gitUnavailable !== true;
  }

  async function fetchDiff(sessionId: string, path: string): Promise<string> {
    const result = await api().getFileDiff(sessionId, path);
    return result.diff;
  }

  function reset(): void {
    for (const key of Object.keys(sessions)) delete sessions[key];
    chains.clear();
  }

  return { noteSession, observeTurns, noteTurnEnd, filesFor, gitAvailable, fetchDiff, reset };
}

// ---------------------------------------------------------------------------
// 懒单例(组件直接用;测试走 createTurnChangesStore 注入假 api)
// ---------------------------------------------------------------------------

let singleton: TurnChangesStore | undefined;

export function getTurnChangesStore(): TurnChangesStore {
  singleton ??= createTurnChangesStore();
  return singleton;
}
