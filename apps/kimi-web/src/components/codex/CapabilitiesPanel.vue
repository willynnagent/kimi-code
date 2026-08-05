<!-- apps/kimi-web/src/components/codex/CapabilitiesPanel.vue -->
<!-- F12 Skills / MCP 管理中心(docs/08),2026-08 Codex 风格重做:两页共用骨架
     (tab 技能|MCP + 大标题/副标题 + 全宽搜索 + 分节 + 两列卡片网格)。
     数据源、加载、只读语义与 MCP 重连全部在 useCapabilities store 里(不动);
     本组件只做展示层:搜索过滤、scope pills、卡片渲染、重连按钮状态机。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebClient } from '../../composables/useKimiWebClient';
import {
  canReconnect,
  createCapabilitiesStore,
  mcpStatusToDot,
  type CapabilityMcpServer,
  type CapabilitySkill,
  type McpStatus,
} from './useCapabilities';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';

const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();
const client = useKimiWebClient();

const store = createCapabilitiesStore();

onMounted(() => {
  store.open({
    workspaceId: client.activeWorkspaceId.value,
    sessionId: client.activeSessionId.value,
  });
});
onBeforeUnmount(() => store.close());

// ---------------------------------------------------------------------------
// 页内状态:tab / 搜索 / scope pill(全部纯展示,数据不动)
// ---------------------------------------------------------------------------

type CapTab = 'skills' | 'mcp';

const tab = ref<CapTab>('skills');
const query = ref('');

/** scope pills(参考图"个人|系统|推荐"):单选,默认个人。 */
const SCOPE_PILLS = ['user', 'project', 'builtin'] as const;
const scopePill = ref<string>('user');

const pageTitle = computed(() =>
  tab.value === 'skills' ? t('capabilities.skillsTitle') : t('capabilities.mcpTitle'),
);
const pageSubtitle = computed(() =>
  tab.value === 'skills' ? t('capabilities.skillsSubtitle') : t('capabilities.mcpSubtitle'),
);
const searchPlaceholder = computed(() =>
  tab.value === 'skills' ? t('capabilities.searchSkills') : t('capabilities.searchMcp'),
);

function scopeLabel(source: string): string {
  const key = `capabilities.scope.${source}`;
  const label = t(key);
  // 未知来源(未来新增)回退原始串
  return label === key ? source : label;
}

function statusLabel(status: McpStatus): string {
  return t(`capabilities.mcpStatus.${status}`);
}

// ---------------------------------------------------------------------------
// 过滤(实时)
// ---------------------------------------------------------------------------

const filteredSkills = computed<CapabilitySkill[]>(() => {
  const q = query.value.trim().toLowerCase();
  return (store.skills.value ?? []).filter(
    (s) =>
      s.source === scopePill.value &&
      (q.length === 0 ||
        s.name.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q)),
  );
});

const filteredServers = computed<CapabilityMcpServer[]>(() => {
  const q = query.value.trim().toLowerCase();
  return (store.servers.value ?? []).filter(
    (s) => q.length === 0 || s.name.toLowerCase().includes(q),
  );
});

// 各页的加载 / 失败 / 空态分派
const isLoading = computed(() =>
  tab.value === 'skills' ? store.skills.value === null : store.servers.value === null,
);
const loadFailed = computed(() =>
  tab.value === 'skills' ? store.skillsFailed.value : store.serversFailed.value,
);
const noLiveSession = computed(() => tab.value === 'mcp' && !store.hasLiveSession.value);
const visibleItems = computed(() =>
  tab.value === 'skills' ? filteredSkills.value : filteredServers.value,
);
const emptyText = computed(() => {
  if (query.value.trim().length > 0) return t('capabilities.noSearchResult');
  return tab.value === 'skills' ? t('capabilities.noSkills') : t('capabilities.noMcp');
});

// ---------------------------------------------------------------------------
// 动作(唯一写操作 = MCP 重连,行为不变)
// ---------------------------------------------------------------------------

function onRestart(server: CapabilityMcpServer): void {
  void store.restart(server.id);
}
</script>

