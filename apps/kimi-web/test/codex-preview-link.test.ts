import { describe, expect, it, vi } from 'vitest';

import {
  detectLocalhostUrl,
  openPreviewInBrowser,
  previewUrlLabel,
} from '../src/components/codex/usePreviewLink';

// F13(docs/11):会话文本中 localhost URL 检测——chip"预览 localhost:3000"的
// 数据源。规则:仅 http(s) + localhost/127.0.0.1/[::1];多条取最近;围栏
// 代码块内不检测(行内 code 仍检测)。打开动作 = window.open 新标签,壳侧
// setWindowOpenHandler 白名单转交系统浏览器,浏览器版退化为新标签页。

describe('detectLocalhostUrl', () => {
  it('检测 localhost / 127.0.0.1 / [::1](含端口与路径)', () => {
    expect(detectLocalhostUrl('服务已启动: http://localhost:3000')).toBe(
      'http://localhost:3000',
    );
    expect(detectLocalhostUrl('see http://127.0.0.1:8080/app for the demo')).toBe(
      'http://127.0.0.1:8080/app',
    );
    expect(detectLocalhostUrl('listening on http://[::1]:5173/')).toBe('http://[::1]:5173/');
    expect(detectLocalhostUrl('https://localhost 也可以')).toBe('https://localhost');
  });

  it('多条 URL 取最近一条', () => {
    expect(
      detectLocalhostUrl('先起了 http://localhost:3000,后来迁到 http://localhost:4000'),
    ).toBe('http://localhost:4000');
    expect(
      detectLocalhostUrl('http://localhost:3000 和 http://127.0.0.1:8080 都在跑'),
    ).toBe('http://127.0.0.1:8080');
  });

  it('非 localhost 地址不检测', () => {
    expect(detectLocalhostUrl('见 https://example.com/docs')).toBe(null);
    expect(detectLocalhostUrl('http://192.168.1.10:3000 局域网')).toBe(null);
    expect(detectLocalhostUrl('http://localhost.evil.com 伪造')).toBe(null);
    expect(detectLocalhostUrl('http://localhost@evil.com userinfo 伪造')).toBe(null);
    expect(detectLocalhostUrl('ftp://localhost:21 不是 http')).toBe(null);
    expect(detectLocalhostUrl('localhost:3000 没有 scheme')).toBe(null);
    expect(detectLocalhostUrl('')).toBe(null);
  });

  it('围栏代码块内的 URL 不检测', () => {
    expect(
      detectLocalhostUrl('配置示例:\n```\nhttp://localhost:3000\n```\n改完重启即可'),
    ).toBe(null);
  });

  it('代码块之后的正文 URL 仍检测(块内不误判、块外不受影响)', () => {
    expect(
      detectLocalhostUrl('```\nhttp://localhost:9999\n```\n实际服务在 http://localhost:3000'),
    ).toBe('http://localhost:3000');
  });

  it('行内 code 中的 URL 仍检测(agent 常用行内代码引用地址)', () => {
    expect(detectLocalhostUrl('打开了 `http://localhost:3000` 验证一下')).toBe(
      'http://localhost:3000',
    );
  });

  it('markdown 链接中的 localhost URL 可检测,末尾标点不算 URL', () => {
    expect(detectLocalhostUrl('预览见 [demo](http://localhost:3000)。')).toBe(
      'http://localhost:3000',
    );
    expect(detectLocalhostUrl('访问 http://localhost:3000, 然后刷新.')).toBe(
      'http://localhost:3000',
    );
  });
});

describe('previewUrlLabel', () => {
  it('取 host:port 作为 chip 标签', () => {
    expect(previewUrlLabel('http://localhost:3000/app')).toBe('localhost:3000');
    expect(previewUrlLabel('https://127.0.0.1:8443')).toBe('127.0.0.1:8443');
    expect(previewUrlLabel('http://[::1]:5173/')).toBe('[::1]:5173');
    expect(previewUrlLabel('http://localhost')).toBe('localhost');
  });

  it('解析失败回退原文', () => {
    expect(previewUrlLabel('not a url')).toBe('not a url');
  });
});

describe('openPreviewInBrowser', () => {
  it('以 _blank + noopener 调用 window.open(壳侧 setWindowOpenHandler 交系统浏览器)', () => {
    const open = vi.fn();
    openPreviewInBrowser('http://localhost:3000/app', { open } as unknown as Window);
    expect(open).toHaveBeenCalledWith('http://localhost:3000/app', '_blank', 'noopener');
  });
});
