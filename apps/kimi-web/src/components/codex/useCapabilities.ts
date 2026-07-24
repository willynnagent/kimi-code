// apps/kimi-web/src/components/codex/useCapabilities.ts
// F12 Skills / MCP 管理中心的取数与状态逻辑(docs/08)。
//
// 数据源全部是 daemon 官方 REST + WS,经现有同 origin 通道,不改任何上游文件:
//   - Skills:GET /workspaces/{wid}/skills(首选,无副作用)
//   - MCP:GET /mcp/servers(无 session_id,daemon 侧 live session fallback)
//   - 工具:GET /tools?session_id=<live sid>
//   - 实时:WS mcp.server.status / tool.list.updated。门面 projector 显式忽略
//     这两个事件(agentEventProjector.ts),且 KimiEventHandlers 没有原始事件
//     钩子——因此面板打开期间自起一条轻量 DaemonEventSocket(派生 clientId,
//     只订阅当前 live 会话),事件在 store 内自行消费,不动 projector。
//   - 重连:POST /mcp/servers/{id}:restart(唯一写操作;未知 server 40408)。
//
// 测试友好:REST 与 socket 工厂均可注入(见 codex-capabilities.test.ts);
// 纯函数(mapEventMcpStatus / mergeMcpServerEvent / groupToolsBySource)单独导出。

import { ref, type Ref } from 'vue';

import { buildWsUrl, readKimiApiConfig } from '../../api/config';
import { DaemonHttpClient } from '../../api/daemon/http';
import { DaemonEventSocket } from '../../api/daemon/ws';

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

export interface CapabilitySkill {
  name: string;
  description: string;
  source: string;
  /** wire `type`(如 builtin 的 inline);非 builtin 项常缺省。 */
  type: string | null;
}

export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface CapabilityMcpServer {
  id: string;
  name: string;
  transport: McpTransport;
  status: McpStatus;
  toolCount: number;
  lastError: string | null;
}

export interface CapabilityTool {
  name: string;
  description: string;
  /** wire 上是 'builtin' | 'skill' | 'mcp';对未来新增来源保持宽容(string)。 */
  source: string;
  active: boolean;
}

export interface ToolGroup {
  source: string;
  tools: CapabilityTool[];
}

/** 重连按钮状态机:无键 = idle。 */
export type RestartState = 'loading' | 'not-found' | 'failed';

// ---------------------------------------------------------------------------
// Wire 形状(P3 实测校准,2026-07-23;对照 kap-server src/protocol/tool.ts)
// ---------------------------------------------------------------------------

interface WireSkillDescriptor {
  name: string;
  description: string;
  source: string;
  type?: string;
}

interface WireMcpServer {
  id: string;
  name: string;
  transport: McpTransport;
  status: McpStatus;
  tool_count: number;
  last_error?: string;
}

interface WireToolDescriptor {
  name: string;
  description: string;
  source: string;
  active?: boolean;
}

/** WS mcp.server.status 的 payload(kap-server events-zod.ts,字段为 camelCase)。 */
export interface McpServerStatusEventPayload {
  server?: {
    name?: unknown;
    transport?: unknown;
    status?: unknown;
    toolCount?: unknown;
    error?: unknown;
  };
}

/** POST /mcp/servers/{id}:restart 对未知 server 返回的错误码。 */
export const MCP_SERVER_NOT_FOUND_CODE = 40408;

// ---------------------------------------------------------------------------
// 纯函数(单测直接覆盖)
// ---------------------------------------------------------------------------

/** WS 事件的 server 状态词表 → REST 词表(与 kap-server mapMcpStatus 一致)。 */
export function mapEventMcpStatus(status: string): McpStatus {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'pending':
      return 'connecting';
    case 'disabled':
      return 'disconnected';
    case 'failed':
    case 'needs-auth':
      return 'error';
    default:
      return 'disconnected';
  }
}

function normalizeTransport(raw: unknown): McpTransport {
  return raw === 'http' || raw === 'sse' ? raw : 'stdio';
}

/** 把一条 mcp.server.status 事件并入现有列表:按 name 命中则原地更新,
 *  否则追加;payload 畸形时原样返回。 */
