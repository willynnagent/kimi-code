import { describe, expect, it } from 'vitest';

import type { ChatTurn, ToolCall } from '../src/types';
import {
  createTurnChangesStore,
  extractEditedPaths,
  isGitUnavailableError,
  mergeTurnFiles,
  pathsOverlap,
  FS_GIT_UNAVAILABLE_CODE,
  type TurnChangesApi,
  type TurnChangesStore,
} from '../src/components/codex/useTurnChanges';

// F9 按 turn 改动文件(docs/09)的纯逻辑测试。
// 本包 vitest 运行在 node 环境(无 jsdom / 组件挂载,见 apps/kimi-web/AGENTS.md),
// 因此展开/链接/diff 视图不挂组件,归因、git_status 合并与降级都通过
// store 状态 + 纯函数覆盖。

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Mock 基础设施
// ---------------------------------------------------------------------------

/**
 * 构造 assistant turn。工具 id 默认从 toolNs 生成——模拟 daemon tool_call_id:
 * 同一逻辑 turn 重算(turn.id 变化)时工具 id 保持不变,与生产一致。
 */
function assistant(
  id: string,
  tools?: { name: string; arg: string }[],
  toolNs = id,
): ChatTurn {
  return {
    id,
    role: 'assistant',
    no: 1,
    text: '',
    tools: tools?.map(
      (t, i): ToolCall => ({ id: `${toolNs}-tool${i}`, status: 'ok' as const, ...t }),
    ),
  };
}

function bashTool(command: string): { name: string; arg: string } {
  return { name: 'Bash', arg: JSON.stringify({ command }) };
}

function user(id: string): ChatTurn {
  return { id, role: 'user', no: 1, text: 'hi' };
}

interface FakeGit {
  entries: Record<string, string>;
  /** 设置后 getGitStatus 抛该错误(一次性或持续,视 clearOnCall)。 */
  error?: { code?: number; message?: string } | null;
  clearErrorOnCall?: boolean;
}

function makeApi(git: FakeGit, diffs: Record<string, string> = {}): {
  api: TurnChangesApi;
  gitCalls: string[];
} {
  const gitCalls: string[] = [];
  return {
    gitCalls,
    api: {
      getGitStatus(sessionId: string) {
        gitCalls.push(sessionId);
        if (git.error != null) {
          const err = git.error;
          if (git.clearErrorOnCall === true) git.error = null;
          return Promise.reject(Object.assign(new Error(err.message ?? 'boom'), { code: err.code }));
        }
        return Promise.resolve({ entries: git.entries });
      },
      getFileDiff(_sessionId: string, path: string) {
        const diff = diffs[path];
        if (diff === undefined) return Promise.reject(new Error('no diff'));
        return Promise.resolve({ path, diff });
      },
    },
  };
}

/** 生产时序:turn 进行中 turns 已含该 assistant turn(turnActive=true)。 */
function observeRunning(store: TurnChangesStore, sid: string, turns: ChatTurn[]): void {
  store.observeTurns(sid, turns, true);
}

// ---------------------------------------------------------------------------
// extractEditedPaths(Edit/Write 精确归因)
// ---------------------------------------------------------------------------

