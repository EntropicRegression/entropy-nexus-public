import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// 只在正式建置時加上內容安全政策;開發模式的熱更新需要行內腳本
// nexus-file: 是對話圖片的受限讀檔協定;https: 只給使用者按了「載入圖片」的遠端圖片用,畫面不會自動載入
const csp = (): Plugin => ({
  name: 'nexus-csp',
  apply: 'build',
  transformIndexHtml: html => html.replace(
    '<head>',
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: nexus-portrait: nexus-file: https:; connect-src 'self' nexus-file:; worker-src 'self' blob:" />`,
  ),
});

export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [react(), csp()] },
});
