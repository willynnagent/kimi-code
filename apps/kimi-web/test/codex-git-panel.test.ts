import { describe, expect, it } from 'vitest';

import {
  createGitPanelStore,
  fetchGitChangeCounts,
  groupFiles,
  isStaged,
  isUnstaged,
  resolveGitBridge,
  selectionKey,
  statusCodeOf,
  type GitBridge,
  type GitBridgeResult,
  type GitPanelFile,
} from '../src/components/codex/useGitPanel';

// F11 Git stage / commit 面板(docs/10)kimi-web 侧纯逻辑测试。
// 本包 vitest 运行在 node 环境(无 jsdom / 组件挂载,见 apps/kimi-web/AGENTS.md),
// 因此分组渲染、空态、commit 按钮可用性都通过 store 状态 + 纯函数覆盖。

const WS = '/repo/main';

function file(path: string, index: string, workTree: string): GitPanelFile {
  return { path, index, workTree };
}

function ok<T>(value: T): GitBridgeResult<T> {
  return { ok: true, value };
}

function fail(kind: 'not_a_repo' | 'git_failed' | 'invalid_path', message = kind): GitBridgeResult<never> {
  return { ok: false, error: { kind, message } };
}

interface BridgeCalls {
  status: number;
  stage: string[][];
  unstage: string[][];
  commit: string[];
  diff: Array<{ path: string; staged: boolean }>;
}

