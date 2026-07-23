<!-- apps/kimi-web/src/components/codex/CodexSidebar.vue -->
<!-- Codex-App-style sidebar: a flat, self-contained project tree that reads the
     useKimiWebClient() facade directly (READ-ONLY consumer — no store copies,
     no REST calls). Replaces Sidebar.vue at App.vue's single mount point.
     Destructive actions (archive) and the add-workspace dialog stay in App.vue
     and are reached via emits; everything else calls facade actions inline. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebClient } from '../../composables/useKimiWebClient';
import { isMacosDesktop } from '../../lib/desktopFlag';
import {
  loadCollapsedWorkspaces,
  saveCollapsedWorkspaces,
} from '../../lib/storage';
import type { Session } from '../../types';
import { recallLastSession, rememberLastSession } from './useLastSessionMap';
import { isExternallyActive, useBackgroundStatus } from './useBackgroundStatus';
import Icon from '../ui/Icon.vue';
import IconButton from '../ui/IconButton.vue';
import Badge from '../ui/Badge.vue';
import Spinner from '../ui/Spinner.vue';
import Tooltip from '../ui/Tooltip.vue';
import Menu from '../ui/Menu.vue';
import MenuItem from '../ui/MenuItem.vue';
import CodexUsageBadge from './CodexUsageBadge.vue';

const { t, locale } = useI18n();
const client = useKimiWebClient();

// M3 Task 3.5:桌面壳注入的最小 API(浏览器中不存在 → 隐藏壳相关入口)。
interface DesktopBridge {
  system?: {
    openPath?: (path: string) => Promise<void>;
  };
}
const desktopBridge: DesktopBridge | undefined = (
  window as unknown as { desktop?: DesktopBridge }
).desktop;

const zhLabel = (zh: string, en: string): string =>
  locale.value.startsWith('zh') ? zh : en;

withDefaults(
  defineProps<{
    /** Width (px) of the column, driven by the App resize handle. */
    colWidth?: number;
    /** True when the sidebar is collapsed: the container animates to width 0
     *  (content keeps `colWidth` and is clipped), then hides itself. */
    collapsed?: boolean;
    /** True while the resize handle is dragged — disables the width transition
     *  so the sidebar follows the pointer 1:1. */
    dragging?: boolean;
  }>(),
  { colWidth: 220, collapsed: false, dragging: false },
);

const emit = defineEmits<{
  /** Header "+ New Chat": draft in the active workspace (App focuses composer). */
  create: [];
  /** Per-project "+ New Session": draft in that workspace (App focuses composer). */
  createInWorkspace: [workspaceId: string];
  /** Open App.vue's AddWorkspaceDialog (the only add-project flow). */
  addWorkspace: [];
  /** Archive intent — the modal confirm + async work live in App.vue. */
  archive: [id: string];
  /** Remove-from-list intent — the modal confirm lives in App.vue (M3 Task 3.5). */
  deleteWorkspace: [id: string];
  openSettings: [];
  collapse: [];
}>();

// ---------------------------------------------------------------------------
// Inline session filter. A non-empty query swaps the project tree for a flat
// title-filtered list (facade sessionsForView = all loaded sessions).
// ---------------------------------------------------------------------------
const query = ref('');
const filteredSessions = computed<Session[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  return client.sessionsForView.value.filter((s) =>
    s.title.toLowerCase().includes(q),
  );
});
const searching = computed(() => query.value.trim().length > 0);

// ---------------------------------------------------------------------------
// Collapsed projects — same localStorage key/semantics as the old sidebar.
// ---------------------------------------------------------------------------
const collapsedIds = ref<Set<string>>(new Set(loadCollapsedWorkspaces()));

function isCollapsed(id: string): boolean {
  return collapsedIds.value.has(id);
}

