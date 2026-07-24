<!-- apps/kimi-web/src/components/codex/GitPanel.vue -->
<!-- F11 Git stage / commit 面板(docs/10):CodexSidebar 项目行 Git 按钮打开的
     工作区级模态面板。左栏变更文件列表(已暂存/未暂存分组,行内 stage/unstage),
     右栏 diff 视图(复用官方 DiffLines,数据来自壳侧 git diff / git diff --cached)
     + commit 框(有暂存文件且 message 非空才可提交)。取数与状态全在
     useGitPanel store;壳侧错误语义:not_a_repo(空态)/ git_failed(错误条+重试)。
     入口仅在桌面壳(有 window.desktop.git 桥)出现,浏览器环境不会渲染本组件。 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DiffViewLine } from '../../types';
import { parseDiff } from '../../lib/parseDiff';
import {
  createGitPanelStore,
  selectionKey,
  statusCodeOf,
  type GitBridge,
  type GitPanelFile,
} from './useGitPanel';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Badge from '../ui/Badge.vue';
import Icon from '../ui/Icon.vue';
import IconButton from '../ui/IconButton.vue';
import DiffLines from '../chat/DiffLines.vue';

const props = defineProps<{
  workspace: { id: string; name: string; root: string };
  bridge: GitBridge;
}>();

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const store = createGitPanelStore({ bridge: props.bridge });

onMounted(() => store.open(props.workspace.root));

// ---------------------------------------------------------------------------
// Diff 视图(组件本地状态,与 F9 TurnChangesFooter 同模式)
// ---------------------------------------------------------------------------
const diffLines = ref<DiffViewLine[]>([]);
const diffState = ref<'idle' | 'loading' | 'ok' | 'empty' | 'failed'>('idle');
const diffTruncated = ref(false);
/** 当前 diff 对应的文件是否未跟踪(空 diff 时展示"暂存后可预览"提示) */
const diffIsUntracked = ref(false);

function selectedFile(): { file: GitPanelFile; staged: boolean } | null {
  const key = store.selected.value;
  if (key === null) return null;
  for (const f of store.stagedFiles.value) {
    if (selectionKey(f.path, true) === key) return { file: f, staged: true };
  }
  for (const f of store.unstagedFiles.value) {
    if (selectionKey(f.path, false) === key) return { file: f, staged: false };
  }
  return null;
}

async function loadDiff(): Promise<void> {
  const sel = selectedFile();
  if (sel === null) {
    diffState.value = 'idle';
    diffLines.value = [];
    return;
  }
  const key = selectionKey(sel.file.path, sel.staged);
  diffState.value = 'loading';
  diffLines.value = [];
  diffTruncated.value = false;
  const result = await store.fetchDiff(sel.file.path, sel.staged);
  // 已切换目标/取消选中:丢弃迟到响应
  if (store.selected.value !== key) return;
  if (result === null) {
    diffState.value = 'failed';
    return;
  }
  diffIsUntracked.value = sel.file.index === '?';
  diffTruncated.value = result.truncated;
  const lines = parseDiff(result.diff);
  diffLines.value = lines;
  diffState.value = lines.length > 0 ? 'ok' : 'empty';
}

watch(() => store.selected.value, () => void loadDiff());

