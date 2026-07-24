<!-- apps/kimi-web/src/components/codex/CapabilitiesPanel.vue -->
<!-- F12 Skills / MCP 管理中心(docs/08):CodexSidebar footer 入口打开的居中
     模态面板,三个分区 —— Skills(名称/来源 badge/描述)、MCP Servers(名称/
     transport/状态点/工具数/last_error,error|disconnected 行有"重连")、
     工具(按 source 分组,active=false 灰显)。取数与 WS 实时刷新全部在
     useCapabilities store 里;面板只读 + 唯一写操作 MCP 重连。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebClient } from '../../composables/useKimiWebClient';
import {
  canReconnect,
  createCapabilitiesStore,
  groupToolsBySource,
  mcpStatusToDot,
  type CapabilityMcpServer,
  type McpStatus,
} from './useCapabilities';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Badge from '../ui/Badge.vue';
import StatusDot from '../ui/StatusDot.vue';

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

const toolGroups = computed(() => groupToolsBySource(store.tools.value ?? []));

function statusLabel(status: McpStatus): string {
  return t(`capabilities.mcpStatus.${status}`);
}

function sourceLabel(source: string): string {
  const key = `capabilities.source.${source}`;
  const label = t(key);
  // 未知来源(未来新增)回退原始串
  return label === key ? source : label;
}

function onRestart(server: CapabilityMcpServer): void {
  void store.restart(server.id);
}
</script>

