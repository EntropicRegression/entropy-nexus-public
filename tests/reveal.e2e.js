// 回覆裡的路徑連結(點一下在檔案總管中顯示)。假資料模式,由 tests/reveal.sh 啟動:
// __TEST_CWD__ 是暫存版本庫裡的子資料夾 work/app(往上兩層有 docs/guide.md),用來檢查相對路徑的各種基準。
// 不會真的打開檔案總管:只檢查哪些文字會變成連結,以及找不到時的錯誤。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); }
    throw new Error(`等不到:${what}`);
  };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${detail}` : ''}`); };
  try {
    const cwd = window.__TEST_CWD__;
    await window.nexus.setAutopilot(false);
    const a = await window.nexus.createAgent({ name: 'Path', character: '', model: '', backend: 'claude', cwd, permissionMode: 'ask' });
    await until('節點待命', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id && x.state === 'idle'));

    const cases = [
      [true, '工作目錄裡的檔案', 'src/main.ts'],
      [true, '反斜線', 'src\\main.ts'],
      [true, '帶行號', 'src/main.ts:12'],
      [true, '帶行號與欄位', 'src/main.ts:12:5'],
      [true, '資料夾', 'src'],
      [true, '檔名有空白', 'src/my file.txt'],
      [true, '單一檔名', 'notes.md'],
      [true, '從版本庫根目錄寫的路徑', 'app/src/main.ts'],
      [true, '上層的資料夾', 'docs/guide.md'],
      [true, '絕對路徑', `${cwd}\\src\\main.ts`],
      [true, 'file 網址', `file:///${cwd.replace(/\\/g, '/')}/src/main.ts`],
      [true, 'file 網址帶行號片段', `file:///${cwd.replace(/\\/g, '/')}/src/main.ts#L12`],
      [true, 'file 網址(空白編碼)', `file:///${cwd.replace(/\\/g, '/')}/src/my%20file.txt`],
      [true, '相對連結(空白編碼與片段)', 'src/my%20file.txt#L3'],
      [false, '不存在的 file 網址', `file:///${cwd.replace(/\\/g, '/')}/src/nope.ts`],
      [false, '不存在', 'src/nope.ts'],
      [false, '上層的單一名稱', 'docs'],
      [false, '網址', 'https://example.com/src/main.ts'],
      [false, '網路路徑', '\\\\127.0.0.1\\c$\\Windows'],
      [false, '套件名稱', 'some-org/some-package'],
      [false, '一般程式碼', 'npm run build'],
      [false, '空字串', ''],
    ];
    for (const [want, label, text] of cases) {
      const got = await window.nexus.canReveal(a.id, text);
      expect(`${want ? '可點' : '不可點'} ${label}`, got === want, got === want ? '' : `${text} → ${got}`);
    }
    expect('不存在的節點', (await window.nexus.canReveal('nope', 'src/main.ts')) === false);
    expect('找不到時回報錯誤', await window.nexus.revealPath(a.id, 'src/nope.ts').then(() => false, () => true));

    // 對話視窗裡的呈現
    window.__nexusSelect('Path');
    await wait(600);
    await window.nexus.send(a.id, '圖片測試\n改了 `src/main.ts` 與 `src/nope.ts`,說明在 `docs/guide.md`,資料夾是 `src`,指令是 `npm run build`。\n\n- 清單裡的 `app/src/main.ts:12`');
    const links = await until('路徑變成連結', () => { const l = [...document.querySelectorAll('.md code.md-path')].map(e => e.textContent); return l.length >= 3 ? l : null; }, 15000).catch(() => [...document.querySelectorAll('.md code')].map(e => e.className + '|' + e.textContent).concat('對話視窗:' + !!document.querySelector('.dlg-portrait')));
    const plain = [...document.querySelectorAll('.md code:not(.md-path)')].map(e => e.textContent);
    expect('連結的項目', JSON.stringify(links) === JSON.stringify(['src/main.ts', 'docs/guide.md', 'app/src/main.ts:12']), JSON.stringify(links));
    // 沒有分隔符號也沒有副檔名的單一個字(例如 src)不當成連結,避免一般的單字被誤判
    expect('不是連結的項目', plain.includes('src/nope.ts') && plain.includes('npm run build') && plain.includes('src'), JSON.stringify(plain));
    // Markdown 連結(Antigravity 習慣把檔名寫成 [檔名](file:///路徑))
    const furl = `file:///${cwd.replace(/\\/g, '/')}/src/main.ts`;
    await window.nexus.send(a.id, `圖片測試
改了這些檔案:

- [src/main.ts](${furl})
- [\`notes.md\`](${furl.replace('src/main.ts', 'notes.md')}#L3)
- [相對](docs/guide.md)
- [不存在](${furl.replace('main.ts', 'nope.ts')})
- [網站](https://example.com/src/main.ts)`);
    const mdLinks = await until('連結變成可點', () => { const l = [...document.querySelectorAll('.md .md-link.md-path')].map(e => e.textContent); return l.length >= 3 ? l : null; }, 15000).catch(() => [...document.querySelectorAll('.md .md-link')].map(e => e.className + '|' + e.textContent));
    expect('可點的 Markdown 連結', JSON.stringify(mdLinks) === JSON.stringify(['src/main.ts', 'notes.md', '相對']), JSON.stringify(mdLinks));
    await wait(2500); // 等回覆生成完
    const dead = [...document.querySelectorAll('.md .md-link:not(.md-path)')].map(e => e.textContent);
    expect('不可點的 Markdown 連結', JSON.stringify(dead) === JSON.stringify(['不存在', '網站']), JSON.stringify(dead));
    document.title = 'SHOT:reveal'; await wait(900); document.title = 'SHOT:reveal-b'; await wait(900);
    log(bad ? `有 ${bad} 項不符` : '全部通過');
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