function onRowClick(f: GitPanelFile, staged: boolean): void {
  store.select(f.path, staged);
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------
function statusLabel(f: GitPanelFile, staged: boolean): string {
  const code = statusCodeOf(f, staged);
  const key = `gitPanel.status.${code}`;
  const label = t(key);
  return label === key ? code : label;
}

/** 长路径保留尾部(文件名优先),与 F9/DiffView 的 truncateLeft 同款。 */
function truncateLeft(p: string, max: number): string {
  return p.length <= max ? p : '…' + p.slice(-(max - 1));
}

const shortHash = computed(() => store.committedHash.value?.slice(0, 7) ?? '');

function onCommit(): void {
  void store.commit();
}
</script>

<template>
  <Dialog
    :open="true"
    :title="t('gitPanel.title', { name: workspace.name })"
    size="xl"
    height="fixed"
    :padded="false"
    @close="emit('close')"
  >
    <div class="codex-git">
      <!-- 左栏:变更文件列表 -->
      <div class="codex-git-list">
        <div class="codex-git-list-head">
          <span class="codex-git-list-title">{{ t('gitPanel.changes') }}</span>
          <IconButton size="sm" :label="t('gitPanel.refresh')" @click="void store.refresh()">
            <Icon name="refresh" size="sm" />
          </IconButton>
        </div>

        <div class="codex-git-list-body">
          <div v-if="store.loadState.value === 'loading'" class="codex-git-empty">
            {{ t('gitPanel.loading') }}
          </div>
          <div v-else-if="store.loadState.value === 'not_a_repo'" class="codex-git-empty">
            {{ t('gitPanel.notARepo') }}
          </div>
          <template v-else>
            <div v-if="store.loadState.value === 'failed'" class="codex-git-warn">
              <span class="codex-git-warn-text" :title="store.errorMessage.value">
                {{ t('gitPanel.loadFailed') }}:{{ store.errorMessage.value }}
              </span>
              <Button variant="secondary" size="sm" @click="void store.refresh()">
                {{ t('gitPanel.retry') }}
              </Button>
            </div>
            <div
              v-if="store.loadState.value === 'ok' && store.files.value !== null && store.files.value.length === 0"
              class="codex-git-empty"
            >
              {{ t('gitPanel.clean') }}
            </div>

            <!-- 已暂存分组 -->
            <section v-if="store.stagedFiles.value.length > 0" class="codex-git-group">
              <div class="codex-git-group-title">
                {{ t('gitPanel.staged') }} · {{ store.stagedFiles.value.length }}
              </div>
              <div
                v-for="f in store.stagedFiles.value"
                :key="selectionKey(f.path, true)"
                class="codex-git-row"
                :class="{ 'is-active': store.selected.value === selectionKey(f.path, true) }"
                @click="onRowClick(f, true)"
              >
                <Badge variant="info" size="sm">{{ statusLabel(f, true) }}</Badge>
                <span class="codex-git-path" :title="f.path">{{ truncateLeft(f.path, 48) }}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  :disabled="store.pendingPaths.value[f.path] === true"
                  @click.stop="void store.unstage([f.path])"
                >
                  {{ t('gitPanel.unstage') }}
                </Button>
              </div>
            </section>

            <!-- 未暂存分组 -->
            <section v-if="store.unstagedFiles.value.length > 0" class="codex-git-group">
              <div class="codex-git-group-title">
                {{ t('gitPanel.unstaged') }} · {{ store.unstagedFiles.value.length }}
              </div>
              <div
                v-for="f in store.unstagedFiles.value"
                :key="selectionKey(f.path, false)"
                class="codex-git-row"
                :class="{ 'is-active': store.selected.value === selectionKey(f.path, false) }"
                @click="onRowClick(f, false)"
              >
                <Badge variant="neutral" size="sm">{{ statusLabel(f, false) }}</Badge>
                <span class="codex-git-path" :title="f.path">{{ truncateLeft(f.path, 48) }}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  :disabled="store.pendingPaths.value[f.path] === true"
                  @click.stop="void store.stage([f.path])"
                >
                  {{ t('gitPanel.stage') }}
                </Button>
              </div>
            </section>
          </template>
        </div>
      </div>

      <!-- 右栏:diff + commit -->
      <div class="codex-git-main">
        <div class="codex-git-diff">
          <div v-if="diffState === 'idle'" class="codex-git-hint">
            {{ t('gitPanel.selectFile') }}
          </div>
          <div v-else-if="diffState === 'loading'" class="codex-git-hint">
            {{ t('gitPanel.loadingDiff') }}
          </div>
          <div v-else-if="diffState === 'failed'" class="codex-git-hint">
            {{ t('gitPanel.loadFailed') }}
          </div>
          <div v-else-if="diffState === 'empty'" class="codex-git-hint">
            {{ diffIsUntracked ? t('gitPanel.newFileHint') : t('gitPanel.noDiff') }}
          </div>
          <template v-else>
            <div v-if="diffTruncated" class="codex-git-trunc">{{ t('gitPanel.diffTruncated') }}</div>
            <div class="codex-git-diff-body">
              <DiffLines :lines="diffLines" />
            </div>
          </template>
        </div>

        <div class="codex-git-commit">
          <textarea
            v-model="store.message.value"
            class="codex-git-message"
            rows="2"
            :placeholder="t('gitPanel.commitPlaceholder')"
          />
          <div class="codex-git-commit-foot">
            <span class="codex-git-commit-hint">
              <template v-if="store.committedHash.value !== null">
                {{ t('gitPanel.committed', { hash: shortHash }) }}
              </template>
              <template v-else-if="store.commitError.value !== null">
                <span class="codex-git-commit-error" :title="store.commitError.value">
                  {{ t('gitPanel.commitFailed') }}:{{ store.commitError.value }}
                </span>
              </template>
              <template v-else-if="store.stagedFiles.value.length > 0">
                {{ t('gitPanel.commitHint', { count: store.stagedFiles.value.length }) }}
              </template>
              <template v-else>
                {{ t('gitPanel.commitNeedStaged') }}
              </template>
            </span>
            <Button
              variant="primary"
              size="sm"
              :disabled="!store.canCommit.value"
              :loading="store.committing.value"
              @click="onCommit"
            >
              {{ store.committing.value ? t('gitPanel.committing') : t('gitPanel.commit') }}
            </Button>
          </div>
        </div>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.codex-git {
  display: flex;
  height: 100%;
  min-height: 0;
  font-family: var(--font-ui);
}

/* 左栏:文件列表 */
.codex-git-list {
  flex: none;
  width: 300px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--color-line);
}
.codex-git-list-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.codex-git-list-title {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.codex-git-list-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2);
}
.codex-git-empty {
  padding: var(--space-4);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  text-align: center;
}
.codex-git-warn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-warning);
}
.codex-git-warn-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-git-group-title {
  padding: var(--space-2) var(--space-1) var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  user-select: none;
}
.codex-git-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px var(--space-1);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.codex-git-row:hover {
  background: var(--color-hover);
}
.codex-git-row.is-active {
  background: var(--color-selected);
}
.codex-git-path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 右栏:diff + commit */
.codex-git-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.codex-git-diff {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3);
}
.codex-git-hint {
  padding: var(--space-4);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  text-align: center;
}
.codex-git-trunc {
  margin-bottom: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-warning);
}
.codex-git-diff-body {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  overflow: auto;
}
.codex-git-commit {
  flex: none;
  border-top: 1px solid var(--color-line);
  padding: var(--space-3);
}
.codex-git-message {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  padding: 6px 8px;
  outline: none;
}
.codex-git-message:focus {
  border-color: var(--color-accent-bd);
}
.codex-git-commit-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.codex-git-commit-hint {
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-git-commit-error {
  color: var(--color-danger);
}
</style>