export function mergeMcpServerEvent(
  servers: CapabilityMcpServer[],
  payload: unknown,
): CapabilityMcpServer[] {
  const s = (payload as McpServerStatusEventPayload | null)?.server;
  if (!s || typeof s.name !== 'string' || s.name.length === 0) return servers;
  const status = mapEventMcpStatus(typeof s.status === 'string' ? s.status : '');
  const toolCount = typeof s.toolCount === 'number' ? s.toolCount : undefined;
  const lastError = typeof s.error === 'string' && s.error.length > 0 ? s.error : null;
  const idx = servers.findIndex((x) => x.id === s.name || x.name === s.name);
  if (idx === -1) {
    return [
      ...servers,
      {
        id: s.name,
        name: s.name,
        transport: normalizeTransport(s.transport),
        status,
        toolCount: toolCount ?? 0,
        lastError,
      },
    ];
  }
  const next = servers.slice();
  const cur = next[idx]!;
  next[idx] = {
    ...cur,
    status,
    toolCount: toolCount ?? cur.toolCount,
    lastError,
    transport: s.transport !== undefined ? normalizeTransport(s.transport) : cur.transport,
  };
  return next;
}

const TOOL_SOURCE_ORDER = ['builtin', 'skill', 'mcp'];

/** 工具按 source 分组,固定 builtin → skill → mcp 顺序,未知来源排最后。 */
export function groupToolsBySource(tools: CapabilityTool[]): ToolGroup[] {
  const map = new Map<string, CapabilityTool[]>();
  for (const t of tools) {
    const list = map.get(t.source) ?? [];
    list.push(t);
    map.set(t.source, list);
  }
  const rank = (s: string): number => {
    const i = TOOL_SOURCE_ORDER.indexOf(s);
    return i === -1 ? TOOL_SOURCE_ORDER.length : i;
  };
  return Array.from(map.keys())
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((source) => ({ source, tools: map.get(source)! }));
}

/** DaemonApiError(或任何带 code 的错误)是否为 40408。 */
export function isMcpServerNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === MCP_SERVER_NOT_FOUND_CODE
  );
}