describe('extractEditedPaths', () => {
  it('提取 Edit 的 path', () => {
    const tools = [{ name: 'Edit', arg: '{"path":"src/a.ts","old_string":"x","new_string":"y"}' }];
    expect(extractEditedPaths(tools)).toEqual(['src/a.ts']);
  });

  it('提取 Write 的 path', () => {
    const tools = [{ name: 'Write', arg: '{"path":"docs/b.md","content":"..."}' }];
    expect(extractEditedPaths(tools)).toEqual(['docs/b.md']);
  });

  it('兼容 file_path 键', () => {
    const tools = [{ name: 'Edit', arg: '{"file_path":"src/c.ts","old_string":"x","new_string":"y"}' }];
    expect(extractEditedPaths(tools)).toEqual(['src/c.ts']);
  });

  it('多文件保序、忽略非写工具', () => {
    const tools = [
      { name: 'Read', arg: '{"path":"src/read-only.ts"}' },
      { name: 'Edit', arg: '{"path":"src/a.ts"}' },
      { name: 'Bash', arg: '{"command":"echo >> src/shell.txt"}' },
      { name: 'Write', arg: '{"path":"src/b.ts"}' },
      { name: 'Grep', arg: '{"pattern":"x"}' },
    ];
    expect(extractEditedPaths(tools)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('同一文件多次编辑去重', () => {
    const tools = [
      { name: 'Edit', arg: '{"path":"src/a.ts","old_string":"1","new_string":"2"}' },
      { name: 'Edit', arg: '{"path":"src/a.ts","old_string":"3","new_string":"4"}' },
    ];
    expect(extractEditedPaths(tools)).toEqual(['src/a.ts']);
  });

  it('arg 非 JSON / 缺 path 时跳过', () => {
    const tools = [
      { name: 'Edit', arg: 'not-json' },
      { name: 'Edit', arg: '{"old_string":"x"}' },
      { name: 'Write', arg: '[1,2]' },
    ];
    expect(extractEditedPaths(tools)).toEqual([]);
  });

  it('tools 为空返回空数组', () => {
    expect(extractEditedPaths(undefined)).toEqual([]);
    expect(extractEditedPaths([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pathsOverlap / mergeTurnFiles
// ---------------------------------------------------------------------------

describe('pathsOverlap', () => {
  it('规范化后相等', () => {
    expect(pathsOverlap('src/a.ts', 'src/a.ts')).toBe(true);
    expect(pathsOverlap('./src/a.ts', 'src/a.ts')).toBe(true);
  });

  it('后缀边界宽松匹配(绝对 vs 仓库相对)', () => {
    expect(pathsOverlap('/repo/src/a.ts', 'src/a.ts')).toBe(true);
    expect(pathsOverlap('src/a.ts', '/repo/src/a.ts')).toBe(true);
  });

  it('非边界的尾部相同不算同一路径', () => {
    expect(pathsOverlap('src/xa.ts', 'a.ts')).toBe(false);
    expect(pathsOverlap('src/a.ts', 'src/b.ts')).toBe(false);
  });
});

describe('mergeTurnFiles', () => {
  it('agent 来源优先,other 去重保序', () => {
    const merged = mergeTurnFiles(['src/a.ts'], ['src/a.ts', 'tmp/out.txt']);
    expect(merged).toEqual([
      { path: 'src/a.ts', source: 'agent' },
      { path: 'tmp/out.txt', source: 'other' },
    ]);
  });

  it('宽松匹配命中时 other 不重复出现', () => {
    const merged = mergeTurnFiles(['src/a.ts'], ['/repo/src/a.ts']);
    expect(merged).toEqual([{ path: 'src/a.ts', source: 'agent' }]);
  });
});

// ---------------------------------------------------------------------------
// isGitUnavailableError
// ---------------------------------------------------------------------------

describe('isGitUnavailableError', () => {
  it('识别 40908', () => {
    expect(isGitUnavailableError(Object.assign(new Error('x'), { code: FS_GIT_UNAVAILABLE_CODE }))).toBe(true);
    expect(isGitUnavailableError(Object.assign(new Error('x'), { code: 40401 }))).toBe(false);
    expect(isGitUnavailableError(new Error('x'))).toBe(false);
    expect(isGitUnavailableError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// store:git_status 合并与标记(toolCallId 键 + pending 归属)
// ---------------------------------------------------------------------------

describe('createTurnChangesStore', () => {
  it('turn 结束时把新增脏文件归入刚结束的 turn 并标 other', async () => {
    const git: FakeGit = { entries: { 'src/existing.ts': 'M' } };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    const a1 = assistant('a1', [
      { name: 'Edit', arg: '{"path":"src/a.ts"}' },
      bashTool('echo hi >> src/shell.txt'),
    ]);
    observeRunning(store, 's1', [user('u1'), a1]);
    await flush(); // 基线:src/existing.ts

    git.entries = { 'src/existing.ts': 'M', 'src/a.ts': 'M', 'src/shell.txt': 'M' };
    store.observeTurns('s1', [user('u1'), a1], false);
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();

    expect(store.filesFor('s1', a1.tools)).toEqual([
      { path: 'src/a.ts', source: 'agent' },
      { path: 'src/shell.txt', source: 'other' },
    ]);
  });

  it('基线推进:同一批脏文件不会重复计入下一 turn', async () => {
    const git: FakeGit = { entries: {} };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();

    const a1 = assistant('a1', [bashTool('touch shell.txt')]);
    observeRunning(store, 's1', [user('u1'), a1]);
    git.entries = { 'src/shell.txt': 'M' };
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();

    const a2 = assistant('a2', [bashTool('true')]);
    const turns2 = [user('u1'), a1, user('u2'), a2];
    observeRunning(store, 's1', turns2);
    store.noteTurnEnd('s1', turns2);
    await flush();

    expect(store.filesFor('s1', a1.tools)).toEqual([{ path: 'src/shell.txt', source: 'other' }]);
    expect(store.filesFor('s1', a2.tools)).toEqual([]);
  });

  it('多 turn 连续:每轮只拿自己新增的脏文件,不错挂', async () => {
    const git: FakeGit = { entries: {} };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();

    const a1 = assistant('a1', [bashTool('touch c.txt')]);
    observeRunning(store, 's1', [user('u1'), a1]);
    git.entries = { 'c.txt': '??' };
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();

    const a2 = assistant('a2', [bashTool('touch d.txt')]);
    const turns2 = [user('u1'), a1, user('u2'), a2];
    observeRunning(store, 's1', turns2);
    git.entries = { 'c.txt': '??', 'd.txt': '??' };
    store.noteTurnEnd('s1', turns2);
    await flush();

    expect(store.filesFor('s1', a1.tools)).toEqual([{ path: 'c.txt', source: 'other' }]);
    expect(store.filesFor('s1', a2.tools)).toEqual([{ path: 'd.txt', source: 'other' }]);
  });

  // -------------------------------------------------------------------------
  // 走查回归①:同长度重算(usage 推送后重建,对象全换引用、turn.id 全变)
  // -------------------------------------------------------------------------

  it('turns 同长度重算 turn.id 漂移:toolCallId 键稳定,归因不丢', async () => {
    const git: FakeGit = { entries: {} };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();

    // 工具 id 用独立命名空间:重算前后保持一致(模拟持久化的 tool_call_id)
    const a1 = assistant('a1-streamed', [bashTool('touch c.txt')], 'call');
    observeRunning(store, 's1', [user('u1'), a1]);
    git.entries = { 'c.txt': '??' };
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();
    expect(store.filesFor('s1', a1.tools)).toEqual([{ path: 'c.txt', source: 'other' }]);

    // usage 推送触发整体重算:turn 对象换引用、turn.id 全变、工具 id 不变
    const a1Rebuilt = assistant('a1-persisted', [bashTool('touch c.txt')], 'call');
    store.observeTurns('s1', [user('u1-persisted'), a1Rebuilt], false);
    expect(store.filesFor('s1', a1Rebuilt.tools)).toEqual([{ path: 'c.txt', source: 'other' }]);
  });

  // -------------------------------------------------------------------------
  // 走查回归②:下降沿时 turns 未更新 → pending → turns 出现后正确归属
  // -------------------------------------------------------------------------

  it('下降沿时 turns 还没出现刚结束的 turn:delta 入 pending,不挂旧 turn', async () => {
    const git: FakeGit = { entries: {} };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();

    // turn1 正常结束(c.txt)
    const a1 = assistant('a1', [bashTool('touch c.txt')]);
    observeRunning(store, 's1', [user('u1'), a1]);
    git.entries = { 'c.txt': '??' };
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();
    expect(store.filesFor('s1', a1.tools)).toEqual([{ path: 'c.txt', source: 'other' }]);

    // turn2 结束,但此刻 turns 还是旧数组(只有 turn1)——走查实录的时序
    git.entries = { 'c.txt': '??', 'd.txt': '??' };
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();

    // pending 期间:d.txt 不落任何 turn(turn1 仍只有 c.txt)
    expect(store.filesFor('s1', a1.tools)).toEqual([{ path: 'c.txt', source: 'other' }]);

    // turns 更新后出现 turn2 → pending 归属到 turn2
    const a2 = assistant('a2', [bashTool('touch d.txt')]);
    store.observeTurns('s1', [user('u1'), a1, user('u2'), a2], false);
    expect(store.filesFor('s1', a2.tools)).toEqual([{ path: 'd.txt', source: 'other' }]);
    expect(store.filesFor('s1', a1.tools)).toEqual([{ path: 'c.txt', source: 'other' }]);
  });

  // -------------------------------------------------------------------------
  // 走查回归③:prepend 分页(键与位置无关,天然免疫)
  // -------------------------------------------------------------------------

  it('prepend 分页(加载更早消息):归因仍命中', async () => {
    const git: FakeGit = { entries: {} };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();

    const a1 = assistant('a1', [bashTool('touch c.txt')]);
    observeRunning(store, 's1', [user('u1'), a1]);
    git.entries = { 'c.txt': '??' };
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();

    // 顶部加载出更早的一轮:数组位置全移,键不受影响
    const a0 = assistant('a0', [bashTool('true')]);
    store.observeTurns('s1', [user('u0'), a0, user('u1'), a1], false);
    expect(store.filesFor('s1', a1.tools)).toEqual([{ path: 'c.txt', source: 'other' }]);
    expect(store.filesFor('s1', a0.tools)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 走查回归④:无工具调用的 turn 不可能有"其他改动"
  // -------------------------------------------------------------------------

  it('无工具调用的 turn:不查表,也不成为归属目标(delta 丢弃优于错挂)', async () => {
    const git: FakeGit = { entries: {} };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();

    // 纯文本 turn(无 tools):即使有 git delta 也不归属(防御异常重算)
    const a1 = assistant('a1');
    observeRunning(store, 's1', [user('u1'), a1]);
    git.entries = { 'c.txt': '??' };
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();
    expect(store.filesFor('s1', a1.tools)).toEqual([]);

    // 基线已推进:下一 turn 不会捡到这批脏文件
    const a2 = assistant('a2', [bashTool('true')]);
    const turns2 = [user('u1'), a1, user('u2'), a2];
    observeRunning(store, 's1', turns2);
    store.noteTurnEnd('s1', turns2);
    await flush();
    expect(store.filesFor('s1', a2.tools)).toEqual([]);
  });

  it('undo 撤销最后一轮后 resent:新 turn 结束被视作新 turn 归属', async () => {
    const git: FakeGit = { entries: {} };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();

    const a1 = assistant('a1', [bashTool('touch c.txt')]);
    observeRunning(store, 's1', [user('u1'), a1]);
    git.entries = { 'c.txt': '??' };
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();

    // undo:turns 尾部删除;resent:新 user + 新 assistant
    store.observeTurns('s1', [], false);
    const a2 = assistant('a2', [bashTool('touch d.txt')]);
    const turns2 = [user('u2'), a2];
    observeRunning(store, 's1', turns2);
    git.entries = { 'c.txt': '??', 'd.txt': '??' };
    store.noteTurnEnd('s1', turns2);
    await flush();

    expect(store.filesFor('s1', a2.tools)).toEqual([{ path: 'd.txt', source: 'other' }]);
  });

  it('页面打开时已有 turn 在跑:其结束仍归到该 turn', async () => {
    const git: FakeGit = { entries: {} };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    // 首次观察时 turn 正在跑:运行中的 assistant turn 不算"已入账"
    const a1 = assistant('a1', [bashTool('true')]);
    const a2 = assistant('a2', [bashTool('touch d.txt')]);
    observeRunning(store, 's1', [user('u1'), a1, user('u2'), a2]);
    await flush();

    git.entries = { 'd.txt': '??' };
    const turns = [user('u1'), a1, user('u2'), a2];
    store.observeTurns('s1', turns, false);
    store.noteTurnEnd('s1', turns);
    await flush();

    expect(store.filesFor('s1', a2.tools)).toEqual([{ path: 'd.txt', source: 'other' }]);
    expect(store.filesFor('s1', a1.tools)).toEqual([]);
  });

  it('git 相对路径与 Edit 绝对路径命中时不重复列出', async () => {
    const git: FakeGit = { entries: {} };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();

    const a1 = assistant('a1', [{ name: 'Edit', arg: '{"path":"/repo/src/a.ts"}' }]);
    observeRunning(store, 's1', [user('u1'), a1]);
    git.entries = { 'src/a.ts': 'M' };
    store.observeTurns('s1', [user('u1'), a1], false);
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();

    expect(store.filesFor('s1', a1.tools)).toEqual([{ path: '/repo/src/a.ts', source: 'agent' }]);
  });

  it('turn 结束时 turns 里没有 assistant turn:delta 入 pending,出现后续延归属', async () => {
    const git: FakeGit = { entries: {} };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();

    git.entries = { 'a.txt': 'M' };
    store.noteTurnEnd('s1', []);
    await flush();

    // 基线已推进:后续 git_status 与基线一致,不重复计入
    git.entries = { 'a.txt': 'M' };
    const a1 = assistant('a1', [bashTool('true')]);
    observeRunning(store, 's1', [user('u1'), a1]);
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();

    // 空 turns 那一轮的 delta 顺延到第一个出现的 assistant turn
    expect(store.filesFor('s1', a1.tools)).toEqual([{ path: 'a.txt', source: 'other' }]);
  });

  // -------------------------------------------------------------------------
  // 非 git 降级
  // -------------------------------------------------------------------------

  it('40908 → 标记非 git:仅 Edit/Write 归因,diff 不可用', async () => {
    const git: FakeGit = { entries: {}, error: { code: FS_GIT_UNAVAILABLE_CODE } };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();
    expect(store.gitAvailable('s1')).toBe(false);

    const a1 = assistant('a1', [{ name: 'Write', arg: '{"path":"a.txt"}' }]);
    observeRunning(store, 's1', [user('u1'), a1]);
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();

    expect(store.filesFor('s1', a1.tools)).toEqual([{ path: 'a.txt', source: 'agent' }]);
    expect(store.gitAvailable('s1')).toBe(false);
  });

  it('git_status 瞬时失败:不误标非 git,脏文件顺延到下一 turn', async () => {
    const git: FakeGit = { entries: {} };
    const { api, gitCalls } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush();
    expect(gitCalls).toEqual(['s1']);

    // turn1 结束时 git_status 抛普通错误(非 40908)
    git.error = { message: 'network' };
    git.entries = { 'a.txt': 'M' };
    const a1 = assistant('a1', [bashTool('touch a.txt')]);
    observeRunning(store, 's1', [user('u1'), a1]);
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush();

    expect(store.gitAvailable('s1')).toBe(true);
    expect(store.filesFor('s1', a1.tools)).toEqual([]);

    // 恢复后 turn2 拿到累计脏文件(顺延归因,文档化边界)
    git.error = null;
    const a2 = assistant('a2', [bashTool('true')]);
    const turns2 = [user('u1'), a1, user('u2'), a2];
    observeRunning(store, 's1', turns2);
    store.noteTurnEnd('s1', turns2);
    await flush();
    expect(store.filesFor('s1', a2.tools)).toEqual([{ path: 'a.txt', source: 'other' }]);
  });

  it('基线未建立前 turn 结束:不把整份脏文件清单倒进该 turn', async () => {
    // 基线建立就失败(普通错误)→ baseline 保持 null → noteTurnEnd 跳过合并
    const git: FakeGit = { entries: { 'old.ts': 'M' }, error: { message: 'down' }, clearErrorOnCall: true };
    const { api } = makeApi(git);
    const store = createTurnChangesStore({ api });

    store.noteSession('s1');
    await flush(); // 基线建立失败,baseline 仍 null

    const a1 = assistant('a1', [bashTool('true')]);
    observeRunning(store, 's1', [user('u1'), a1]);
    store.noteTurnEnd('s1', [user('u1'), a1]);
    await flush(); // noteTurnEnd 里 ensureBaseline 重试成功,随后 git_status 与基线一致 → 无 delta

    expect(store.filesFor('s1', a1.tools)).toEqual([]);
  });

  it('fetchDiff 透传 daemon diff 文本', async () => {
    const { api } = makeApi({ entries: {} }, { 'src/a.ts': 'diff --git a/src/a.ts b/src/a.ts\n+line' });
    const store = createTurnChangesStore({ api });
    await expect(store.fetchDiff('s1', 'src/a.ts')).resolves.toContain('+line');
    await expect(store.fetchDiff('s1', 'missing.ts')).rejects.toThrow('no diff');
  });
});
