// F13(docs/11):本地网页预览入口的 URL 检测(纯函数,便于单测)。
// 从最新 assistant 文本中检测 localhost URL(http/https +
// localhost/127.0.0.1/[::1],可带端口与路径),取最后出现的一条——
// 对话里可能提到多个地址(迁移端口、对比环境),最近一条才是"当前服务"。
// markdown 围栏代码块(``` … ```)内的 URL 不检测:代码块常是示例/模板,
// 不是 agent 实际拉起的服务;行内 `code` 仍检测(agent 常用行内代码引用地址)。

/** 围栏代码块(未闭合的也算,流式渲染中途不误判块内 URL) */
const FENCED_BLOCK_RE = /```[\s\S]*?(?:```|$)/g;

// host 边界:后面不得跟主机名字符(挡 localhost.evil.com / localhosts)或 @(挡
// http://localhost@evil.com 这种 userinfo 伪造——真实 host 是 @ 后面那段)。
// 最终裁决仍在壳侧白名单,这里只决定 chip 出不出现。
const LOCALHOST_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?![\w.@-])(?::\d{1,5}(?![\w.@-]))?(?:\/[^\s<>"'`()[\]]*)?/gi;

/** 句读标点不算 URL 的一部分("见 http://localhost:3000。") */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/**
 * 检测文本中的 localhost URL,返回最后一条;没有则 null。
 * 主进程 preview:open 还会按同一白名单复核,这里只决定入口是否出现。
 */
export function detectLocalhostUrl(text: string): string | null {
  if (!text) return null;
  const stripped = text.replace(FENCED_BLOCK_RE, ' ');
  let last: string | null = null;
  for (const match of stripped.matchAll(LOCALHOST_URL_RE)) {
    last = match[0];
  }
  return last === null ? null : last.replace(TRAILING_PUNCT_RE, '');
}

/** chip 展示用的短标签:"http://localhost:3000/a" → "localhost:3000";解析失败回退原文 */
export function previewUrlLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 壳 preload 暴露的最小接口(可选;浏览器环境整个 desktop 不存在) */
export interface DesktopPreviewApi {
  open?: (url: string) => Promise<unknown>;
}

export interface DesktopPreviewBridge {
  preview?: DesktopPreviewApi;
}

/** 渲染门槛:preview.open 在才显示预览入口(与 resolveUsageApi 同模式)。 */
export function resolvePreviewApi(
  bridge: DesktopPreviewBridge | undefined,
): DesktopPreviewApi | undefined {
  const preview = bridge?.preview;
  if (typeof preview?.open === 'function') return preview;
  return undefined;
}