/** StatusDot 词表(ok/error/running/idle)适配。 */
export function mcpStatusToDot(status: McpStatus): string {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'connecting':
      return 'running';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/** error / disconnected 状态的 server 行显示"重连"按钮。 */
export function canReconnect(status: McpStatus): boolean {
  return status === 'error' || status === 'disconnected';
}

// ---------------------------------------------------------------------------
// 依赖注入面(测试用)
// ---------------------------------------------------------------------------

export interface CapabilitiesRest {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export interface CapabilitiesSocket {
  connect(): void;
  subscribe(sessionId: string): void;
  close(): void;
}

export type CapabilitiesEventHandler = (type: string, payload: unknown) => void;

export interface CapabilitiesDeps {
  rest?: CapabilitiesRest;
  socketFactory?: (onEvent: CapabilitiesEventHandler) => CapabilitiesSocket;
}

export interface CapabilitiesOpenOptions {
  /** 当前项目(Skills 分区的取数范围);null → Skills 空态。 */
  workspaceId: string | null;
  /** live 会话(MCP/工具分区的前提);null → 两个分区显示引导文案。 */
  sessionId: string | null;
}

export interface CapabilitiesStore {
  skills: Ref<CapabilitySkill[] | null>;
  skillsFailed: Ref<boolean>;
  servers: Ref<CapabilityMcpServer[] | null>;
  serversFailed: Ref<boolean>;
  tools: Ref<CapabilityTool[] | null>;
  toolsFailed: Ref<boolean>;
  restarting: Ref<Record<string, RestartState>>;
  hasLiveSession: Ref<boolean>;
  open(opts: CapabilitiesOpenOptions): void;
  close(): void;
  refresh(): void;
  restart(serverId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createCapabilitiesStore(deps: CapabilitiesDeps = {}): CapabilitiesStore {
  const skills = ref<CapabilitySkill[] | null>(null);
  const skillsFailed = ref(false);
  const servers = ref<CapabilityMcpServer[] | null>(null);
  const serversFailed = ref(false);
  const tools = ref<CapabilityTool[] | null>(null);
  const toolsFailed = ref(false);
  const restarting = ref<Record<string, RestartState>>({});
  const hasLiveSession = ref(false);

  let workspaceId: string | null = null;
  let sessionId: string | null = null;
  let socket: CapabilitiesSocket | null = null;
  let restCache: CapabilitiesRest | null = null;

  function rest(): CapabilitiesRest {
    if (deps.rest) return deps.rest;
    if (restCache) return restCache;
    const cfg = readKimiApiConfig();
    restCache = new DaemonHttpClient(cfg.serverHttpUrl, {
      clientId: cfg.clientId,
      clientName: cfg.clientName,
      clientVersion: cfg.clientVersion,
      clientUiMode: cfg.clientUiMode,
    });
    return restCache;
  }

  function defaultSocketFactory(onEvent: CapabilitiesEventHandler): CapabilitiesSocket {
    const cfg = readKimiApiConfig();
    // 派生 clientId:与主连接区分,避免 daemon 按 client 去重时互相挤掉。
    const clientId = `${cfg.clientId}:capabilities`;
    return new DaemonEventSocket(buildWsUrl(cfg.serverHttpUrl, clientId), clientId, {
      onWireEvent: () => {},
      onRawAgentEvent: (frame) => {
        if (frame.type === 'mcp.server.status' || frame.type === 'tool.list.updated') {
          onEvent(frame.type, frame.payload);
        }
      },
      onResync: () => {},
      onConnectionState: () => {},
      onError: () => {},
    });
  }

  async function loadSkills(): Promise<void> {
    if (workspaceId === null) {
      skills.value = [];
      return;
    }
    try {
      const data = await rest().get<{ skills?: WireSkillDescriptor[] }>(
        `/workspaces/${encodeURIComponent(workspaceId)}/skills`,
      );
      skills.value = (data.skills ?? []).map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
        type: s.type ?? null,
      }));
      skillsFailed.value = false;
    } catch {
      // 保留上一份数据,仅标记失败(重试按钮由面板提供)
      skillsFailed.value = true;
    }
  }

  async function loadServers(): Promise<void> {
    try {
      const data = await rest().get<{ servers?: WireMcpServer[] }>('/mcp/servers');
      servers.value = (data.servers ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        transport: s.transport,
        status: s.status,
        toolCount: s.tool_count,
        lastError: s.last_error ?? null,
      }));
      serversFailed.value = false;
    } catch {
      serversFailed.value = true;
    }
  }

  async function loadTools(): Promise<void> {
    if (sessionId === null) return;
    try {
      const data = await rest().get<{ tools?: WireToolDescriptor[] }>('/tools', {
        session_id: sessionId,
      });
      tools.value = (data.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        source: t.source,
        active: t.active !== false,
      }));
      toolsFailed.value = false;
    } catch {
      toolsFailed.value = true;
    }
  }

  function onSocketEvent(type: string, payload: unknown): void {
    if (type === 'mcp.server.status') {
      if (servers.value === null) void loadServers();
      else servers.value = mergeMcpServerEvent(servers.value, payload);
    } else if (type === 'tool.list.updated') {
      // 工具清单结构变化(MCP 连接/断开/失败)→ 全量重拉,顺带刷新 server 计数
      void loadTools();
      void loadServers();
    }
  }

  function open(opts: CapabilitiesOpenOptions): void {
    workspaceId = opts.workspaceId;
    // activeSessionId 直传 rawState,可能是 undefined;归一为 null 再判活
    sessionId = opts.sessionId ?? null;
    hasLiveSession.value = sessionId !== null;
    void loadSkills();
    if (sessionId !== null) {
      void loadServers();
      void loadTools();
      const factory = deps.socketFactory ?? defaultSocketFactory;
      socket = factory(onSocketEvent);
      socket.connect();
      // 默认 {seq:0} 游标:daemon 只回放有界 journal,缺口过大回 resync_required,
      // 面板只关心后续增量事件,两者都安全。
      socket.subscribe(sessionId);
    }
  }

  function close(): void {
    socket?.close();
    socket = null;
  }

  function refresh(): void {
    void loadSkills();
    if (sessionId !== null) {
      void loadServers();
      void loadTools();
    }
  }

  async function restart(serverId: string): Promise<void> {
    if (restarting.value[serverId] === 'loading') return;
    restarting.value = { ...restarting.value, [serverId]: 'loading' };
    try {
      await rest().post(`/mcp/servers/${encodeURIComponent(serverId)}:restart`, {});
      const next = { ...restarting.value };
      delete next[serverId];
      restarting.value = next;
      // 立即重拉拿到 connecting 状态;后续经 WS mcp.server.status 自然刷新
      void loadServers();
    } catch (err) {
      restarting.value = {
        ...restarting.value,
        [serverId]: isMcpServerNotFound(err) ? 'not-found' : 'failed',
      };
    }
  }

  return {
    skills,
    skillsFailed,
    servers,
    serversFailed,
    tools,
    toolsFailed,
    restarting,
    hasLiveSession,
    open,
    close,
    refresh,
    restart,
  };
}