function mockBridge(routes: {
  status?: () => GitBridgeResult<{ files: GitPanelFile[] }> | Promise<GitBridgeResult<{ files: GitPanelFile[] }>>;
  stage?: () => GitBridgeResult<null>;
  unstage?: () => GitBridgeResult<null>;
  commit?: () => GitBridgeResult<{ hash: string }>;
  diff?: () => GitBridgeResult<{ diff: string; truncated: boolean }>;
}): { bridge: GitBridge; calls: BridgeCalls } {
  const calls: BridgeCalls = { status: 0, stage: [], unstage: [], commit: [], diff: [] };
  return {
    calls,
    bridge: {
      status: () => {
        calls.status += 1;
        return Promise.resolve(routes.status?.() ?? ok({ files: [] }));
      },
      diff: (_ws, path, staged) => {
        calls.diff.push({ path, staged });
        return Promise.resolve(routes.diff?.() ?? ok({ diff: '', truncated: false }));
      },
      stage: (_ws, paths) => {
        calls.stage.push(paths);
        return Promise.resolve(routes.stage?.() ?? ok(null));
      },
      unstage: (_ws, paths) => {
        calls.unstage.push(paths);
        return Promise.resolve(routes.unstage?.() ?? ok(null));
      },
      commit: (_ws, message) => {
        calls.commit.push(message);
        return Promise.resolve(routes.commit?.() ?? ok({ hash: 'abc123def' }));
      },
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('resolveGitBridge(桌面桥探测)', () => {
  it('无 desktop / 无 git / 方法缺失 → null', () => {
    expect(resolveGitBridge(undefined)).toBeNull();
    expect(resolveGitBridge({})).toBeNull();
    expect(resolveGitBridge({ git: {} })).toBeNull();
    expect(resolveGitBridge({ git: { status: () => {}, diff: () => {} } })).toBeNull();
  });

  it('五个方法齐全 → 桥可用', () => {
    const { bridge } = mockBridge({});
    expect(resolveGitBridge({ git: bridge })).toBe(bridge);
  });
});

describe('isStaged / isUnstaged(porcelain 双列)', () => {
  it('各状态组合', () => {
    expect(isStaged(file('a', 'M', ' '))).toBe(true);
    expect(isStaged(file('a', ' ', 'M'))).toBe(false);
    expect(isStaged(file('a', '?', '?'))).toBe(false); // 未跟踪不算已暂存
    expect(isUnstaged(file('a', '?', '?'))).toBe(true); // 但未跟踪属于"未暂存"组
    expect(isUnstaged(file('a', 'M', ' '))).toBe(false);
    expect(isUnstaged(file('a', 'M', 'M'))).toBe(true);
    expect(isStaged(file('a', '!', '!'))).toBe(false);
    expect(isUnstaged(file('a', '!', '!'))).toBe(false);
  });
});

describe('groupFiles(分组 + 排序)', () => {
  it('MM 文件同时进两组;各组按路径排序', () => {
    const files = [
      file('b.ts', ' ', 'M'),
      file('a.ts', 'M', 'M'),
      file('c.ts', 'A', ' '),
      file('d.ts', '?', '?'),
    ];
    const g = groupFiles(files);
    expect(g.staged.map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
    expect(g.unstaged.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'd.ts']);
  });

  it('空列表 → 两组皆空', () => {
    expect(groupFiles([])).toEqual({ staged: [], unstaged: [] });
  });
});

describe('selectionKey / statusCodeOf', () => {
  it('组归属入 key;状态码按组取列', () => {
    expect(selectionKey('a.ts', true)).toBe('S:a.ts');
    expect(selectionKey('a.ts', false)).toBe('U:a.ts');
    expect(statusCodeOf(file('a', 'M', 'D'), true)).toBe('M');
    expect(statusCodeOf(file('a', 'M', 'D'), false)).toBe('D');
  });
});

describe('fetchGitChangeCounts(侧栏计数点)', () => {
  it('只记录有变更的项目;非 git 仓库与失败项静默跳过', async () => {
    const { bridge } = mockBridge({});
    bridge.status = (ws) => {
      if (ws === '/a') return Promise.resolve(ok({ files: [file('x', ' ', 'M'), file('y', '?', '?')] }));
      if (ws === '/b') return Promise.resolve(fail('not_a_repo'));
      if (ws === '/c') return Promise.resolve(ok({ files: [] }));
      return Promise.reject(new Error('boom'));
    };
    const counts = await fetchGitChangeCounts(bridge, ['/a', '/b', '/c', '/d']);
    expect(counts).toEqual({ '/a': 2 });
  });
});

// ---------------------------------------------------------------------------
// Store:加载与错误语义
// ---------------------------------------------------------------------------

describe('store 加载', () => {
  it('open → status → files + ok;分组计算正确', async () => {
    const { bridge } = mockBridge({
      status: () => ok({ files: [file('b.ts', ' ', 'M'), file('a.ts', 'M', ' ')] }),
    });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    expect(store.loadState.value).toBe('ok');
    expect(store.stagedFiles.value.map((f) => f.path)).toEqual(['a.ts']);
    expect(store.unstagedFiles.value.map((f) => f.path)).toEqual(['b.ts']);
  });

  it('not_a_repo → 独立空态', async () => {
    const { bridge } = mockBridge({ status: () => fail('not_a_repo') });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    expect(store.loadState.value).toBe('not_a_repo');
  });

  it('git_failed → failed + 错误摘要;bridge 抛异常同样降级', async () => {
    const { bridge } = mockBridge({ status: () => fail('git_failed', 'fatal: bad config') });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    expect(store.loadState.value).toBe('failed');
    expect(store.errorMessage.value).toBe('fatal: bad config');

    const throwing = mockBridge({});
    throwing.bridge.status = () => Promise.reject(new Error('ipc down'));
    const store2 = createGitPanelStore({ bridge: throwing.bridge });
    store2.open(WS);
    await flush();
    expect(store2.loadState.value).toBe('failed');
    expect(store2.errorMessage.value).toContain('ipc down');
  });
});

// ---------------------------------------------------------------------------
// Store:stage / unstage / 选中
// ---------------------------------------------------------------------------

describe('stage / unstage', () => {
  it('stage 成功 → 重拉 status;pending 标志随后清除', async () => {
    let files = [file('a.ts', ' ', 'M')];
    const { bridge, calls } = mockBridge({
      status: () => ok({ files }),
      stage: () => {
        files = [file('a.ts', 'M', ' ')];
        return ok(null);
      },
    });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    expect(store.unstagedFiles.value).toHaveLength(1);

    await store.stage(['a.ts']);
    expect(calls.stage).toEqual([['a.ts']]);
    expect(store.stagedFiles.value.map((f) => f.path)).toEqual(['a.ts']);
    expect(store.unstagedFiles.value).toHaveLength(0);
    expect(store.pendingPaths.value['a.ts']).toBeUndefined();
    expect(calls.status).toBe(2);
  });

  it('unstage → git reset 语义,同样重拉', async () => {
    const { bridge, calls } = mockBridge({
      status: () => ok({ files: [file('a.ts', 'M', ' ')] }),
    });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    await store.unstage(['a.ts']);
    expect(calls.unstage).toEqual([['a.ts']]);
  });

  it('stage 失败 → failed 错误条,列表保留', async () => {
    const { bridge } = mockBridge({
      status: () => ok({ files: [file('a.ts', ' ', 'M')] }),
      stage: () => fail('git_failed', 'error: pathspec did not match'),
    });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    await store.stage(['a.ts']);
    expect(store.loadState.value).toBe('failed');
    expect(store.errorMessage.value).toContain('pathspec');
    expect(store.files.value).toHaveLength(1);
  });
});

describe('选中与 diff', () => {
  it('点击选中 → 再点取消;fetchDiff 透传 staged 标志', async () => {
    const { bridge, calls } = mockBridge({
      status: () => ok({ files: [file('a.ts', 'M', 'M')] }),
      diff: () => ok({ diff: '@@ x', truncated: false }),
    });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();

    store.select('a.ts', true);
    expect(store.selected.value).toBe('S:a.ts');
    const d = await store.fetchDiff('a.ts', true);
    expect(d).toEqual({ diff: '@@ x', truncated: false });
    expect(calls.diff).toEqual([{ path: 'a.ts', staged: true }]);

    store.select('a.ts', true);
    expect(store.selected.value).toBeNull();
  });

  it('fetchDiff 桥失败 → null(组件降级,不影响列表)', async () => {
    const { bridge } = mockBridge({
      status: () => ok({ files: [file('a.ts', ' ', 'M')] }),
      diff: () => fail('git_failed'),
    });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    expect(await store.fetchDiff('a.ts', false)).toBeNull();
  });

  it('刷新后选中文件从对应组消失 → 自动取消选中', async () => {
    let files = [file('a.ts', ' ', 'M')];
    const { bridge } = mockBridge({
      status: () => ok({ files }),
      stage: () => {
        files = [file('a.ts', 'M', ' ')]; // U:a.ts 消失,出现 S:a.ts
        return ok(null);
      },
    });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    store.select('a.ts', false);
    expect(store.selected.value).toBe('U:a.ts');
    await store.stage(['a.ts']);
    expect(store.selected.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Store:commit
// ---------------------------------------------------------------------------

describe('commit', () => {
  it('无暂存文件 / 空 message → 不可提交,不调桥', async () => {
    const { bridge, calls } = mockBridge({
      status: () => ok({ files: [file('a.ts', ' ', 'M')] }),
    });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    expect(store.canCommit.value).toBe(false); // 无暂存
    store.message.value = 'x';
    expect(store.canCommit.value).toBe(false); // 仍无暂存
    await store.commit();
    expect(calls.commit).toHaveLength(0);
  });

  it('成功:trim 后传 message、记录 hash、清空输入、重拉 status', async () => {
    const { bridge, calls } = mockBridge({
      status: () => ok({ files: [file('a.ts', 'M', ' ')] }),
      commit: () => ok({ hash: 'abc123def456' }),
    });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    store.message.value = '  feat: x  ';
    expect(store.canCommit.value).toBe(true);
    await store.commit();
    expect(calls.commit).toEqual(['feat: x']);
    expect(store.committedHash.value).toBe('abc123def456');
    expect(store.message.value).toBe('');
    expect(store.commitError.value).toBeNull();
    expect(calls.status).toBe(2);
  });

  it('失败(merge 冲突等)→ commitError,message 保留可改后重试', async () => {
    const { bridge } = mockBridge({
      status: () => ok({ files: [file('a.ts', 'M', ' ')] }),
      commit: () => fail('git_failed', 'error: committing is not possible'),
    });
    const store = createGitPanelStore({ bridge });
    store.open(WS);
    await flush();
    store.message.value = 'x';
    await store.commit();
    expect(store.committedHash.value).toBeNull();
    expect(store.commitError.value).toContain('not possible');
    expect(store.message.value).toBe('x');
  });
});
