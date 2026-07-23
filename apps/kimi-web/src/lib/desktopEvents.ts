// apps/kimi-web/src/lib/desktopEvents.ts
// F15:桌面壳(preload/应用菜单)经 window CustomEvent 桥接给 kimi-web 的事件约定。
// 事件名是壳/web 两侧的固定契约,改动需双侧同步。浏览器/dev 环境下壳不会派发,
// 监听器安静地不触发,侧栏自身的折叠按钮仍可用。

/** 壳侧"切换侧栏折叠"事件(⌘B 菜单项经 preload 派发)。 */
export const DESKTOP_TOGGLE_SIDEBAR_EVENT = 'desktop:toggle-sidebar';

/**
 * 监听壳侧的侧栏切换事件,返回取消监听函数(供 onUnmounted 调用)。
 */
export function onDesktopToggleSidebar(handler: () => void): () => void {
  const listener = (): void => handler();
  window.addEventListener(DESKTOP_TOGGLE_SIDEBAR_EVENT, listener);
  return () => window.removeEventListener(DESKTOP_TOGGLE_SIDEBAR_EVENT, listener);
}