<template>
  <Dialog
    :open="true"
    :title="t('capabilities.title')"
    size="xl"
    height="fixed"
    :padded="false"
    @close="emit('close')"
  >
    <div class="codex-cap">
      <!-- Skills -->
      <section class="codex-cap-section">
        <div class="codex-cap-head">
          <h3 class="codex-cap-title">{{ t('capabilities.skills') }}</h3>
          <span v-if="store.skills.value" class="codex-cap-count">{{ store.skills.value.length }}</span>
        </div>

        <div v-if="store.skills.value === null" class="codex-cap-empty">
          {{ t('capabilities.loading') }}
        </div>
        <div v-else-if="store.skills.value.length === 0" class="codex-cap-empty">
          {{ t('capabilities.noSkills') }}
        </div>
        <template v-else>
          <div v-if="store.skillsFailed.value" class="codex-cap-warn">
            <span>{{ t('capabilities.loadFailed') }}</span>
            <Button variant="secondary" size="sm" @click="store.refresh()">
              {{ t('capabilities.retry') }}
            </Button>
          </div>
          <div v-for="s in store.skills.value" :key="s.name" class="codex-cap-row">
            <div class="codex-cap-row-main">
              <span class="codex-cap-name">{{ s.name }}</span>
              <Badge variant="neutral" size="sm">{{ s.source }}</Badge>
            </div>
            <div v-if="s.description" class="codex-cap-desc">{{ s.description }}</div>
          </div>
        </template>
      </section>

      <!-- MCP Servers -->
      <section class="codex-cap-section">
        <div class="codex-cap-head">
          <h3 class="codex-cap-title">{{ t('capabilities.mcpServers') }}</h3>
          <span v-if="store.servers.value" class="codex-cap-count">{{ store.servers.value.length }}</span>
        </div>

        <div v-if="!store.hasLiveSession.value" class="codex-cap-empty">
          {{ t('capabilities.noLiveSession') }}
        </div>
        <div v-else-if="store.servers.value === null" class="codex-cap-empty">
          {{ t('capabilities.loading') }}
        </div>
        <div v-else-if="store.servers.value.length === 0" class="codex-cap-empty">
          {{ t('capabilities.noMcp') }}
        </div>
        <template v-else>
          <div v-if="store.serversFailed.value" class="codex-cap-warn">
            <span>{{ t('capabilities.loadFailed') }}</span>
            <Button variant="secondary" size="sm" @click="store.refresh()">
              {{ t('capabilities.retry') }}
            </Button>
          </div>
          <div v-for="s in store.servers.value" :key="s.id" class="codex-cap-row">
            <div class="codex-cap-row-main">
              <StatusDot :status="mcpStatusToDot(s.status)" />
              <span class="codex-cap-name">{{ s.name }}</span>
              <Badge variant="neutral" size="sm">{{ s.transport }}</Badge>
              <span class="codex-cap-status">{{ statusLabel(s.status) }}</span>
              <span class="codex-cap-tools">
                {{ t('capabilities.toolCount', { count: s.toolCount }) }}
              </span>
              <Button
                v-if="canReconnect(s.status)"
                variant="secondary"
                size="sm"
                :loading="store.restarting.value[s.id] === 'loading'"
                :disabled="store.restarting.value[s.id] === 'loading'"
                @click="onRestart(s)"
              >
                {{ t('capabilities.reconnect') }}
              </Button>
            </div>
            <div v-if="s.lastError" class="codex-cap-error">{{ s.lastError }}</div>
            <div v-if="store.restarting.value[s.id] === 'not-found'" class="codex-cap-error">
              {{ t('capabilities.serverNotFound') }}
            </div>
            <div v-else-if="store.restarting.value[s.id] === 'failed'" class="codex-cap-error">
              {{ t('capabilities.restartFailed') }}
            </div>
          </div>
        </template>
      </section>

      <!-- 工具 -->
      <section class="codex-cap-section">
        <div class="codex-cap-head">
          <h3 class="codex-cap-title">{{ t('capabilities.tools') }}</h3>
          <span v-if="store.tools.value" class="codex-cap-count">{{ store.tools.value.length }}</span>
        </div>

        <div v-if="!store.hasLiveSession.value" class="codex-cap-empty">
          {{ t('capabilities.noLiveSession') }}
        </div>
        <div v-else-if="store.tools.value === null" class="codex-cap-empty">
          {{ t('capabilities.loading') }}
        </div>
        <div v-else-if="store.tools.value.length === 0" class="codex-cap-empty">
          {{ t('capabilities.noTools') }}
        </div>
        <template v-else>
          <div v-if="store.toolsFailed.value" class="codex-cap-warn">
            <span>{{ t('capabilities.loadFailed') }}</span>
            <Button variant="secondary" size="sm" @click="store.refresh()">
              {{ t('capabilities.retry') }}
            </Button>
          </div>
          <div v-for="g in toolGroups" :key="g.source" class="codex-cap-group">
            <div class="codex-cap-group-title">{{ sourceLabel(g.source) }}</div>
            <div
              v-for="tool in g.tools"
              :key="tool.name"
              class="codex-cap-row codex-cap-tool"
              :class="{ 'codex-cap-tool-off': !tool.active }"
            >
              <div class="codex-cap-row-main">
                <span class="codex-cap-name">{{ tool.name }}</span>
                <Badge v-if="!tool.active" variant="neutral" size="sm">
                  {{ t('capabilities.disabled') }}
                </Badge>
              </div>
              <div v-if="tool.description" class="codex-cap-desc">{{ tool.description }}</div>
            </div>
          </div>
        </template>
      </section>
    </div>
  </Dialog>
</template>

<style scoped>
.codex-cap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--space-5) var(--space-5);
  font-family: var(--font-ui);
}
.codex-cap-section {
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--color-line);
}
.codex-cap-section:last-child {
  border-bottom: none;
}
.codex-cap-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.codex-cap-title {
  margin: 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.codex-cap-count {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
}
.codex-cap-empty {
  padding: var(--space-4);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xl);
  background: var(--color-bg);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  text-align: center;
}
.codex-cap-warn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-warning);
}
.codex-cap-row {
  padding: var(--space-2) 0;
}
.codex-cap-row + .codex-cap-row {
  border-top: 1px solid var(--color-line);
}
.codex-cap-row-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.codex-cap-name {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-cap-status {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.codex-cap-tools {
  flex: 1;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.codex-cap-desc {
  margin-top: 2px;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-faint);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.codex-cap-error {
  margin-top: 2px;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-danger);
  overflow-wrap: anywhere;
}
.codex-cap-group-title {
  margin: var(--space-2) 0 var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  user-select: none;
}
.codex-cap-tool-off .codex-cap-name,
.codex-cap-tool-off .codex-cap-desc {
  color: var(--color-text-faint);
}
</style>