function toggleCollapse(id: string): void {
  const next = new Set(collapsedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedIds.value = next;
  saveCollapsedWorkspaces(next);
}

// Project click: return to the project's last VIEWED session (M3 Task 3.3,
// desktop-owned UI metadata). Falls back to the facade's openWorkspace
// ("most recently updated") when there is no memory or the remembered
// session is gone (deleted/archived). Opening also expands a collapsed group.
function sessionWorkspaceId(sessionId: string): string | null {
  for (const g of client.workspaceGroups.value) {
    if (g.sessions.some((s) => s.id === sessionId)) return g.workspace.id;
  }
  return null;
}

// Track the active session and record it as its workspace's last-viewed one.
watch(
  () => client.activeSessionId.value,
  (id) => {
    if (!id) return;
    const wid = sessionWorkspaceId(id);
    if (wid) rememberLastSession(wid, id);
  },
);

function openProject(id: string): void {
  if (collapsedIds.value.has(id)) toggleCollapse(id);
  const remembered = recallLastSession(id, (sid) =>
    client.workspaceGroups.value.some(
      (g) => g.workspace.id === id && g.sessions.some((s) => s.id === sid),
    ),
  );
  if (remembered) {
    client.selectSession(remembered);
    return;
  }
  client.openWorkspace(id);
}

function selectSession(id: string): void {
  client.selectSession(id);
}

/** 点击项目行 = 折叠/展开(Codex 语义);展开时恢复该项目最近查看的会话 */
function onProjectRowClick(id: string): void {
  if (isCollapsed(id)) openProject(id);
  else toggleCollapse(id);
}

// ---------------------------------------------------------------------------
// Per-session badge predicates (same conditions as the old SessionRow).
// M3 Task 3.4:门面只实时跟踪 LRU 4 个订阅会话;busy/pending 以 REST 全局
// 覆盖源为准(useBackgroundStatus),让非当前视图的后台会话角标同样准确。
// ---------------------------------------------------------------------------
const { statusById } = useBackgroundStatus();

function liveBusy(s: Session): boolean {
  return statusById.value.get(s.id)?.busy ?? s.busy;
}
function livePending(s: Session): 'none' | 'approval' | 'question' {
  return statusById.value.get(s.id)?.pending ?? s.pendingInteraction ?? 'none';
}
function approvalCount(s: Session): number {
  return client.pendingBySession.value[s.id]?.approvals ?? 0;
}
function questionCount(s: Session): number {
  return client.pendingBySession.value[s.id]?.questions ?? 0;
}
function awaitingQuestion(s: Session): boolean {
  return questionCount(s) > 0 || livePending(s) === 'question';
}
function awaitingApproval(s: Session): boolean {
  return approvalCount(s) > 0 || livePending(s) === 'approval';
}
function failed(s: Session): boolean {
  return (
    !liveBusy(s) &&
    !awaitingQuestion(s) &&
    !awaitingApproval(s) &&
    (s.lastTurnReason === 'cancelled' || s.lastTurnReason === 'failed')
  );
}
function isUnread(s: Session): boolean {
  return client.unreadBySession.value[s.id] ?? false;
}

// M4 Task 4.2:外部客户端(CLI 等)活跃指示。判定见 useBackgroundStatus。
// 首次进入外部活跃时 console.warn 一次(可上报),恢复后清除记录。
const externalWarned = new Set<string>();

function externallyActive(s: Session): boolean {
  const active = isExternallyActive(s.id, client.activeSessionId.value, statusById.value);
  if (active && !externalWarned.has(s.id)) {
    externalWarned.add(s.id);
    console.warn(`[codex] session ${s.id} is busy in an external client (possible CLI); concurrent writes may conflict`);
  } else if (!active) {
    externalWarned.delete(s.id);
  }
  return active;
}

/** 项目级聚合角标:只数等待交互(待审批/待回答)的会话。
 *  busy 不计入(会话行已有 spinner,"在跑"不等于"待处理");
 *  只以 REST 轮询覆盖源计数(全量权威),不再叠加门面 attentionByWorkspace
 *  (WS 事件驱动、仅覆盖 4 个订阅会话,清除不及时会造成幻影计数)。 */
function workspaceAttention(workspaceId: string): number {
  const g = client.workspaceGroups.value.find((x) => x.workspace.id === workspaceId);
  if (!g) return 0;
  let n = 0;
  for (const s of g.sessions) {
    if (livePending(s) !== 'none') n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Inline rename (dblclick the title, or the kebab's Rename item).
// ---------------------------------------------------------------------------
const renamingId = ref<string | null>(null);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);

async function startRename(s: Session): Promise<void> {
  closeMenu();
  renamingId.value = s.id;
  renameValue.value = s.title;
  await nextTick();
  try {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  } catch {
    // jsdom may not implement focus/select
  }
}

function commitRename(): void {
  const id = renamingId.value;
  const title = renameValue.value.trim();
  if (id && title) client.renameSession(id, title);
  renamingId.value = null;
}

function cancelRename(): void {
  renamingId.value = null;
}

// ---------------------------------------------------------------------------
// Session kebab menu (rename / fork / archive). Teleported to <body> and
// anchored to the ⋯ button, mirroring SessionRow's pattern so the scrolling
// list can't clip it.
// ---------------------------------------------------------------------------
const menuSession = ref<Session | null>(null);
const menuStyle = ref<Record<string, string>>({});
const kebabRef = ref<InstanceType<typeof IconButton> | null>(null);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target) || kebabRef.value?.el?.contains(target)) return;
  closeMenu();
}

