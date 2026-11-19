// 產生應用程式圖示 build/icon.png(512x512)。用法:npx electron tools/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const hex = (cx, cy, r) => Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 3) * i;
  return `${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`;
}).join(' ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="#12283a"/><stop offset="1" stop-color="#060a12"/></radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="96" fill="url(#bg)" stroke="#3fd8e6" stroke-opacity="0.45" stroke-width="4"/>
  <g stroke="#3fd8e6" stroke-opacity="0.08" stroke-width="2">
    ${[112, 176, 240, 304, 368].map(v => `<line x1="${v}" y1="40" x2="${v}" y2="472"/><line x1="40" y1="${v}" x2="472" y2="${v}"/>`).join('')}
  </g>
  <g filter="url(#glow)" fill="none" stroke-linejoin="round">
    <polygon points="${hex(256, 256, 168)}" stroke="#3fd8e6" stroke-width="14"/>
    <polygon points="${hex(256, 256, 112)}" stroke="#3fd8e6" stroke-opacity="0.45" stroke-width="6"/>
  </g>
  <g filter="url(#glow)">
    <polygon points="${hex(256, 170, 34)}" fill="#b48cff"/>
    <polygon points="${hex(182, 298, 34)}" fill="#5ce0a0"/>
    <polygon points="${hex(330, 298, 34)}" fill="#5cb8ff"/>
  </g>
  <g stroke="#d8f4f8" stroke-opacity="0.55" stroke-width="5">
    <line x1="256" y1="204" x2="198" y2="270"/><line x1="256" y1="204" x2="314" y2="270"/><line x1="216" y1="298" x2="296" y2="298"/>
  </g>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise(r => setTimeout(r, 500));
  const img = (await win.webContents.capturePage()).resize({ width: 512, height: 512 });
  const out = join(__dirname, '..', 'build');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'icon.png'), img.toPNG());
  console.log('icon', img.getSize());
  app.quit();
});