<template>
  <Dialog
    :open="true"
    size="xl"
    height="fixed"
    :padded="false"
    @close="emit('close')"
  >
    <template #head>
      <div class="codex-cap-tabs" role="tablist" aria-label="capabilities">
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'skills'"
          :class="{ active: tab === 'skills' }"
          @click="tab = 'skills'"
        >
          {{ t('capabilities.tabSkills') }}
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'mcp'"
          :class="{ active: tab === 'mcp' }"
          @click="tab = 'mcp'"
        >
          {{ t('capabilities.tabMcp') }}
        </button>
      </div>
    </template>

    <div class="codex-cap">
      <h1 class="codex-cap-h1">{{ pageTitle }}</h1>
      <p class="codex-cap-sub">{{ pageSubtitle }}</p>

      <div class="codex-cap-search">
        <Icon name="search" size="sm" class="codex-cap-search-ic" />
        <input
          v-model="query"
          type="text"
          :placeholder="searchPlaceholder"
          spellcheck="false"
        />
      </div>

      <!-- 技能页 scope pills(单选,默认个人) -->
      <div v-if="tab === 'skills'" class="codex-cap-pills">
        <button
          v-for="scope in SCOPE_PILLS"
          :key="scope"
          type="button"
          :class="{ active: scopePill === scope }"
          @click="scopePill = scope"
        >
          {{ scopeLabel(scope) }}
        </button>
      </div>

      <section class="codex-cap-sec">
        <h2 class="codex-cap-sec-title">
          {{ tab === 'skills' ? t('capabilities.installed') : t('capabilities.serversTitle') }}
        </h2>
        <div class="codex-cap-rule" />

        <div v-if="noLiveSession" class="codex-cap-empty">
          {{ t('capabilities.noLiveSession') }}
        </div>
        <div v-else-if="isLoading" class="codex-cap-empty">
          {{ t('capabilities.loading') }}
        </div>
        <div v-else-if="loadFailed" class="codex-cap-warn">
          <span>{{ t('capabilities.loadFailed') }}</span>
          <Button variant="secondary" size="sm" @click="store.refresh()">
            {{ t('capabilities.retry') }}
          </Button>
        </div>
        <div v-else-if="visibleItems.length === 0" class="codex-cap-empty">
          {{ emptyText }}
        </div>

        <div v-else class="codex-cap-grid">
          <!-- 技能卡片:图标 + 名称/描述 + scope 徽章 -->
          <template v-if="tab === 'skills'">
            <div
              v-for="s in filteredSkills"
              :key="s.name"
              class="codex-cap-card"
            >
            <div class="codex-cap-main">
              <div class="codex-cap-ic" :class="`codex-cap-ic--${s.source}`">
                <Icon name="puzzle" size="lg" />
              </div>
              <div class="codex-cap-mid">
                <div class="codex-cap-name" :title="s.name">{{ s.name }}</div>
                <div class="codex-cap-desc" :title="s.description || ''">
                  {{ s.description || '—' }}
                </div>
              </div>
              <div class="codex-cap-side">
                <span class="codex-cap-scope">{{ scopeLabel(s.source) }}</span>
              </div>
            </div>
          </div>
          </template>

          <!-- MCP 卡片:图标 + 名称/状态/工具数 + 重连按钮或状态点;错误行独立在下方 -->
          <template v-else>
            <div
              v-for="s in filteredServers"
              :key="s.id"
              class="codex-cap-card"
            >
            <div class="codex-cap-main">
              <div class="codex-cap-ic" :class="['codex-cap-ic--mcp', { 'is-bad': s.status === 'error' }]">
                <Icon name="server" size="lg" />
              </div>
              <div class="codex-cap-mid">
                <div class="codex-cap-name" :title="s.name">{{ s.name }}</div>
                <div class="codex-cap-desc">
                  {{ statusLabel(s.status) }}<template v-if="s.toolCount > 0">
                    · {{ t('capabilities.toolCount', { count: s.toolCount }) }}
                  </template>
                </div>
              </div>
              <div class="codex-cap-side">
                <button
                  v-if="canReconnect(s.status)"
                  type="button"
                  class="codex-cap-reconnect"
                  :disabled="store.restarting.value[s.id] === 'loading'"
                  @click="onRestart(s)"
                >
                  {{
                    store.restarting.value[s.id] === 'loading'
                      ? t('capabilities.mcpStatus.connecting')
                      : t('capabilities.reconnect')
                  }}
                </button>
                <span v-else class="codex-cap-dot" :class="`codex-cap-dot--${mcpStatusToDot(s.status)}`" />
              </div>
            </div>
            <div class="codex-cap-errs">
              <div v-if="s.lastError" class="codex-cap-error" :title="s.lastError">{{ s.lastError }}</div>
              <div v-if="store.restarting.value[s.id] === 'not-found'" class="codex-cap-error">
                {{ t('capabilities.serverNotFound') }}
              </div>
              <div v-else-if="store.restarting.value[s.id] === 'failed'" class="codex-cap-error">
                {{ t('capabilities.restartFailed') }}
              </div>
            </div>
          </div>
          </template>
        </div>
      </section>
    </div>
  </Dialog>
</template>

<style scoped>
/* F12 Codex 风格重做:两页共用骨架。全部颜色走设计 token(亮/暗自动适配);
   大标题 28px 无对应 token(设计系统 sec-title 26px 同为先例),此处按参考图
   字面值。 */
.codex-cap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--space-6) var(--space-6);
  font-family: var(--font-ui);
}