async function toggleMenu(s: Session, e: Event): Promise<void> {
  e.stopPropagation();
  if (menuSession.value) {
    closeMenu();
    return;
  }
  menuSession.value = s;
  // Defer so the current click doesn't immediately close the menu.
  setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
  window.addEventListener('resize', closeMenu);
  // Wait for the teleported menu to mount so its size can be measured.
  await nextTick();
  const btn = kebabRef.value?.el;
  if (!btn) return;
  const menu = menuRef.value?.el;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuH = menu?.offsetHeight ?? 0;
  const menuW = menu?.offsetWidth ?? 0;
  let top = r.bottom + gap;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
  }
  let left = r.right - menuW;
  if (left < margin) left = margin;
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

function closeMenu(): void {
  menuSession.value = null;
  menuProject.value = null;
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', closeMenu);
}

function forkFromMenu(): void {
  const s = menuSession.value;
  closeMenu();
  if (s) void client.forkSession(s.id);
}

function archiveFromMenu(): void {
  const s = menuSession.value;
  closeMenu();
  // The modal confirm and the async work live in App.vue (confirmArchiveSession).
  if (s) emit('archive', s.id);
}

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', closeMenu);
});

// ---------------------------------------------------------------------------
// Project kebab menu (Open in Finder / Copy path / Remove from list).
// Reuses the session menu's anchor machinery via a shared close path.
// M3 Task 3.5:移除只从列表隐藏(官方 deleteWorkspace 语义),不删除本地目录。
// ---------------------------------------------------------------------------
const menuProject = ref<{ id: string; name: string; root: string } | null>(null);

async function toggleProjectMenu(
  g: { workspace: { id: string; name: string; root: string } },
  e: Event,
): Promise<void> {
  e.stopPropagation();
  if (menuProject.value) {
    closeMenu();
    return;
  }
  menuProject.value = { ...g.workspace };
  setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
  window.addEventListener('resize', closeMenu);
  await nextTick();
  // 直接用事件源的按钮做锚点(kebabRef 被会话行共享,不可靠)
  const btn = (e.currentTarget as HTMLElement | null) ?? kebabRef.value?.el;
  if (!btn) return;
  const menu = menuRef.value?.el;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuH = menu?.offsetHeight ?? 0;
  const menuW = menu?.offsetWidth ?? 0;
  let top = r.bottom + gap;
  if (top + menuH > window.innerHeight - margin) top = Math.max(margin, r.top - menuH - gap);
  let left = r.right - menuW;
  if (left < margin) left = margin;
  menuStyle.value = { top: `${Math.round(top)}px`, left: `${Math.round(left)}px` };
}

