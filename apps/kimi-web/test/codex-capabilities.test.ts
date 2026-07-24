import { describe, expect, it } from 'vitest';

import {
  canReconnect,
  createCapabilitiesStore,
  groupToolsBySource,
  isMcpServerNotFound,
  mapEventMcpStatus,
  mcpStatusToDot,
  mergeMcpServerEvent,
  MCP_SERVER_NOT_FOUND_CODE,
  type CapabilitiesDeps,
  type CapabilitiesEventHandler,
  type CapabilitiesRest,
  type CapabilitiesSocket,
  type CapabilityMcpServer,
  type CapabilityTool,
} from '../src/components/codex/useCapabilities';

// F12 Skills / MCP 管理中心(docs/08)的纯逻辑测试。
// 本包 vitest 运行在 node 环境(无 jsdom / 组件挂载,见 apps/kimi-web/AGENTS.md),
// 因此分区渲染、空态与重连按钮状态机都通过 store 状态 + 纯函数覆盖。

// ---------------------------------------------------------------------------
// Mock 基础设施
// ---------------------------------------------------------------------------

type RestHandler = (
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
) => Promise<unknown>;

function mockRest(routes: { get?: RestHandler; post?: RestHandler }): {
  rest: CapabilitiesRest;
  calls: { method: string; path: string; query?: unknown }[];
} {
  const calls: { method: string; path: string; query?: unknown }[] = [];
  return {
    calls,
    rest: {
      get: <T>(path: string, query?: Record<string, string | number | boolean | undefined>) => {
        calls.push({ method: 'GET', path, query });
        return (routes.get?.(path, query) ?? Promise.reject(new Error('no route'))) as Promise<T>;
      },
      post: <T>(path: string) => {
        calls.push({ method: 'POST', path });
        return (routes.post?.(path) ?? Promise.reject(new Error('no route'))) as Promise<T>;
      },
    },
  };
}

function mockSocket(): {
  socket: CapabilitiesSocket;
  connected: () => boolean;
  subscribed: () => string[];
  closed: () => boolean;
} {
  let connected = false;
  let closed = false;
  const subscribed: string[] = [];
  return {
    connected: () => connected,
    subscribed: () => subscribed,
    closed: () => closed,
    socket: {
      connect: () => {
        connected = true;
      },
      subscribe: (sid: string) => {
        subscribed.push(sid);
      },
      close: () => {
        closed = true;
      },
    },
  };
}

function makeStore(routes: Parameters<typeof mockRest>[0]): {
  store: ReturnType<typeof createCapabilitiesStore>;
  calls: { method: string; path: string; query?: unknown }[];
  emit: CapabilitiesEventHandler;
  sock: ReturnType<typeof mockSocket>;
} {
  const { rest, calls } = mockRest(routes);
  const sock = mockSocket();
  let handler: CapabilitiesEventHandler = () => {};
  const deps: CapabilitiesDeps = {
    rest,
    socketFactory: (onEvent) => {
      handler = onEvent;
      return sock.socket;
    },
  };
  return { store: createCapabilitiesStore(deps), calls, emit: (t, p) => handler(t, p), sock };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('mapEventMcpStatus(WS 状态词表 → REST 词表)', () => {
  it('五种事件状态映射', () => {
    expect(mapEventMcpStatus('connected')).toBe('connected');
    expect(mapEventMcpStatus('pending')).toBe('connecting');
    expect(mapEventMcpStatus('disabled')).toBe('disconnected');
    expect(mapEventMcpStatus('failed')).toBe('error');
    expect(mapEventMcpStatus('needs-auth')).toBe('error');
  });

  it('未知状态 → disconnected(保守)', () => {
    expect(mapEventMcpStatus('')).toBe('disconnected');
    expect(mapEventMcpStatus('whatever')).toBe('disconnected');
  });
});

describe('mergeMcpServerEvent(WS 增量合并)', () => {
  const base: CapabilityMcpServer[] = [
    { id: 'fs', name: 'fs', transport: 'stdio', status: 'error', toolCount: 3, lastError: 'boom' },
    { id: 'web', name: 'web', transport: 'http', status: 'connected', toolCount: 5, lastError: null },
  ];

  it('按 name 命中 → 原地更新,顺序不变', () => {
    const next = mergeMcpServerEvent(base, {
      server: { name: 'fs', transport: 'stdio', status: 'connected', toolCount: 4 },
    });
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: 'fs', status: 'connected', toolCount: 4, lastError: null });
    expect(next[1]).toMatchObject({ id: 'web', status: 'connected' });
    // 原数组不被修改
    expect(base[0]!.status).toBe('error');
  });

  it('未命中 → 追加新 server', () => {
    const next = mergeMcpServerEvent(base, {
      server: { name: 'db', transport: 'sse', status: 'pending', toolCount: 0, error: 'x' },
    });
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({
      id: 'db',
      transport: 'sse',
      status: 'connecting',
      toolCount: 0,
      lastError: 'x',
    });
  });

  it('payload 畸形 → 原样返回', () => {
    expect(mergeMcpServerEvent(base, null)).toBe(base);
    expect(mergeMcpServerEvent(base, {})).toBe(base);
    expect(mergeMcpServerEvent(base, { server: { status: 'connected' } })).toBe(base);
  });

  it('事件缺 toolCount / transport → 保留旧值', () => {
    const next = mergeMcpServerEvent(base, { server: { name: 'fs', status: 'disabled' } });
    expect(next[0]).toMatchObject({ status: 'disconnected', toolCount: 3, transport: 'stdio' });
  });
});

