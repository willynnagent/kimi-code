<!-- apps/kimi-web/src/components/codex/TurnChangesFooter.vue -->
<!-- F9 按 turn 改动文件 + diff 预览(只读版,docs/09)。挂在 ChatPane turn
     尾部(.a-duration 旁):"改动 N 个文件"链接 → 就地展开文件列表(agent
     编辑 / 其他改动 badge)→ 点击文件看该文件当前相对 HEAD 的 diff(复用
     官方 DiffLines 渲染,文案标明"当前 diff")。非 git 工作区:仅列文件,
     diff 禁用并提示。归因与 git 状态全部在 useTurnChanges store。 -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, DiffViewLine } from '../../types';
import { parseDiff } from '../../lib/parseDiff';
import DiffLines from '../chat/DiffLines.vue';
import Badge from '../ui/Badge.vue';
import { getTurnChangesStore } from './useTurnChanges';

const props = defineProps<{
  turn: ChatTurn;
  sessionId: string;
}>();

const { t } = useI18n();
const store = getTurnChangesStore();

const files = computed(() => store.filesFor(props.sessionId, props.turn.tools));
const gitOk = computed(() => store.gitAvailable(props.sessionId));

const expanded = ref(false);
const selectedPath = ref<string | null>(null);
const diffLines = ref<DiffViewLine[]>([]);
const diffState = ref<'idle' | 'loading' | 'ok' | 'empty'>('idle');

function toggle(): void {
  expanded.value = !expanded.value;
  if (!expanded.value) {
    selectedPath.value = null;
    diffState.value = 'idle';
  }
}

async function openDiff(path: string): Promise<void> {
  if (!gitOk.value) return;
  // 再点同一行 = 收起 diff
  if (selectedPath.value === path) {
    selectedPath.value = null;
    diffState.value = 'idle';
    return;
  }
  selectedPath.value = path;
  diffLines.value = [];
  diffState.value = 'loading';
  try {
    const raw = await store.fetchDiff(props.sessionId, path);
    if (selectedPath.value !== path) return; // 已切换目标,丢弃迟到响应
    const lines = parseDiff(raw);
    diffLines.value = lines;
    // 新文件/二进制/已删除等 daemon 给不出 diff 的情况,与官方 ~/diff
    // 面板一致:空态提示,不当会话级错误。
    diffState.value = lines.length > 0 ? 'ok' : 'empty';
  } catch {
    if (selectedPath.value === path) {
      diffLines.value = [];
      diffState.value = 'empty';
    }
  }
}

/** 长路径保留尾部(文件名优先),与 DiffView 的 truncateLeft 同款。 */
function truncateLeft(p: string, max: number): string {
  return p.length <= max ? p : '…' + p.slice(-(max - 1));
}
</script>

<template>
  <span v-if="files.length > 0" class="codex-tc">
    <button
      type="button"
      class="codex-tc-link"
      :aria-expanded="expanded"
      @click="toggle"
    >
      {{ t('turnChanges.link', { count: files.length }) }}
    </button>
  </span>
  <div v-if="expanded && files.length > 0" class="codex-tc-panel">
    <div class="codex-tc-head">{{ t('turnChanges.title') }}</div>
    <div v-if="!gitOk" class="codex-tc-hint">{{ t('turnChanges.nonGit') }}</div>
    <div
      v-for="f in files"
      :key="f.path"
      class="codex-tc-row"
      :class="{ 'is-active': selectedPath === f.path }"
    >
      <button
        type="button"
        class="codex-tc-file"
        :disabled="!gitOk"
        :title="f.path"
        @click="openDiff(f.path)"
      >
        <span class="codex-tc-path">{{ truncateLeft(f.path, 64) }}</span>
      </button>
      <Badge :variant="f.source === 'agent' ? 'info' : 'neutral'" size="sm">
        {{ f.source === 'agent' ? t('turnChanges.agentEdit') : t('turnChanges.otherChange') }}
      </Badge>
    </div>
    <div v-if="selectedPath !== null" class="codex-tc-diff">
      <div class="codex-tc-diff-head">
        <span class="codex-tc-diff-path" :title="selectedPath">{{ truncateLeft(selectedPath, 64) }}</span>
        <span class="codex-tc-diff-kind">{{ t('turnChanges.currentDiff') }}</span>
      </div>
      <div v-if="diffState === 'loading'" class="codex-tc-hint">{{ t('turnChanges.loading') }}</div>
      <div v-else-if="diffState !== 'ok'" class="codex-tc-hint">{{ t('turnChanges.noDiff') }}</div>
      <div v-else class="codex-tc-diff-body">
        <DiffLines :lines="diffLines" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.codex-tc {
  display: inline-flex;
  align-items: center;
}

.codex-tc-link {
  appearance: none;
  border: none;
  background: none;
  padding: 0;
  margin: 0;
  font: inherit;
  font-size: var(--text-base);
  color: var(--muted);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.codex-tc-link:hover {
  color: var(--color-text);
}

/* 面板是 .a-msg-ft(flex 行)的第二个根节点,flex-basis:100% + 父级
   flex-wrap 使其独占一行落在 footer 下方。 */
.codex-tc-panel {
  flex-basis: 100%;
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
}

.codex-tc-head {
  font-size: var(--text-xs);
  color: var(--muted);
  margin-bottom: 6px;
}

.codex-tc-hint {
  font-size: var(--text-xs);
  color: var(--muted);
  padding: 4px 0;
}

.codex-tc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.codex-tc-file {
  appearance: none;
  border: none;
  background: none;
  padding: 2px 0;
  margin: 0;
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: var(--color-text);
  min-width: 0;
  flex: 1;
}

.codex-tc-file:disabled {
  cursor: default;
}

.codex-tc-file:not(:disabled):hover .codex-tc-path {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.codex-tc-row.is-active .codex-tc-path {
  color: var(--color-accent);
}

.codex-tc-path {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  word-break: break-all;
}

.codex-tc-diff {
  margin-top: 6px;
  border-top: 1px solid var(--line2);
  padding-top: 6px;
}

.codex-tc-diff-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.codex-tc-diff-path {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-tc-diff-kind {
  flex: none;
  font-size: var(--text-xs);
  color: var(--muted);
}

.codex-tc-diff-body {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--line2);
  border-radius: var(--radius-sm);
}
</style>