/* ── tab(左上角,选中浅灰药丸) ── */
.codex-cap-tabs {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 3px;
  background: var(--color-surface-sunken);
  border-radius: var(--radius-full);
}
.codex-cap-tabs button {
  appearance: none;
  border: none;
  background: none;
  font: inherit;
  font-size: var(--text-sm);
  line-height: 1;
  color: var(--color-text-muted);
  padding: 6px 14px;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;
}
.codex-cap-tabs button:hover {
  color: var(--color-text);
}
.codex-cap-tabs button.active {
  background: var(--color-hover);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}

/* ── 大标题 + 副标题 ── */
.codex-cap-h1 {
  margin: var(--space-4) 0 0;
  font-size: 28px;
  font-weight: var(--weight-semibold);
  letter-spacing: -0.02em;
  line-height: 1.2;
  color: var(--color-text);
}
.codex-cap-sub {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}

/* ── 全宽胶囊搜索框 ── */
.codex-cap-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding: 0 var(--space-3);
  height: 38px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-bg);
  transition: border-color 0.12s;
}
.codex-cap-search:focus-within {
  border-color: var(--color-accent);
}
.codex-cap-search-ic {
  color: var(--color-text-faint);
  flex: none;
}
.codex-cap-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  font: inherit;
  font-size: var(--text-base);
  color: var(--color-text);
}
.codex-cap-search input::placeholder {
  color: var(--color-text-faint);
}

/* ── scope pills(技能页) ── */
.codex-cap-pills {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.codex-cap-pills button {
  appearance: none;
  border: 1px solid var(--color-line);
  background: none;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  padding: 5px 14px;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: background-color 0.12s, border-color 0.12s, color 0.12s;
}
.codex-cap-pills button:hover {
  color: var(--color-text);
  border-color: var(--color-line-strong);
}
.codex-cap-pills button.active {
  background: var(--color-hover);
  border-color: var(--color-line-strong);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}

/* ── 分节:标题 + 1px 分隔线 ── */
.codex-cap-sec {
  margin-top: var(--space-5);
}
.codex-cap-sec-title {
  margin: 0 0 var(--space-2);
  font-size: 15px;
  font-weight: var(--weight-semibold);
  color: var(--color-text);
}
.codex-cap-rule {
  height: 1px;
  background: var(--color-line);
  margin-bottom: var(--space-4);
}

/* ── 两列卡片网格(无边框无底色,靠留白分隔) ── */
.codex-cap-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2) var(--space-5);
}
.codex-cap-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 64px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  transition: background-color 0.12s;
}
.codex-cap-card:hover {
  background: var(--color-hover);
}
/* 主行:图标 + 中列 + 右 affordance(名称/状态任何状态都渲染,按钮固定在右缘) */
.codex-cap-main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
/* 错误区:对齐中列(48px 图标 + gap),独立于主行,不挤占名称列 */
.codex-cap-errs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--space-1);
  margin-left: 60px; /* 48px icon + var(--space-3) */
  min-width: 0;
}

/* 48px 圆角方形图标:浅色底 + 彩色 glyph(按 scope / 状态着色) */
.codex-cap-ic {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-md);
}
.codex-cap-ic--user {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.codex-cap-ic--project {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.codex-cap-ic--builtin {
  background: var(--color-info-soft, var(--color-surface-sunken));
  color: var(--color-info);
}
.codex-cap-ic--mcp {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.codex-cap-ic--mcp.is-bad {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

/* 中列:名称(单行截断) + 描述(单行截断) */
.codex-cap-mid {
  flex: 1;
  min-width: 0;
}
.codex-cap-name {
  font-size: 15px;
  font-weight: var(--weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-cap-desc {
  margin-top: 2px;
  font-size: var(--text-sm);
  line-height: 1.3;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 右列 affordance */
.codex-cap-side {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.codex-cap-scope {
  font-size: var(--text-sm);
  color: var(--color-text-faint);
  white-space: nowrap;
}
.codex-cap-reconnect {
  appearance: none;
  border: 1px solid var(--color-line);
  background: var(--color-surface-sunken);
  font: inherit;
  font-size: var(--text-sm);
  color: var(--color-text);
  padding: 5px 12px;
  border-radius: var(--radius-full);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.12s, border-color 0.12s;
}
.codex-cap-reconnect:hover:not(:disabled) {
  background: var(--color-hover);
  border-color: var(--color-line-strong);
}
.codex-cap-reconnect:disabled {
  opacity: 0.6;
  cursor: default;
}
.codex-cap-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-text-faint);
}
.codex-cap-dot--ok {
  background: var(--color-success);
}
.codex-cap-dot--running {
  background: var(--color-warning);
}
.codex-cap-dot--error {
  background: var(--color-danger);
}
.codex-cap-dot--idle {
  background: var(--color-text-faint);
}

/* 状态行:加载 / 空态 / 失败 / 错误 */
.codex-cap-empty {
  padding: var(--space-6) 0;
  text-align: center;
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}
.codex-cap-warn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-warning);
}
.codex-cap-error {
  font-size: var(--text-sm);
  line-height: 1.3;
  color: var(--color-danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