function openProjectInFinder(): void {
  const p = menuProject.value;
  closeMenu();
  if (p) void desktopBridge?.system?.openPath?.(p.root);
}

async function copyProjectPath(): Promise<void> {
  const p = menuProject.value;
  closeMenu();
  if (p) await navigator.clipboard.writeText(p.root);
}

function removeProjectFromList(): void {
  const p = menuProject.value;
  closeMenu();
  // The modal confirm lives in App.vue (confirmDeleteWorkspace); the official
  // flow only hides the workspace — the local directory is never touched.
  if (p) emit('deleteWorkspace', p.id);
}
</script>

<template>
  <aside
    class="side codex-side"
    :class="{ 'macos-desktop': isMacosDesktop, collapsed, 'no-anim': dragging }"
    :style="{ width: collapsed ? '0px' : colWidth + 'px' }"
  >
    <div class="codex-col" :style="{ width: colWidth + 'px' }">
      <!-- Header: brand + collapse. On macOS desktop the brand and the in-header
           collapse button are hidden (traffic lights own that corner and the
           toggle is App.vue's resident floating button) — the header is just a
           window-drag strip. -->
      <div class="codex-head">
        <div class="codex-brand">
          <span class="codex-name">Kimi Code</span>
        </div>
        <IconButton
          v-if="!isMacosDesktop"
          size="sm"
          :label="t('sidebar.collapseSidebar')"
          @click.stop="emit('collapse')"
        >
          <Icon name="panel-collapse" />
        </IconButton>
      </div>

      <!-- New chat -->
      <div class="codex-btn-wrap">
        <button class="codex-btn-new" type="button" @click.stop="emit('create')">
          <Icon name="chat-new" />
          <span>{{ t('sidebar.newChat') }}</span>
        </button>
      </div>

      <!-- Inline session filter -->
      <div class="codex-search-wrap">
        <div class="codex-search">
          <Icon class="codex-search-icon" name="search" />
          <input
            v-model="query"
            class="codex-search-input"
            type="text"
            :placeholder="t('sidebar.searchPlaceholder')"
          />
        </div>
      </div>

      <!-- List: flat filter results while searching, project tree otherwise. -->
      <div class="codex-list">
        <template v-if="searching">
          <div v-if="filteredSessions.length === 0" class="codex-empty">
            {{ t('sidebar.searchNoResults') }}
          </div>
          <div
            v-for="s in filteredSessions"
            :key="s.id"
            class="codex-se"
            :class="{ on: s.id === client.activeSessionId.value }"
            @click="selectSession(s.id)"
          >
            <span class="codex-lead" aria-hidden="true">
              <Tooltip
                v-if="externallyActive(s)"
                :text="zhLabel('该会话正被外部客户端(如 CLI)使用,同时写入有冲突风险', 'Busy in another client (e.g. CLI) — concurrent writes may conflict')"
              >
                <Icon name="terminal" size="sm" class="codex-external" />
              </Tooltip>
              <Spinner v-else-if="liveBusy(s)" size="sm" />
              <span v-else-if="isUnread(s)" class="codex-unread-dot" />
            </span>
            <span class="codex-se-main">
              <span class="codex-t">{{ s.title }}</span>
              <span v-if="s.workspaceName" class="codex-ws">{{ s.workspaceName }}</span>
            </span>
            <span class="codex-ts">{{ s.time }}</span>
          </div>
        </template>

        <template v-else>
          <div v-if="client.workspaceGroups.value.length === 0" class="codex-empty">
            {{ t('workspace.noWorkspace') }}
          </div>
          <template v-else>
            <div class="codex-section">
              <span class="codex-section-title">{{ t('sidebar.workspaces') }}</span>
              <IconButton
                class="codex-section-add"
                size="sm"
                :label="t('sidebar.newWorkspace')"
                @click.stop="emit('addWorkspace')"
              >
                <Icon name="folder-plus" />
              </IconButton>
            </div>

            <div
              v-for="g in client.workspaceGroups.value"
              :key="g.workspace.id"
              class="codex-group"
            >
              <!-- Project row: click = 折叠/展开(展开时恢复最近会话); chevron 同效。 -->
              <div
                class="codex-proj"
                :class="{ on: g.workspace.id === client.activeWorkspaceId.value }"
                @click="onProjectRowClick(g.workspace.id)"
              >
                <button
                  class="codex-chevron"
                  type="button"
                  :aria-label="t('sidebar.collapseSidebar')"
                  @click.stop="toggleCollapse(g.workspace.id)"
                >
                  <Icon
                    :name="isCollapsed(g.workspace.id) ? 'chevron-right' : 'chevron-down'"
                    size="sm"
                  />
                </button>
                <!-- 文件夹图标随折叠状态切换:折叠=kimi folder(带横线,放大版),展开=ChatGPT 打开文件夹 -->
                <Icon
                  class="codex-folder"
                  :name="isCollapsed(g.workspace.id) ? 'folder-collapsed' : 'folder-outline'"
                />
                <span class="codex-proj-name">{{ g.workspace.name }}</span>
                <Tooltip
                  v-if="workspaceAttention(g.workspace.id) > 0"
                  :text="t('workspace.attentionTitle', workspaceAttention(g.workspace.id))"
                >
                  <Badge variant="warning" size="sm">
                    {{ workspaceAttention(g.workspace.id) }}
                  </Badge>
                </Tooltip>
                <IconButton
                  class="codex-proj-add"
                  size="sm"
                  :label="t('workspace.newInGroup')"
                  @click.stop="emit('createInWorkspace', g.workspace.id)"
                >
                  <Icon name="edit-box" />
                </IconButton>
                <IconButton
                  ref="kebabRef"
                  class="codex-proj-kebab"
                  size="sm"
                  :label="zhLabel('项目操作', 'Project actions')"
                  @click="(e: Event) => toggleProjectMenu(g, e)"
                >
                  <Icon name="dots-horizontal" size="sm" />
                </IconButton>
              </div>

              <!-- Sessions (hidden while the project is collapsed) -->
              <div v-if="!isCollapsed(g.workspace.id)" class="codex-group-sessions">
                <div
                  v-for="s in g.sessions"
                  :key="s.id"
                  class="codex-se"
                  :class="{ on: s.id === client.activeSessionId.value }"
                  @click="selectSession(s.id)"
                >
                  <span class="codex-lead" aria-hidden="true">
                    <Tooltip
                      v-if="externallyActive(s)"
                      :text="zhLabel('该会话正被外部客户端(如 CLI)使用,同时写入有冲突风险', 'Busy in another client (e.g. CLI) — concurrent writes may conflict')"
                    >
                      <Icon name="terminal" size="sm" class="codex-external" />
                    </Tooltip>
                    <Spinner v-else-if="liveBusy(s)" size="sm" />
                    <span v-else-if="isUnread(s)" class="codex-unread-dot" />
                  </span>

                  <input
                    v-if="renamingId === s.id"
                    ref="renameInputRef"
                    v-model="renameValue"
                    class="codex-rename"
                    @click.stop
                    @keydown.enter.stop="commitRename"
                    @keydown.esc.stop="cancelRename"
                    @blur="commitRename"
                  />
                  <span v-else class="codex-t" @dblclick.stop="startRename(s)">{{ s.title }}</span>

                  <Tooltip :text="t('workspace.awaitingAnswerTitle')">
                    <Badge v-if="renamingId !== s.id && awaitingQuestion(s)" variant="info" size="sm">
                      {{ t('workspace.awaitingAnswer') }}
                    </Badge>
                  </Tooltip>
                  <Tooltip :text="t('workspace.awaitingPermissionTitle')">
                    <Badge v-if="renamingId !== s.id && awaitingApproval(s)" variant="warning" size="sm">
                      {{ t('workspace.awaitingPermission') }}
                    </Badge>
                  </Tooltip>
                  <Tooltip :text="t('workspace.abortedTitle')">
                    <Badge v-if="renamingId !== s.id && failed(s)" variant="danger" size="sm">
                      {{ t('workspace.aborted') }}
                    </Badge>
                  </Tooltip>

                  <!-- Trailing slot: time and kebab share one cell and swap via
                       `visibility`, so the title never reflows on hover. -->
                  <span class="codex-act">
                    <span class="codex-ts">{{ s.time }}</span>
                    <IconButton
                      ref="kebabRef"
                      v-if="renamingId !== s.id"
                      class="codex-kebab"
                      :class="{ open: menuSession?.id === s.id }"
                      size="sm"
                      :label="t('sidebar.options')"
                      @click.stop="toggleMenu(s, $event)"
                    >
                      <Icon name="dots-horizontal" />
                    </IconButton>
                  </span>
                </div>

                <!-- Per-project new session lives on the project row's hover
                     compose button; no separate list row. -->

                <button
                  v-if="g.hasMore || g.loadingMore"
                  class="codex-show-more"
                  :disabled="g.loadingMore"
                  @click.stop="void client.loadMoreSessions(g.workspace.id)"
                >
                  {{ g.loadingMore ? t('sidebar.loadingMore') : t('sidebar.showMore', { count: g.sessions.length }) }}
                </button>
                <div v-if="g.sessions.length === 0" class="codex-group-empty">
                  {{ t('sidebar.noSessions') }}
                </div>
              </div>
            </div>
          </template>
        </template>
      </div>

      <!-- Footer: settings entry pinned under the list; usage badge (desktop
           shell only — renders nothing in the browser) sits at the right. -->
      <div class="codex-footer">
        <button class="codex-btn-settings" type="button" @click.stop="emit('openSettings')">
          <Icon name="settings" />
          <span>{{ t('settings.title') }}</span>
        </button>
        <CodexUsageBadge />
      </div>
    </div>

    <!-- Session kebab dropdown — teleported to <body> and position:fixed so the
         collapsing group's `overflow: hidden` can't clip it. -->
    <Teleport to="body">
      <Menu
        v-if="menuSession"
        ref="menuRef"
        class="codex-menu"
        :style="menuStyle"
        @click.stop
      >
        <MenuItem @click="menuSession && startRename(menuSession)">
          <Icon name="pencil" size="sm" />
          {{ t('sidebar.rename') }}
        </MenuItem>
        <MenuItem @click="forkFromMenu">
          <Icon name="git-fork" size="sm" />
          {{ t('sidebar.fork') }}
        </MenuItem>
        <MenuItem danger @click="archiveFromMenu">
          <Icon name="archive" size="sm" />
          {{ t('sidebar.archive') }}
        </MenuItem>
      </Menu>
      <Menu
        v-if="menuProject"
        ref="menuRef"
        class="codex-menu"
        :style="menuStyle"
        @click.stop
      >
        <MenuItem v-if="desktopBridge?.system?.openPath" @click="openProjectInFinder">
          <Icon name="folder" size="sm" />
          {{ zhLabel('在 Finder 中显示', 'Reveal in Finder') }}
        </MenuItem>
        <MenuItem @click="copyProjectPath">
          <Icon name="copy" size="sm" />
          {{ t('sidebar.copyPath') }}
        </MenuItem>
        <MenuItem danger @click="removeProjectFromList">
          <Icon name="close" size="sm" />
          {{ t('sidebar.removeWorkspace') }}
        </MenuItem>
      </Menu>
    </Teleport>
  </aside>
</template>

<style scoped>
/* Layout contract with App.vue: the `side` class on the root is what App.vue's
   scoped `.app > .side { grid-column: 1 }` pins into the grid. All custom
   styling lives under the codex- namespace. Mirrors the old .side semantics:
   fixed-width column clipped by the animating container. */
.codex-side {
  background: var(--color-sidebar-bg);
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  overflow: hidden;
  min-width: 0;
  height: 100%;
  transition:
    width 0.28s cubic-bezier(0.4, 0, 0.2, 1),
    visibility 0.28s;
  /* Row alignment vars (same contract the old sidebar gave its rows):
     row boxes sit --codex-inset from the edges; text/icons start at
     --codex-pad-x; session titles start at pad-x + gutter + gap. */
  --codex-inset: var(--space-3);
  --codex-pad-x: var(--space-5);
  --codex-gutter: 16px;
  --codex-gap: var(--space-2);
  --codex-hover: var(--color-hover);
}
.codex-side.no-anim {
  transition: none;
}
.codex-side.collapsed {
  visibility: hidden;
}

.codex-col {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  border-right: 1px solid var(--line);
}

/* Header — on macOS desktop it is purely a window-drag strip (padding-left
   clears the floating traffic lights; brand hidden). */
.codex-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: var(--space-3);
  min-height: calc(26px + 2 * var(--space-3));
  width: 100%;
  box-sizing: border-box;
}
.codex-side.macos-desktop .codex-head {
  padding-left: 80px;
  -webkit-app-region: drag;
}
.codex-side.macos-desktop .codex-brand {
  display: none;
}
.codex-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  user-select: none;
}
.codex-name {
  font-size: var(--ui-font-size);
  font-weight: 500;
  line-height: 22px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* New chat — same list-style control family as the rows. */
.codex-btn-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 var(--codex-inset);
}
.codex-btn-new {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  padding: 8px calc(var(--codex-pad-x) - var(--codex-inset));
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  line-height: var(--leading-tight);
  cursor: pointer;
  text-align: left;
}
.codex-btn-new:hover { background: var(--codex-hover); }
.codex-btn-new:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.codex-btn-new svg { flex: none; }
.codex-btn-new span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Inline filter input. */
.codex-search-wrap {
  padding: var(--space-2) var(--codex-inset) 0;
}
.codex-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  color: var(--color-text-faint);
}
.codex-search:focus-within {
  outline: 2px solid var(--color-accent-bd);
  outline-offset: -2px;
}
.codex-search-icon { flex: none; }
.codex-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  line-height: var(--leading-tight);
  outline: none;
  padding: 0;
}
.codex-search-input::placeholder { color: var(--color-text-faint); }

