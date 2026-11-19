import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// 只在正式建置時加上內容安全政策;開發模式的熱更新需要行內腳本
// nexus-file: 是對話圖片的受限讀檔協定;https: 只給使用者按了「載入圖片」的遠端圖片用,畫面不會自動載入
// media-src blob::語音模式播放合成語音、角色聲音的原音與試聽(都是主行程交給畫面的音訊,在畫面裡轉成 blob 網址)
const csp = (): Plugin => ({
  name: 'nexus-csp',
  apply: 'build',
  transformIndexHtml: html => html.replace(
    '<head>',
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: nexus-portrait: nexus-file: https:; media-src 'self' blob:; connect-src 'self' nexus-file:; worker-src 'self' blob:" />`,
  ),
});

export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [react(), csp()] },
});
