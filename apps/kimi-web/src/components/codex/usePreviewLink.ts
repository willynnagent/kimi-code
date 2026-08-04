// F13(docs/11):本地网页预览入口的 URL 检测(纯函数,便于单测)。
// 从最新 assistant 文本中检测 localhost URL(http/https +
// localhost/127.0.0.1/[::1],可带端口与路径),取最后出现的一条——
// 对话里可能提到多个地址(迁移端口、对比环境),最近一条才是"当前服务"。
// markdown 围栏代码块(``` …```)内的 URL 不检测:代码块常是示例/模板,
// 不是 agent 实际拉起的服务;行内 `code` 仍检测(agent 常用行内代码引用地址)。
//
// 打开动作:window.open(url, '_blank', 'noopener')。桌面壳主窗口的
// setWindowOpenHandler 已有 http/https → 系统浏览器的白名单(M4 4.4),
// 浏览器版 kimi-web 则退化为新标签页,两端零 IPC。

/** 围栏代码块(未闭合的也算,流式渲染中途不误判块内 URL) */
const FENCED_BLOCK_RE = /```[\s\S]*?(?:```|$)/g;

// host 边界:后面不得跟主机名字符(挡 localhost.evil.com / localhosts)或 @(挡
// http://localhost@evil.com 这种 userinfo 伪造——真实 host 是 @ 后面那段)。
const LOCALHOST_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?![\w.@-])(?::\d{1,5}(?![\w.@-]))?(?:\/[^\s<>"'`()[\]]*)?/gi;

/** 句读标点不算 URL 的一部分("见 http://localhost:3000。") */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/**
 * 检测文本中的 localhost URL,返回最后一条;没有则 null。
 * 这是 chip 是否出现的唯一门槛——不再依赖壳侧 IPC。
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

/**
 * 在系统浏览器/新标签页打开预览地址。noopener 隔离 opener 句柄;桌面壳由
 * setWindowOpenHandler 的 http/https 白名单转交系统浏览器,浏览器版自然
 * 开新标签页。opener 参数可注入便于单测。
 */
export function openPreviewInBrowser(
  url: string,
  opener: Pick<Window, 'open'> = window,
): void {
  opener.open(url, '_blank', 'noopener');
}