describe('groupToolsBySource(工具分区)', () => {
  it('固定 builtin → skill → mcp 顺序', () => {
    const tools: CapabilityTool[] = [
      { name: 'm1', description: '', source: 'mcp', active: true },
      { name: 's1', description: '', source: 'skill', active: true },
      { name: 'b1', description: '', source: 'builtin', active: true },
      { name: 'b2', description: '', source: 'builtin', active: false },
    ];
    const groups = groupToolsBySource(tools);
    expect(groups.map((g) => g.source)).toEqual(['builtin', 'skill', 'mcp']);
    expect(groups[0]!.tools.map((t) => t.name)).toEqual(['b1', 'b2']);
  });

  it('未知来源排最后;空数组 → 空分组', () => {
    const groups = groupToolsBySource([
      { name: 'x', description: '', source: 'plugin', active: true },
      { name: 'b', description: '', source: 'builtin', active: true },
    ]);
    expect(groups.map((g) => g.source)).toEqual(['builtin', 'plugin']);
    expect(groupToolsBySource([])).toEqual([]);
  });
});

describe('重连按钮显隐与错误判定', () => {
  it('error / disconnected 才显示重连', () => {
    expect(canReconnect('error')).toBe(true);
    expect(canReconnect('disconnected')).toBe(true);
    expect(canReconnect('connected')).toBe(false);
    expect(canReconnect('connecting')).toBe(false);
  });

  it('40408 → server 不存在', () => {
    expect(isMcpServerNotFound({ code: MCP_SERVER_NOT_FOUND_CODE })).toBe(true);
    expect(isMcpServerNotFound({ code: 40001 })).toBe(false);
    expect(isMcpServerNotFound(new Error('network'))).toBe(false);
    expect(isMcpServerNotFound(null)).toBe(false);
  });

  it('StatusDot 词表适配', () => {
    expect(mcpStatusToDot('connected')).toBe('ok');
    expect(mcpStatusToDot('connecting')).toBe('running');
    expect(mcpStatusToDot('error')).toBe('error');
    expect(mcpStatusToDot('disconnected')).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Store:取数 / live session 约束 / WS 刷新 / 重连状态机
// ---------------------------------------------------------------------------

describe('store.open(三分区取数)', () => {
  const skillsData = {
    skills: [
      { name: 'code-review', description: 'review', source: 'user' },
      { name: 'check-kimi-code-docs', description: 'docs', source: 'builtin', type: 'inline' },
    ],
  };
  const serversData = {
    servers: [
      { id: 'fs', name: 'fs', transport: 'stdio', status: 'error', tool_count: 3, last_error: 'boom' },
    ],
  };
  const toolsData = {
    tools: [
      { name: 'Read', description: 'read', source: 'builtin', active: true },
      { name: 'select_tools', description: 'load', source: 'builtin', active: false },
    ],
  };

  function routes() {
    return {
      get: (path: string) => {
        if (path.startsWith('/workspaces/')) return Promise.resolve(skillsData);
        if (path === '/mcp/servers') return Promise.resolve(serversData);
        if (path === '/tools') return Promise.resolve(toolsData);
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    };
  }

  it('有 live session:三个端点都拉,WS 订阅当前会话', async () => {
    const { store, calls, sock } = makeStore(routes());
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();

    expect(calls.map((c) => c.path)).toEqual([
      '/workspaces/wd_1/skills',
      '/mcp/servers',
      '/tools',
    ]);
    expect(calls[2]!.query).toEqual({ session_id: 'session_1' });
    expect(sock.connected()).toBe(true);
    expect(sock.subscribed()).toEqual(['session_1']);

    expect(store.hasLiveSession.value).toBe(true);
    expect(store.skills.value).toHaveLength(2);
    expect(store.skills.value![0]).toMatchObject({ name: 'code-review', source: 'user', type: null });
    expect(store.skills.value![1]).toMatchObject({ type: 'inline' });
    expect(store.servers.value![0]).toMatchObject({
      id: 'fs',
      status: 'error',
      toolCount: 3,
      lastError: 'boom',
    });
    expect(store.tools.value![1]).toMatchObject({ name: 'select_tools', active: false });
  });

  it('无 live session:MCP/工具不取数、不连 WS,Skills 不受影响', async () => {
    const { store, calls, sock } = makeStore(routes());
    store.open({ workspaceId: 'wd_1', sessionId: null });
    await flush();

    expect(calls.map((c) => c.path)).toEqual(['/workspaces/wd_1/skills']);
    expect(sock.connected()).toBe(false);
    expect(store.hasLiveSession.value).toBe(false);
    expect(store.servers.value).toBeNull();
    expect(store.tools.value).toBeNull();
    expect(store.skills.value).toHaveLength(2);
  });

  it('sessionId 为 undefined(rawState 未归一)同样按无 live session 处理', async () => {
    const { store, calls, sock } = makeStore(routes());
    store.open({ workspaceId: 'wd_1', sessionId: undefined as unknown as null });
    await flush();

    expect(calls.map((c) => c.path)).toEqual(['/workspaces/wd_1/skills']);
    expect(sock.connected()).toBe(false);
    expect(store.hasLiveSession.value).toBe(false);
    expect(store.tools.value).toBeNull();
  });

  it('无 workspace:Skills 空态', async () => {
    const { store, calls } = makeStore(routes());
    store.open({ workspaceId: null, sessionId: 'session_1' });
    await flush();
    expect(calls.some((c) => c.path.startsWith('/workspaces/'))).toBe(false);
    expect(store.skills.value).toEqual([]);
  });

  it('取数失败 → failed 标记;refresh 重试成功 → 数据恢复', async () => {
    let fail = true;
    const { store } = makeStore({
      get: (path) => {
        if (path.startsWith('/workspaces/')) {
          return fail ? Promise.reject(new Error('down')) : Promise.resolve(skillsData);
        }
        if (path === '/mcp/servers') return Promise.resolve(serversData);
        return Promise.resolve(toolsData);
      },
    });
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();
    expect(store.skillsFailed.value).toBe(true);
    expect(store.skills.value).toBeNull();

    fail = false;
    store.refresh();
    await flush();
    expect(store.skillsFailed.value).toBe(false);
    expect(store.skills.value).toHaveLength(2);
  });

  it('close() 关闭 socket', async () => {
    const { store, sock } = makeStore(routes());
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();
    store.close();
    expect(sock.closed()).toBe(true);
  });
});

describe('store WS 实时刷新', () => {
  function liveRoutes() {
    return {
      get: (path: string) => {
        if (path.startsWith('/workspaces/')) return Promise.resolve({ skills: [] });
        if (path === '/mcp/servers') {
          return Promise.resolve({
            servers: [
              { id: 'fs', name: 'fs', transport: 'stdio', status: 'connecting', tool_count: 0 },
            ],
          });
        }
        return Promise.resolve({ tools: [] });
      },
    };
  }

  it('mcp.server.status → 增量合并', async () => {
    const { store, emit } = makeStore(liveRoutes());
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();
    expect(store.servers.value![0]!.status).toBe('connecting');

    emit('mcp.server.status', {
      server: { name: 'fs', transport: 'stdio', status: 'connected', toolCount: 7 },
    });
    expect(store.servers.value![0]).toMatchObject({ status: 'connected', toolCount: 7 });
  });

  it('servers 尚未加载时收到 mcp.server.status → 触发全量拉取', async () => {
    const { store, emit, calls } = makeStore({
      get: (path) => {
        if (path === '/mcp/servers') return new Promise(() => {}); // 永不返回
        if (path.startsWith('/workspaces/')) return Promise.resolve({ skills: [] });
        return Promise.resolve({ tools: [] });
      },
    });
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();
    expect(store.servers.value).toBeNull();
    const before = calls.filter((c) => c.path === '/mcp/servers').length;
    emit('mcp.server.status', { server: { name: 'fs', status: 'connected', toolCount: 1 } });
    await flush();
    expect(calls.filter((c) => c.path === '/mcp/servers').length).toBe(before + 1);
  });

  it('tool.list.updated → 重拉工具与 servers', async () => {
    const { store, emit, calls } = makeStore(liveRoutes());
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();
    const toolsBefore = calls.filter((c) => c.path === '/tools').length;
    const serversBefore = calls.filter((c) => c.path === '/mcp/servers').length;

    emit('tool.list.updated', { reason: 'mcp.connected', serverName: 'fs' });
    await flush();
    expect(calls.filter((c) => c.path === '/tools').length).toBe(toolsBefore + 1);
    expect(calls.filter((c) => c.path === '/mcp/servers').length).toBe(serversBefore + 1);
  });

  it('无关事件类型被 socket 层过滤(store handler 不感知)', async () => {
    const { store, emit } = makeStore(liveRoutes());
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();
    emit('assistant.delta', { delta: 'x' });
    expect(store.servers.value![0]!.status).toBe('connecting');
  });
});

describe('store.restart(重连状态机)', () => {
  function restartRoutes(post: () => Promise<unknown>) {
    return {
      get: (path: string) => {
        if (path.startsWith('/workspaces/')) return Promise.resolve({ skills: [] });
        if (path === '/mcp/servers') {
          return Promise.resolve({
            servers: [
              { id: 'fs', name: 'fs', transport: 'stdio', status: 'error', tool_count: 0, last_error: 'x' },
            ],
          });
        }
        return Promise.resolve({ tools: [] });
      },
      post,
    };
  }

  it('成功:idle → loading → idle,并调用 :restart 端点 + 重拉 servers', async () => {
    const { store, calls } = makeStore(restartRoutes(() => Promise.resolve({ restarting: true })));
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();
    const serversBefore = calls.filter((c) => c.path === '/mcp/servers').length;

    const p = store.restart('fs');
    expect(store.restarting.value['fs']).toBe('loading');
    await p;
    expect(store.restarting.value['fs']).toBeUndefined();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/mcp/servers/fs:restart')).toBe(true);
    await flush();
    expect(calls.filter((c) => c.path === '/mcp/servers').length).toBe(serversBefore + 1);
  });

  it('40408 → not-found("server 不存在")', async () => {
    const { store } = makeStore(
      restartRoutes(() => Promise.reject({ code: MCP_SERVER_NOT_FOUND_CODE, msg: 'not found' })),
    );
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();
    await store.restart('ghost');
    expect(store.restarting.value['ghost']).toBe('not-found');
  });

  it('其他错误 → failed', async () => {
    const { store } = makeStore(restartRoutes(() => Promise.reject(new Error('network'))));
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();
    await store.restart('fs');
    expect(store.restarting.value['fs']).toBe('failed');
  });

  it('loading 中重复点击 → 不重复发请求', async () => {
    let resolvePost: (v: unknown) => void = () => {};
    const { store, calls } = makeStore(
      restartRoutes(() => new Promise((r) => { resolvePost = r; })),
    );
    store.open({ workspaceId: 'wd_1', sessionId: 'session_1' });
    await flush();

    const p1 = store.restart('fs');
    const p2 = store.restart('fs');
    resolvePost({ restarting: true });
    await Promise.all([p1, p2]);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
  });
});