/* Scrollable list. */
.codex-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-3) var(--codex-inset);
  min-height: 0;
}
.codex-list::-webkit-scrollbar { width: 4px; }
.codex-list::-webkit-scrollbar-track { background: transparent; }
.codex-list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
  border-radius: var(--radius-full);
}
.codex-list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--color-text) 25%, transparent);
}

.codex-empty {
  padding: var(--space-6) var(--space-3);
  text-align: center;
  color: var(--faint);
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1.6;
}

/* Section label + add-project button (revealed on hover, like the old
   sidebar's section toggles). */
.codex-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 var(--space-3) var(--space-1) var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  text-transform: uppercase;
  color: var(--faint);
  user-select: none;
}
.codex-section-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-section-add {
  color: var(--faint);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.codex-section:hover .codex-section-add,
.codex-section:focus-within .codex-section-add {
  opacity: 1;
}
.codex-section-add:hover { color: var(--dim); }
.codex-section-add svg { width: 13px; height: 13px; }

/* Project row. */
.codex-proj {
  display: flex;
  align-items: center;
  gap: var(--codex-gap);
  padding: 5px calc(var(--codex-pad-x) - var(--codex-inset));
  border-radius: var(--radius-sm);
  color: var(--color-text);
  cursor: pointer;
  user-select: none;
  position: relative;
}
.codex-proj:hover { background: var(--codex-hover); }
.codex-proj.on { background: var(--color-selected); }
.codex-chevron {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--codex-gutter);
  margin: 0 calc(-1 * var(--codex-gap)) 0 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
}
.codex-chevron:hover { color: var(--color-text-muted); }
.codex-folder {
  flex: none;
  color: var(--color-text-muted);
}
.codex-proj-name {
  flex: 1;
  min-width: 0;
  font-size: var(--ui-font-size-sm);
  line-height: var(--leading-tight);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-proj.on .codex-proj-name { color: var(--color-text); }
/* Per-project "+ New Session" — revealed on hover/keyboard focus. */
.codex-proj-add {
  flex: none;
  color: var(--faint);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.codex-proj:hover .codex-proj-add,
.codex-proj:focus-within .codex-proj-add {
  opacity: 1;
}
.codex-proj-add:hover { color: var(--dim); }

/* Session row. */
.codex-se {
  display: flex;
  align-items: center;
  gap: var(--codex-gap);
  min-width: 0;
  padding: 8px calc(var(--codex-pad-x) - var(--codex-inset));
  border-radius: var(--radius-sm);
  color: var(--color-text);
  cursor: pointer;
  position: relative;
}
.codex-se:hover { background: var(--codex-hover); }
.codex-se.on { background: var(--color-selected); }
.codex-lead {
  width: var(--codex-gutter);
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.codex-external { color: var(--color-warning, #d29922); }
.codex-unread-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}
.codex-se-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.codex-ws {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-t {
  flex: 1;
  min-width: 0;
  font-size: var(--ui-font-size-sm);
  font-weight: 450;
  line-height: var(--leading-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-ts {
  flex: none;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  line-height: var(--leading-tight);
  text-align: right;
}
.codex-act {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 26px;
}
.codex-act .codex-kebab {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  visibility: hidden;
}
.codex-se:hover .codex-act .codex-kebab,
.codex-act:has(.codex-kebab.open) .codex-kebab { visibility: visible; }
.codex-se:hover .codex-act .codex-ts,
.codex-act:has(.codex-kebab.open) .codex-ts { visibility: hidden; }
.codex-kebab.open { color: var(--color-text); background: var(--codex-hover); }

.codex-rename {
  flex: 1;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  padding: 1px 4px;
  outline: none;
}

/* Pagination rows — session-row-shaped quiet list controls; the label
   aligns under the session titles. */
.codex-show-more {
  display: flex;
  align-items: center;
  gap: var(--codex-gap);
  width: 100%;
  margin: 0;
  padding: 6px calc(var(--codex-pad-x) - var(--codex-inset));
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  text-align: left;
  cursor: pointer;
}
.codex-show-more:hover { background: var(--codex-hover); }
.codex-show-more:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.codex-show-more {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-group-empty {
  padding: var(--space-1) var(--space-2) var(--space-1)
    calc(var(--codex-pad-x) - var(--codex-inset) + var(--codex-gutter) + var(--codex-gap));
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-family: var(--font-ui);
}

/* Footer: settings row + desktop usage badge (right-aligned). */
.codex-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--codex-inset);
  border-top: 1px solid var(--line);
}
.codex-btn-settings {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  padding: 8px calc(var(--codex-pad-x) - var(--codex-inset));
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  line-height: var(--leading-tight);
  cursor: pointer;
  text-align: left;
}
.codex-btn-settings:hover { background: var(--codex-hover); }
.codex-btn-settings:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.codex-btn-settings svg { flex: none; }
.codex-btn-settings span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Kebab menu — fixed positioning; surface/items come from Menu/MenuItem. */
.codex-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
</style>
