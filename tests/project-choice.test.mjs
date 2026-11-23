// 驗收:交辦時指定專案(src/main/project-choice.ts):ask_node / start_meeting 的 project 參數驗證、錯誤附可用清單、共用資料夾的軟提示。
// 用法:node --no-warnings tests/project-choice.test.mjs
import assert from 'node:assert/strict';
import { chooseProject, folderHint, projectList, uniqueProjects } from '../src/main/project-choice.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };

const known = uniqueProjects([
  { id: 'c:/work/star-app', name: 'star-app', git: true },
  { id: 'd:/other/app', name: 'app', git: true },
  { id: 'c:/more/app', name: 'app' },
  { id: 'c:/shared/test', name: 'test', git: false },
  { id: 'c:/work/star-app', name: 'star-app' }, // 重複:去掉
  { id: '', name: '沒有 ID' }, // 沒有 ID:去掉
]);

test('已知專案依 ID 去重,依名稱排序', () => {
  assert.deepEqual(known.map(p => p.id), ['c:/more/app', 'd:/other/app', 'c:/work/star-app', 'c:/shared/test']);
  assert.equal(known.find(p => p.id === 'c:/work/star-app').git, true);
});

test('可以填 ID(斜線、大小寫、結尾斜線都容許)或名稱(不分大小寫)', () => {
  assert.equal(chooseProject('c:/work/star-app', known).project.id, 'c:/work/star-app');
  assert.equal(chooseProject('C:\\Work\\Star-App\\', known).project.id, 'c:/work/star-app');
  assert.equal(chooseProject('STAR-APP', known).project.id, 'c:/work/star-app');
  assert.equal(chooseProject('  test ', known).project.git, false);
});

test('名稱對到好幾個專案時要求改用 ID,並列出那幾個', () => {
  const r = chooseProject('app', known);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('有 2 個專案都叫「app」') && r.error.includes('d:/other/app') && r.error.includes('c:/more/app') && !r.error.includes('star-app'), r.error);
});

test('不認得的專案回錯誤並附全部可用清單;空字串也是錯誤', () => {
  const r = chooseProject('不存在', known);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('不認得專案「不存在」'), r.error);
  for (const p of known) assert.ok(r.error.includes(p.id), p.id);
  assert.ok(r.error.includes('test(共用資料夾)') && r.error.includes('star-app(git)'), r.error);
  assert.equal(chooseProject('   ', known).ok, false);
  assert.ok(projectList([]).includes('沒有已知的專案'));
});

test('軟提示:只有接手節點在共用的非 git 資料夾時才有;git 或不確定時沒有', () => {
  assert.ok(folderHint({ id: 'c:/shared/test', name: 'test', git: false }).includes('未指定專案,將記到該節點的資料夾〈test〉'));
  assert.equal(folderHint({ id: 'c:/work/star-app', name: 'star-app', git: true }), '');
  assert.equal(folderHint({ id: 'c:/x', name: 'x' }), '', '還不知道是不是 git:不提醒');
  assert.equal(folderHint(null), '');
});

console.log(`通過 ${passed} 項`);
