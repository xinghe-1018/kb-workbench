'use strict';
/*
 * 渲染层测试：用 DOM 垫片 + obsidian 桩，真正跑一遍
 * KbWorkbenchPlugin.onload() 与 WorkbenchView.render()，
 * 断言 14 张卡片、任务行、目录树、统计格子、弹框与手势都真的渲染出来。
 * 只读，不写笔记库。运行：node test/render-harness.js
 */

const Module = require('module');
const path = require('path');

const stubPath = path.join(__dirname, 'obsidian-stub.js');
const dom = require('./dom-shim.js');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return stubPath;
  return origResolve.call(this, request, ...rest);
};

const stub = require(stubPath);
// 让桩里的 Modal 用真垫片元素建 contentEl，测试才能驱动确认框（月历点空白日期会先问标题）
stub.Modal.__makeEl = (tag) => new dom.El(tag);

/* --- 全局补丁：Obsidian 里由 Electron 提供 --- */
const fakeContentRoot = dom.createRoot();
global.window = {
  setInterval: () => 0, clearInterval: () => {}, setTimeout: (f) => f(),
  matchMedia: () => ({ matches: false }), innerWidth: 1200,
};
global.document = {
  activeElement: null,
  createElement: (t) => new dom.El(t),
  _l: {},
  addEventListener(t, cb) { (this._l[t] = this._l[t] || []).push(cb); },
  removeEventListener(t, cb) { this._l[t] = (this._l[t] || []).filter((x) => x !== cb); },
  count(t) { return (this._l[t] || []).length; },
};

/* rAF：默认立即执行（兼容旧断言）；rafMode='manual' 时排队，由 flushFrames() 驱动。
   手势按帧批处理这件事，只有排队模式才量得出来。 */
let rafSeq = 0;
let rafQueue = [];
let rafMode = 'auto';
global.requestAnimationFrame = (cb) => {
  const id = ++rafSeq;
  if (rafMode === 'auto') cb();
  else rafQueue.push([id, cb]);
  return id;
};
global.cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter(([i]) => i !== id); };
function flushFrames() {
  const q = rafQueue; rafQueue = [];
  q.forEach(([, cb]) => cb());
  return q.length;
}

// 把垫片方法挂到 stub 的 View 上（真实的 View 自带这些扩展）
const ViewProto = stub.ItemView.prototype;
Object.defineProperty(ViewProto, 'contentEl', {
  get() { return this.__contentEl || (this.__contentEl = dom.createRoot()); },
  set(v) { this.__contentEl = v; },
  configurable: true,
});

/* --- 假库 --- */
const pad = (n) => (n < 10 ? '0' + n : String(n));
const now = new Date();
const TODAY = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());

/* 月历用例的探针日（写死的几号）。
   这些日子必须【避开今天】：[39] 开头会给"今天"建一篇日记（todayPath），
   探针日一旦等于今天，"空白日期"就不再空白 —— 2026-11-05 早上就红在这里
   （前一天今天是 4 号，5 号是空的；这天今天就是 5 号，于是点 5 号弹的是"已建几篇"）。
   PD(n) 把撞上今天的那个探针日挪到一个既不在探针表里、也不是今天的日子，其余原样。 */
const CAL_PROBE_DAYS = [5, 12, 19, 20, 24, 25, 26];
const PD_ALT = (() => {
  for (let d = 1; d <= 28; d++) {
    if (CAL_PROBE_DAYS.indexOf(d) < 0 && d !== now.getDate()) return d;
  }
  return 28;
})();
const PD = (n) => (n === now.getDate() ? PD_ALT : n);

const contents = new Map();
const filesByPath = new Map();

function mkFile(p, content, mtime) {
  const f = new stub.TFile(p);
  const t = mtime === undefined ? Date.now() : mtime;
  f.stat = { ctime: t, mtime: t, size: Buffer.byteLength(content, 'utf8') };
  filesByPath.set(p, f);
  contents.set(p, content);
  return f;
}

mkFile('实习/讲解待办/REA介绍与DSH接入判断.md', [
  '## 一、它是什么',
  '- [ ] 补充 REA 的对比表 📅' + TODAY,
  '- [x] 写资料包 ✅' + TODAY,
  '#todo 后补一节',
].join('\n'), Date.now() - 120000);

mkFile('实习/学习文档(md)/LLM Wiki介绍与本机实践.md', [
  '## 结论',
  '这里提到 knowledge base 与 workbench 关键词。',
  '- [ ] 校对星数 📅2020-01-01',
].join('\n'), Date.now() - 600000);

mkFile('每周AI消息汇总/2026-W45.md', [
  '| 项目 | 星数 |',
  '| --- | --- |',
  '| x | 1 |',
  '#周报 框选多选要用两个标签才测得出交集',
].join('\n'), Date.now() - 3600000);

mkFile('附件/图.png', 'bin', Date.now());

function buildCache(content) {
  const lines = content.split('\n');
  const listItems = [], headings = [], tags = [];
  let offset = 0;
  const offsets = lines.map((l) => { const o = offset; offset += l.length + 1; return o; });
  lines.forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) headings.push({ heading: h[2].trim(), level: h[1].length, position: { start: { line: i, col: 0, offset: offsets[i] }, end: { line: i, col: line.length, offset: offsets[i] + line.length } } });
    const t = line.match(/^(\s*)([-*+])[ \t]\[( |x|X|-)\]/);
    if (t) listItems.push({ task: t[3], parent: -1, position: { start: { line: i, col: 0, offset: offsets[i] }, end: { line: i, col: line.length, offset: offsets[i] + line.length } } });
    const re = /#([\p{L}\p{N}_\-/]+)/gu;
    let m;
    while ((m = re.exec(line)) !== null) tags.push({ tag: '#' + m[1], position: { start: { line: i, col: m.index, offset: 0 }, end: { line: i, col: m.index + 1, offset: 1 } } });
  });
  return { listItems, headings, tags, sections: [] };
}

const diskExtra = [];          // 全盘扫描用的"磁盘视图"里额外塞的文件（没被 Obsidian 索引的那些）
const vault = {
  configDir: '.obsidian',
  adapter: {
    exists: async () => false,
    read: async (p) => contents.get(stub.normalizePath(p)) || '',
    // 全盘扫描走文件系统而不是索引：返回 filesByPath + diskExtra，
    // diskExtra 只进 contents 不进 filesByPath ⇒ 天然就是"磁盘上有、索引里没有"
    // 真机实测（Obsidian 1.15）：adapter.list('/', true) 只回了**这一层**，recursive 标志没被遵守。
    // 夹具照这个来：只给当前一层的文件 + 子目录，逼插件自己下钻。root 的 '/' 与 '' 都表示库根。
    list: async (root) => {
      for (const x of diskExtra) if (!contents.has(x.path)) contents.set(x.path, x.text || '');
      const all = Array.from(filesByPath.keys()).concat(diskExtra.map((x) => x.path));
      const r = String(root || '').replace(/^\/+|\/+$/g, '');
      const files = []; const folders = new Set();
      for (const p of all) {
        let relTo;
        if (!r) relTo = p;
        else if (p === r || p.indexOf(r + '/') === 0) relTo = p.slice(r.length + 1);
        else continue;
        if (!relTo) continue;
        const sl = relTo.indexOf('/');
        if (sl < 0) files.push(p);
        else folders.add(r ? r + '/' + relTo.slice(0, sl) : relTo.slice(0, sl));
      }
      return { files, folders: Array.from(folders) };
    },
  },
  getFiles: () => Array.from(filesByPath.values()),
  getMarkdownFiles: () => Array.from(filesByPath.values()).filter((f) => f.extension === 'md'),
  getFileByPath: (p) => filesByPath.get(stub.normalizePath(p)) || null,
  getFolderByPath: () => null,
  getAbstractFileByPath: (p) => filesByPath.get(stub.normalizePath(p)) || null,
  cachedRead: async (f) => contents.get(f.path) || '',
  process: async (f, fn) => { const out = fn(contents.get(f.path)); contents.set(f.path, out); return out; },
  create: async (p, data) => mkFile(stub.normalizePath(p), data, Date.now()),
  createFolder: async () => {},
  // 事件注册必须是【真的】：以前这里是 on: () => ({})，把 create/modify/delete/rename 全吞掉，
// 于是「rename 接线」这类 bug 在 600 多条测试里永远绿（和第二十三轮那个假 Modal 同一类错）。
  _ev: {},
  on(name, cb) { (this._ev[name] = this._ev[name] || []).push(cb); return { name }; },
  off() {},
  trigger(name, ...args) { (this._ev[name] || []).forEach((cb) => cb(...args)); return this; },
};

let capturedCreator = null;
let openedPaths = [];

const app = {
  vault,
  metadataCache: { getFileCache: (f) => buildCache(contents.get(f.path) || ''), on: () => ({}) },
  workspace: {
    on: () => ({}),
    onLayoutReady: (cb) => cb(),
    getLeavesOfType: () => [],
    getLeaf: () => ({
      setViewState() {},
      openFile: async (f, state) => { openedPaths.push({ path: f.path, state }); },
      view: { setEphemeralState() {} },
    }),
    revealLeaf: async () => {},
    detachLeavesOfType() {},
    getActiveViewOfType: () => null,
    // 工作台停靠左侧栏会走这个 API（Obsidian 公开方法）
    ensureSideLeaf: (type, side, opts) => {
      app.__lastSide = { type, side, opts };
      return {
        setViewState() {},
        openFile: async () => {},
        view: { setEphemeralState() {} },
        containerEl: { closest: () => ({}) },
      };
    },
  },
  plugins: { getPlugin: () => null },
  setting: { open() {}, openTabById() {} },
};

let pass = 0, fail = 0;
const visHit = (a, b) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, label) { ok(a === b, label, { actual: a, expected: b }); }

(async () => {
  const KbWorkbenchPlugin = require(process.env.KBWB_MAIN || path.join(__dirname, '..', 'main.js'));
  const plugin = new KbWorkbenchPlugin(app, { id: 'kb-workbench' });
  plugin.loadData = async () => null;
  plugin.registerView = (type, creator) => { capturedCreator = creator; };
  plugin.registerEvent = () => ({});
  plugin.registerInterval = (id) => id;
  plugin.addSettingTab = () => {};
  plugin.addRibbonIcon = () => ({ addEventListener() {} });
  plugin.addCommand = () => ({});

  console.log('\n[1] onload 真跑');
  await plugin.onload();
  ok(!!capturedCreator, 'onload 里调用了 registerView');
  ok(plugin.settings.recentCount === 8, '设置已加载');
  ok(!!app.__lastSide, '启动时调用了 ensureSideLeaf（停靠侧栏）');
  eq(app.__lastSide && app.__lastSide.side, 'left', '默认停在左侧栏');
  eq(app.__lastSide && app.__lastSide.type, 'kb-workbench-view', '停靠的是工作台视图');

  console.log('\n[2] 视图创建与渲染');
  const view = capturedCreator({ app });
  ok(!!view, '视图工厂返回视图对象');
  view.app = app;
  const root = dom.createRoot();
  view.__contentEl = root;
  view.containerEl = {
    addClass() {}, isConnected: true, empty() {},
    style: { setProperty() {}, removeProperty() {} },
  };
  await view.render();

  const text = root.textContent;
  ok(text.includes('工作台'), '顶部条渲染「工作台」');
  ok(text.includes(TODAY.slice(0, 4) + '年'), '顶部条渲染日期');

  const cardNames = root.findAll('.kbwb-card-name').map((e) => e.textContent);
  eq(cardNames.length, 14, '渲染出 14 张卡片（原 8 张 + 第二十轮 5 张 + 第三十二轮「待办」）', cardNames);
  for (const name of ['搜索笔记', '快捷新建', '收藏', '最近', '任务', '知识库', '库统计', '笔记体检',
                      '到期日历', '速记本', '标签总览', '月历', '写作量', '待办']) {
    ok(cardNames.includes(name), '卡片存在：' + name, cardNames);
  }

  console.log('\n[3] 搜索卡');
  // 第二十轮起「速记本」「标签总览」也各有输入框，root 级 findAll('.kbwb-input')[0]
  // 是"碰巧"命中搜索框的（DOM 顺序），一旦布局顺序变了就会测错卡。一律按卡定位。
  const cardOf = (id) => root.findAll('.kbwb-card').find((x) => x.dataset.mod === id);
  ok(!!cardOf('search'), '搜索卡在 DOM 里');
  const input = cardOf('search').findAll('.kbwb-input')[0];
  ok(!!input, '搜索输入框存在');
  ok((input.getAttr('placeholder') || '').includes('搜索'), '输入框有占位提示');

  console.log('\n[4] 快捷新建按钮');
  const btns = root.findAll('.kbwb-btn').map((e) => e.textContent);
  ok(btns.some((t) => t.includes('今日笔记')), '有「今日笔记」按钮', btns);
  ok(btns.some((t) => t.includes('新建笔记')), '有「新建笔记」按钮', btns);
  ok(btns.some((t) => t.includes('从模板新建')), '有「从模板新建」按钮', btns);

  console.log('\n[5] 任务卡');
  if (process.env.KBWB_DEBUG) {
    const dbg = await plugin.collectTasks();
    console.log('  DEBUG count=' + dbg.length + ' scope=' + JSON.stringify(plugin.settings.taskScope) + ' filter=' + plugin.settings.taskFilter);
    console.log('  DEBUG tasks=' + JSON.stringify(dbg.map((t) => [t.file.path, t.line, t.done, t.body.slice(0, 18), t.markers.due])));
    console.log('  DEBUG mdfiles=' + JSON.stringify(vault.getMarkdownFiles().map((f) => f.path)));
    console.log('  DEBUG rows:', root.findAll('.kbwb-task').map((r) => r.textContent.slice(0, 40)));
    console.log('  DEBUG task chip:', root.findAll('.kbwb-chip').map((r) => r.textContent));
  }
  // 「到期日历」渲染的也是 .kbwb-task 行，所以任务卡的断言必须限定在任务卡里量
  const tasksCardEl = cardOf('tasks');
  ok(!!tasksCardEl, '任务卡在 DOM 里');
  const tabs = tasksCardEl.findAll('.kbwb-tab');
  ok(tabs.length >= 4, '任务筛选标签渲染', tabs.map((t) => t.textContent));
  const taskRows = tasksCardEl.findAll('.kbwb-task');
  ok(taskRows.length === 2, '任务卡渲染出 2 条未完成任务行', taskRows.map((r) => r.textContent.slice(0, 20)));
  ok(tasksCardEl.findAll('.kbwb-task-file').length === 2, '任务按文件分组（两个文件）');
  const overdueRow = taskRows.find((r) => r.textContent.includes('校对星数'));
  ok(!!overdueRow && overdueRow.hasClass('is-overdue'), '逾期任务有 is-overdue 样式', overdueRow && overdueRow.classes());

  // 点一下「逾期」标签，看筛选是否生效
  const overdueTab = tabs.find((t) => t.dataset.f === 'overdue');
  ok(!!overdueTab, '存在「逾期」标签');
  overdueTab.click();
  const afterFilter = tasksCardEl.findAll('.kbwb-task').map((r) => r.textContent);
  ok(afterFilter.length === 1 && afterFilter[0].includes('校对星数'), '切到「逾期」只剩逾期任务', afterFilter);

  console.log('\n[6] 勾选任务自动回写');
  const box = tasksCardEl.findAll('.kbwb-checkbox')[0];
  ok(!!box, '任务卡里存在复选框');
  const targetBefore = contents.get('实习/学习文档(md)/LLM Wiki介绍与本机实践.md');
  box.click();
  await new Promise((r) => setImmediate(r));
  const targetAfter = contents.get('实习/学习文档(md)/LLM Wiki介绍与本机实践.md');
  ok(targetBefore !== targetAfter, '点击复选框后笔记被改写');
  ok(/- \[x\] 校对星数/.test(targetAfter), '任务行变成已完成', targetAfter.split('\n').filter((l) => l.includes('校对星数')));

  console.log('\n[7] 目录树');
  const folders = root.findAll('.kbwb-folder').map((f) => f.textContent);
  ok(folders.some((t) => t.startsWith('实习')), '顶层目录「实习」', folders);
  ok(folders.some((t) => t.includes('每周AI消息汇总')), '顶层目录「每周AI消息汇总」', folders);
  // 展开「实习」：应出现子分区 讲解待办 / 学习文档(md)
  const before = root.findAll('.kbwb-folder').length;
  const shiXi = root.findAll('.kbwb-folder').find((f) => f.textContent.startsWith('实习'));
  shiXi.click();
  const afterFolders = root.findAll('.kbwb-folder').map((f) => f.textContent);
  ok(root.findAll('.kbwb-folder').length > before, '展开后目录行变多', { before, after: afterFolders.length });
  ok(afterFolders.some((t) => t.includes('讲解待办')), '展开后出现子分区「讲解待办」', afterFolders);
  // 再展开一层子分区「讲解待办」：应列出该目录下的笔记
  const jiangJie = root.findAll('.kbwb-folder').find((f) => f.textContent.startsWith('讲解待办'));
  ok(!!jiangJie, '子分区「讲解待办」可点击');
  jiangJie.click();
  const leaves = root.findAll('.kbwb-fileleaf').map((e) => e.textContent);
  ok(leaves.length >= 1, '二级展开后列出文件夹内的笔记', leaves);
  ok(leaves.some((t) => t.includes('REA')), '列出 REA 笔记', leaves);

  console.log('\n[8] 统计卡');
  const stats = root.findAll('.kbwb-stat-v').map((e) => e.textContent);
  ok(stats.length >= 6, '统计格子 ≥ 6', stats);
  ok(stats.includes('3'), 'Markdown 笔记数为 3', stats);
  ok(root.findAll('.kbwb-tag').length >= 1, '标签云渲染');
  ok(root.findAll('.kbwb-bar-row').length >= 2, '分区条形图渲染', root.findAll('.kbwb-bar-row').length);

  console.log('\n[9] 收藏交互');
  const star = root.findAll('.kbwb-star')[0];
  ok(!!star, '笔记行有收藏星标');
  star.click();
  ok(plugin.pinnedPaths().length === 1, '点击星标写入收藏', plugin.pinnedPaths());
  await view.render();
  ok(root.textContent.includes('收藏'), '重渲染后收藏卡在');
  ok(root.findAll('.kbwb-card-name').some((e) => e.textContent === '收藏'), '重渲染成功（幂等）');

  console.log('\n[10] 搜索交互');
  const input2 = cardOf('search').findAll('.kbwb-input')[0];
  input2.value = '星数';
  view.searchText = '星数';
  await view.runSearch();
  const res = root.findAll('.kbwb-res').map((e) => e.textContent);
  ok(res.length >= 1, '搜索「星数」有结果', res);
  ok(res.some((t) => t.includes('每周AI消息汇总')), '命中正文所在的笔记', res);

  console.log('\n[11] 连续刷新不残影');
  await view.render();
  await view.render();
  eq(root.findAll('.kbwb-card-name').length, 14, '多次渲染卡片数不变（无重复堆叠）');

  console.log('\n[12] 悬停特效开关（文字发糊的兜底开关）');
  ok(!root.classList.contains('kbwb-no-fx'), '默认开启特效时不带 kbwb-no-fx');
  plugin.settings.hoverFx = false;
  await view.render();
  ok(root.classList.contains('kbwb-no-fx'), '关掉特效后容器带 kbwb-no-fx');
  plugin.settings.hoverFx = true;
  await view.render();
  ok(!root.classList.contains('kbwb-no-fx'), '再打开时类名被移除');
  eq(root.findAll('.kbwb-card-name').length, 14, '开关切换不影响卡片数量');

  console.log('\n[13] 自由网格：坐标落地 + 骨架条消失');
  await plugin.setModuleOn('pinned', false);
  await view.render();
  let names = root.findAll('.kbwb-card-name').map((e) => e.textContent);
  ok(!names.includes('收藏'), '隐藏后卡片不再渲染', names);
  const hiddenBar = root.findAll('.kbwb-hidden');
  eq(hiddenBar.length, 1, '出现隐藏模块回收条');
  ok(hiddenBar[0].textContent.includes('收藏'), '回收条里能看到被隐藏的模块名', hiddenBar[0].textContent);
  ok(/span \d+/.test(hiddenBar[0].style.gridColumn) || hiddenBar[0].style.gridColumn === '1 / -1', '回收条显式占满一行', hiddenBar[0].style.gridColumn);
  ok(parseInt(hiddenBar[0].style.gridRow, 10) > 1, '回收条排在所有卡之下', hiddenBar[0].style.gridRow);
  const restoreChip = hiddenBar[0].findAll('.kbwb-hidden-chip').find((c) => c.textContent.includes('收藏'));
  ok(!!restoreChip, '回收条有可点的恢复按钮');
  restoreChip.click();
  await view.render();
  names = root.findAll('.kbwb-card-name').map((e) => e.textContent);
  ok(names.includes('收藏'), '点一下即恢复显示', names);

  // 用户报的 bug：任务卡顶部骨架条一直没消失
  eq(root.findAll('.kbwb-skeleton').length, 0, '渲染完成后不留任何骨架条（任务卡"一直加载"的回归）');

  // 坐标写进内联样式，网格才谈得上"随意摆放"
  const cardsWithPos = root.findAll('.kbwb-card').filter((c) => /span \d+/.test(c.style.gridColumn) && /span \d+/.test(c.style.gridRow));
  eq(cardsWithPos.length, 14, '14 张卡都带显式 grid 坐标');
  const tasksCard = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'tasks');
  const beforePos = tasksCard.style.gridColumn + ' @ ' + tasksCard.style.gridRow;
  await plugin.setBox('tasks', { col: 1, row: 1 });
  await view.render();
  const tasksCard2 = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'tasks');
  eq(tasksCard2.style.gridColumn, '1 / span 32', 'setBox 改列后内联样式跟着变');
  eq(tasksCard2.style.gridRow, '1 / span 30', 'setBox 改行后内联样式跟着变');
  ok(beforePos !== tasksCard2.style.gridColumn + ' @ ' + tasksCard2.style.gridRow, '位置确实变了', beforePos);

  await plugin.setBox('tasks', { w: 48, h: 40 });
  await view.render();
  const tasksCard3 = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'tasks');
  eq(tasksCard3.style.gridColumn, '1 / span 48', '宽度可放大到满宽');
  eq(tasksCard3.style.gridRow, '1 / span 40', '高度可自由调整');

  await plugin.resetLayout();
  await plugin.setBox('stats', { col: 3, row: 3 });
  await plugin.tidyLayout();
  const boxes = plugin.layoutList().map((s) => [s.col, s.row, s.w, s.h]);
  const overlap = [];
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const [c1, r1, w1, h1] = boxes[a], [c2, r2, w2, h2] = boxes[b];
      if (c1 < c2 + w2 && c2 < c1 + w1 && r1 < r2 + h2 && r2 < r1 + h1) overlap.push([a, b]);
    }
  }
  eq(overlap.length, 0, '自动排列后没有任何两卡重叠', overlap);

  console.log('\n[14] CSS 选择器依赖的 data-mod 属性');
  await plugin.resetLayout();
  await view.render();
  const mods = root.findAll('.kbwb-card').map((c) => c.dataset.mod);
  eq(mods.join(','), ['search', 'quick', 'pinned', 'recent', 'tasks', 'nav', 'stats', 'hygiene',
                       'due', 'scratch', 'tags', 'calendar', 'writing', 'todos'].join(','),
    '每张卡都带 data-mod（漏了它，[data-mod=stats] 的高度放宽规则会静默失效）');

  console.log('\n[15] 点标签转搜索不应弹回原位');
  plugin.statsCache = null;
  await view.render();
  const tagEl = root.findAll('.kbwb-tag')[0];
  ok(!!tagEl, '统计卡里有标签胶囊');
  root.scrollTop = 300;
  tagEl.click();
  eq(view.jumpToSearch, true, '点击后立起"跳到搜索"标记（不再还原滚动）');
  for (let i = 0; i < 40 && view.rendering; i++) await new Promise((r) => setImmediate(r));
  eq(view.jumpToSearch, false, '标记在渲染结束时被消费');
  ok(!!view.searchCardEl, '记住了搜索卡元素，可滚到它');
  eq(view.searchText, tagEl.textContent.split(' · ')[0], '搜索词已填入');

  console.log('\n[16] 折叠：保留头部但不扫描内容');
  await plugin.setCollapsed('stats', true);
  await view.render();
  const names2 = root.findAll('.kbwb-card-name').map((e) => e.textContent);
  ok(names2.includes('库统计'), '折叠的模块仍在（保留头部）');
  const collapsedStats = root.findAll('.kbwb-card').find((x) => x.dataset.mod === 'stats');
  ok(collapsedStats.find('.kbwb-collapsed-body') !== null, '折叠态显示占位提示');
  eq(collapsedStats.findAll('.kbwb-stat').length, 0, '折叠后不渲染统计格（省算力）');
  await plugin.setCollapsed('stats', false);
  await view.render();

  console.log('\n[17] 侧栏窄到放不下 12 列时退化成单列');
  root.clientWidth = 320;
  await view.render();
  const narrowCards = root.findAll('.kbwb-card');
  ok(narrowCards.every((c) => /1 \/ span 48/.test(c.style.gridColumn)), '每张卡都占满 48 栏', narrowCards.map((c) => c.style.gridColumn));
  const rows = narrowCards.map((c) => parseInt(c.style.gridRow, 10));
  ok(rows.every((r, i) => i === 0 || r > rows[i - 1]), '行号单调递增 = 依次堆叠不重叠', rows);
  const bar2 = root.findAll('.kbwb-hidden');
  ok(!bar2.length || parseInt(bar2[0].style.gridRow, 10) > Math.max.apply(null, rows), '回收条排在最后', bar2.length && bar2[0].style.gridRow);
  delete root.clientWidth;
  await view.render();
  const wide = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned');
  ok(!/1 \/ span 48/.test(wide.style.gridColumn), '回到宽面板后恢复用户自己的坐标', wide.style.gridColumn);

  console.log('\n[18] 拖动手势：过程零重排、期间拒绝重绘、松手才落位');
  await plugin.resetLayout();
  await view.render();
  const pinnedEl = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned');
  ok(!pinnedEl.find('.kbwb-dragbar'), '没有居中小抓手了（第二十一轮按用户要求整个去掉）');
  ok(!!pinnedEl.find('.kbwb-card-head'), '拖动入口是整条卡片标题栏');
  eq(['kbwb-edge-r', 'kbwb-edge-b', 'kbwb-edge-corner'].filter((k) => pinnedEl.findAll('.' + k).length).length,
    3, '右/下/角三条缩放手柄都在');

  const mkEv = (x, y) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
  const slot0 = plugin.slotOf('pinned');
  const posBefore = pinnedEl.style.gridColumn + '|' + pinnedEl.style.gridRow;
  view.beginGesture('move', mkEv(200, 200), pinnedEl, 'pinned', slot0);
  ok(!!view.gesture, '手势已建立');
  const colW = view.gesture.colW;
  view.onGestureMove(mkEv(200 - colW * 2, 200 + 8 * 3));
  ok(/translate/.test(pinnedEl.style.transform || ''), '位移只写 transform', pinnedEl.style.transform);
  eq(pinnedEl.style.gridColumn + '|' + pinnedEl.style.gridRow, posBefore, '拖动过程中 grid 坐标没变（不重排 = 不卡）');
  ok(!!view.ghost, '落点虚影已生成');
  await view.render();
  eq(view.pendingRender, true, '手势期间的重绘被挂起（这就是"回到原位"的防线）');
  const moveListeners = document.count('pointermove');
  await view.onGestureEnd();
  eq(document.count('pointermove'), moveListeners - 1, 'pointermove 监听已摘除');
  eq(document.count('pointerup'), 0, 'pointerup 监听已摘除');
  eq(view.gesture, null, '手势状态已清空');
  const slot1 = plugin.slotOf('pinned');
  eq(slot1.col, slot0.col - 2, '松手后列坐标才写入');
  eq(slot1.row, slot0.row + 3, '松手后行坐标才写入');
  for (let i = 0; i < 60 && view.rendering; i++) await new Promise((r) => setImmediate(r));
  eq(view.pendingRender, false, '挂起的重绘已补做');
  eq(pinnedEl.style.transform || '', '', 'transform 已清除');

  // 越界要被夹住：16 栏宽的卡（48 栏制）最多只能从第 33 列开始
  const settle = async () => {
    for (let i = 0; i < 80 && (view.rendering || view.pendingRender); i++) await new Promise((r) => setImmediate(r));
  };
  await settle();
  await view.render();
  await settle();
  const pinnedEl2 = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned');
  ok(!!pinnedEl2, '等重绘完成后可重新拿到收藏卡', root.findAll('.kbwb-card').map((c) => c.dataset.mod));
  const s2 = plugin.slotOf('pinned');
  view.beginGesture('move', mkEv(0, 0), pinnedEl2, 'pinned', s2);
  view.onGestureMove(mkEv(colW * 9, 0));
  await view.onGestureEnd();
  await settle();
  const s3 = plugin.slotOf('pinned');
  ok(s3.col + s3.w <= 49, '拖不出网格右边界（自动夹住）', s3);

  console.log('\n[19] 缩放：拖边改宽、拖角改宽高');
  await plugin.resetLayout();
  await view.render();
  const navEl = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'nav');
  const nav0 = plugin.slotOf('nav');
  view.beginGesture('resize', mkEv(300, 300), navEl, 'nav', nav0, 'x');
  view.onGestureMove(mkEv(300 + colW * 2, 300));
  eq(navEl.style.gridColumn, nav0.col + ' / span ' + (nav0.w + 2), '拖右边把宽度拉大两栏');
  await view.onGestureEnd();
  eq(plugin.slotOf('nav').w, nav0.w + 2, '宽度已落盘');

  const nav1 = plugin.slotOf('nav');
  view.beginGesture('resize', mkEv(300, 300), navEl, 'nav', nav1, 'xy');
  view.onGestureMove(mkEv(300, 300 + 8 * 10));
  eq(navEl.style.gridRow, nav1.row + ' / span ' + (nav1.h + 10), '拖角改高度');
  await view.onGestureEnd();
  eq(plugin.slotOf('nav').h, nav1.h + 10, '高度已落盘');

  console.log('\n[20] 压住别人 → 被压住的那张自动让位/缩小');
  await plugin.resetLayout();
  const q0 = plugin.slotOf('quick');
  await plugin.setBox('pinned', { col: q0.col, row: q0.row, w: q0.w, h: q0.h });
  await plugin.resolveOverlaps('pinned');
  const vis = plugin.layoutList().filter((s) => s.on);
  let pairs = 0;
  for (let a = 0; a < vis.length; a++) {
    for (let b = a + 1; b < vis.length; b++) {
      const p = vis[a], s = vis[b];
      if (p.col < s.col + s.w && s.col < p.col + p.w && p.row < s.row + s.h && s.row < p.row + p.h) pairs++;
    }
  }
  eq(pairs, 0, '消解后没有任何两卡重叠');
  const q1 = plugin.slotOf('quick');
  ok(q1.w < q0.w || q1.h < q0.h || q1.row !== q0.row || q1.col !== q0.col, '被压住的「快捷新建」被缩小或让位', [q0, q1]);
  const p1 = plugin.slotOf('pinned');
  eq(p1.col + ',' + p1.row, q0.col + ',' + q0.row, '落点卡保持用户放的位置');

  console.log('\n[21] 拖动手感（P0）：按帧批处理 / 虚影不进网格流 / 松手不整页重建');
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  const mkEv2 = (x, y) => ({ button: 0, pointerId: 7, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
  const pinEl = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned');
  const grip = pinEl.find('.kbwb-card-head');
  ok(!!grip, '标题栏是卡片的直接子元素（CSS 靠 .kbwb-card > .kbwb-card-head 选中它）');
  const pin0 = plugin.slotOf('pinned');
  const posAll = () => root.findAll('.kbwb-card').map((c) => c.dataset.mod + ':' + c.style.gridColumn + '/' + c.style.gridRow).join('|');
  const posStart = posAll();
  const tfWrites = () => pinEl._styleWrites.filter((k) => k === 'transform').length;

  rafMode = 'manual';
  view.beginGesture('move', mkEv2(600, 300), pinEl, 'pinned', pin0, undefined, grip);
  eq(grip.__capture, 7, 'pointerdown 里申请了指针捕获（在窗口外松手也不会留下永不结束的手势）');
  for (let i = 1; i <= 8; i++) view.onGestureMove(mkEv2(600 - 2 * view.gesture.colW + i, 300 + 8 * 5));
  eq(tfWrites(), 0, '8 次 pointermove 在下一帧之前一次样式都不写（高频鼠标不再逐事件写样式）');
  eq(flushFrames(), 1, '8 次事件只排了 1 帧');
  eq(tfWrites(), 1, '合并成每帧 1 次 transform 写入');
  eq(posAll(), posStart, '整场拖动：14 张卡的 grid 坐标一个都没变 = 零重排');
  ok(!!view.ghost, '落点虚影已生成');
  eq(view.ghost.style.gridColumn, undefined, '虚影不写 gridColumn = 不在网格流里（改落点不重排）');
  ok(/translate/.test(view.ghost.style.transform || ''), '虚影用 transform 定位');
  ok(/px/.test(view.ghost.style.width || '') && /px/.test(view.ghost.style.height || ''), '虚影尺寸一次算好，拖动中不再改');
  const spotCard = root.findAll('.kbwb-card')[0];
  view.spotMove({ clientX: 50, clientY: 50, target: { closest: () => spotCard } });
  eq(spotCard.style.getPropertyValue('--mx'), '', '手势期间光斑跟随不跑（它每帧读 rect = 强制同步布局）');
  const domBefore = root.findAll('.kbwb-card');
  await view.render();
  eq(root.findAll('.kbwb-card').length, domBefore.length, '手势期间 render() 没有重建 DOM');
  ok(root.findAll('.kbwb-card').every((c, i) => c === domBefore[i]), '卡片节点还是原来那批（正在拖的那张没被换掉）');
  eq(view.pendingRender, true, '重绘被挂起到松手之后');
  rafMode = 'auto';
  await view.onGestureEnd();
  await settle();
  eq(grip.__capture, null, '松手后释放指针捕获');
  eq(view.pendingRender, false, '挂起的重绘已补做');
  const pin1 = plugin.slotOf('pinned');
  eq(pin1.col, pin0.col - 2, '松手才写列坐标');
  eq(pin1.row, pin0.row + 5, '松手才写行坐标');
  const pinEl1 = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned');
  eq(pinEl1.style.gridColumn, pin1.col + ' / span ' + pin1.w, '落位后 DOM 内联坐标已跟上');
  ok(!/translate/.test(pinEl1.style.transform || ''), 'transform 已清除');

  console.log('\n[21b] 松手不整页重建：只写回坐标，不 empty() 不重扫');
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  const pinEl2 = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned');
  const grip2 = pinEl2.find('.kbwb-card-head');
  const ids2 = root.findAll('.kbwb-card');
  const writesBefore = ids2.map((c) => c._styleWrites.length);
  const layoutBefore = plugin.layoutList().filter((s) => s.on).map((s) => ({ id: s.id, col: s.col, row: s.row, w: s.w, h: s.h }));
  let persists = 0;
  const origPersist = plugin.persist.bind(plugin);
  plugin.persist = async () => { persists++; return origPersist(); };
  view.beginGesture('move', mkEv2(600, 300), pinEl2, 'pinned', plugin.slotOf('pinned'), undefined, grip2);
  view.onGestureMove(mkEv2(600 - 200, 300 + 16));
  await view.onGestureEnd();
  await settle();
  eq(persists, 1, '一次落位只落一次盘（写坐标 + 消解重叠合并成一次 persist）');
  ok(root.findAll('.kbwb-card').every((c, i) => c === ids2[i]), '落位后卡片节点未被替换（不闪回原位再跳过去）');
  const pin2 = plugin.slotOf('pinned');
  eq(pinEl2.style.gridColumn, pin2.col + ' / span ' + pin2.w, '原地写回了新坐标');
  // 落位只写"坐标真的变了"的那几张：全写一遍 = 落位瞬间一次整版重排
  const moved = new Set(plugin.layoutList().filter((s) => {
    const b = layoutBefore.find((x) => x.id === s.id);
    return !b || b.col !== s.col || b.row !== s.row || b.w !== s.w || b.h !== s.h;
  }).map((s) => s.id));
  const grew = ids2.map((c, i) => c._styleWrites.length - writesBefore[i]);
  ok(moved.size >= 1, '这次落位确实动了卡', [...moved]);
  ok(ids2.every((c, i) => moved.has(c.dataset.mod) || grew[i] === 0),
    '没动的卡一个内联样式都没被写（落位不是整版重排）', ids2.map((c, i) => [c.dataset.mod, grew[i]]));
  plugin.persist = origPersist;

  console.log('\n[21c] 连续 5 次拖动：位置单调累积，不回原位');
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  const cols = [plugin.slotOf('tasks').col];
  for (let n = 0; n < 5; n++) {
    const slot = plugin.slotOf('tasks');
    const el = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'tasks');
    ok(!!el && !!el.find('.kbwb-card-head'), '第 ' + (n + 1) + ' 次拖动：卡与标题栏都还在');
    view.beginGesture('move', mkEv2(500, 400), el, 'tasks', slot, undefined, el.find('.kbwb-card-head'));
    view.onGestureMove(mkEv2(500 - view.gesture.colW, 400));           // 每次往左一栏
    await view.onGestureEnd();
    await settle();
    cols.push(plugin.slotOf('tasks').col);
  }
  ok(cols.every((c, i) => i === 0 || c === Math.max(1, cols[i - 1] - 1)), '5 次拖动列号逐次 -1（到边界夹住）', cols);
  ok(cols[cols.length - 1] !== cols[0], '最后一次仍停在最后落点，没有回到起点', cols);
  const tasksEl = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'tasks');
  const tFinal = plugin.layoutList().find((s) => s.id === 'tasks');
  eq(tasksEl.style.gridColumn, tFinal.col + ' / span ' + tFinal.w, 'DOM 上的内联坐标与落盘一致');
  const visAll = plugin.layoutList().filter((s) => s.on);
  let pairs2 = 0;
  for (let a = 0; a < visAll.length; a++) {
    for (let b = a + 1; b < visAll.length; b++) if (visHit(visAll[a], visAll[b])) pairs2++;
  }
  eq(pairs2, 0, '连拖 5 次之后依然没有任何两卡重叠', visAll.map((s) => [s.id, s.col, s.row, s.w, s.h]));

  console.log('\n[21d] 拖动中途整页重建：认领新节点，这次拖动不算作废');
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  const recEl = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'recent');
  const rec0 = plugin.slotOf('recent');
  view.beginGesture('move', mkEv2(300, 300), recEl, 'recent', rec0, undefined, recEl.find('.kbwb-card-head'));
  const cwD = view.gesture.colW;
  view.onGestureMove(mkEv2(300 + cwD, 300 + 8 * 4));
  // 模拟"库事件触发的整页重建"：正在拖的节点被摘掉，换上同 data-mod 的新节点
  const gridNow = root.find('.kbwb-grid');
  gridNow.removeChild(recEl);
  const recEl2 = gridNow.createDiv({ cls: 'kbwb-card' });
  recEl2.dataset.mod = 'recent';
  recEl2.style.gridColumn = rec0.col + ' / span ' + rec0.w;
  view.onGestureMove(mkEv2(300 + 2 * cwD, 300 + 8 * 4));
  ok(/translate/.test(recEl2.style.transform || ''), '手势认领了重建后的新节点（否则这次拖动悄悄作废 = "回到原位"）');
  ok(recEl2.hasClass('is-dragging'), '新节点接过了 is-dragging');
  await view.onGestureEnd();
  await settle();
  const rec1 = plugin.slotOf('recent');
  eq(rec1.col, rec0.col + 2, '松手按新节点的位移落位（列）');
  eq(rec1.row, rec0.row + 4, '松手按新节点的位移落位（行）');

  console.log('\n[21e] 第二次拖动从"已落位坐标"起算（不是上次渲染时闭包里那份旧坐标）');
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  const pinDom = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned');
  const pinHandle = pinDom.find('.kbwb-card-head');
  const c0 = plugin.slotOf('pinned').col;
  pinHandle.fire('pointerdown', mkEv2(600, 300));
  ok(!!view.gesture, '从真实事件入口（beginBind 闭包）也能起手');
  view.onGestureMove(mkEv2(600 - 2 * view.gesture.colW, 300));
  await view.onGestureEnd();
  await settle();
  const c1 = plugin.slotOf('pinned').col;
  eq(c1, c0 - 2, '第一次：往左两栏');
  pinHandle.fire('pointerdown', mkEv2(600, 300));
  view.onGestureMove(mkEv2(600 - 2 * view.gesture.colW, 300));
  await view.onGestureEnd();
  await settle();
  const c2 = plugin.slotOf('pinned').col;
  eq(c2, c1 - 2, '第二次：继续往左两栏（用旧坐标起算就会被弹回 c0）', { c0, c1, c2 });
  eq(pinDom.style.gridColumn, c2 + ' / span ' + plugin.slotOf('pinned').w, 'DOM 与落盘一致');

  console.log('\n[21f] 拖标题栏也能摆；页签 / ⋯ 的点击不被拖动吃掉');
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  const recCard = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'recent');
  const headEl = recCard.find('.kbwb-card-head');
  const r0 = plugin.slotOf('recent');
  const tabEl = recCard.find('.kbwb-tab');
  ok(!!tabEl, '「最近」卡头部有页签（就是被抓手压住过的那个）');
  headEl.fire('pointerdown', Object.assign(mkEv2(400, 200), { target: tabEl }));
  eq(view.gesture, null, '在页签上按下不起手（页签还得是页签）');
  headEl.fire('pointerdown', Object.assign(mkEv2(400, 200), { target: recCard.find('.kbwb-ctrl-btn') }));
  eq(view.gesture, null, '在 ⋯ 上按下不起手（菜单还得是菜单）');
  headEl.fire('pointerdown', mkEv2(400, 200));
  ok(!!view.gesture, '按住标题栏空白处即可起手（窄栏里抓手按设计隐藏，这是唯一把手）');
  view.onGestureMove(mkEv2(400, 200 + 8 * 12));
  await view.onGestureEnd();
  await settle();
  eq(plugin.slotOf('recent').row, r0.row + 12, '拖标题栏真的改了位置');

  console.log('\n[21g] 拖动途中滚滚轮：卡片跟住光标，落点行号把滚动量算进去');
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  const hyEl = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'hygiene');
  const hy0 = plugin.slotOf('hygiene');
  root.scrollTop = 0;
  view.beginGesture('move', mkEv2(600, 500), hyEl, 'hygiene', hy0, undefined, hyEl.find('.kbwb-card-head'));
  view.onGestureMove(mkEv2(600, 500));            // 指针原地不动
  const tfIdle = hyEl.style.transform;
  const ghostIdle = view.ghost.style.transform;
  root.scrollTop = 160;                            // 滚轮往下滚 160px = 20 行
  root.fire('scroll', {});
  eq(hyEl.style.transform, 'translate(0px, 160px)', '指针没动、只滚了滚轮：卡片补上滚动量，仍停在光标底下', tfIdle);
  ok(view.ghost.style.transform !== ghostIdle, '落点虚影跟着滚到新的行上');
  await view.onGestureEnd();
  await settle();
  eq(plugin.slotOf('hygiene').row, hy0.row + 20, '松手落位把滚动量算进去了（160px = 20 行）');
  root.scrollTop = 0;
  await view.render();
  await settle();

  console.log('\n[21h] 滚动容器识别：contentEl 滚不动时往上找（主题把 overflow 放祖先上）');
  const realContent = view.contentEl;
  const inner = dom.createRoot();
  inner.scrollTop = 0; inner.scrollLeft = 0;
  const host2 = dom.createRoot();
  host2.scrollHeight = 3000; host2.clientHeight = 800; host2.scrollTop = 0; host2.scrollLeft = 0;
  inner.parentElement = host2;
  view.__contentEl = inner;
  eq(view.scrollerEl(), host2, 'contentEl 不滚 → 找到会滚的祖先（只盯 contentEl 会让补偿静默失效）');
  view.__contentEl = realContent;
  eq(view.scrollerEl(), realContent, 'contentEl 自己能滚就用它，不乱找');

  console.log('\n[22] 窄栏（默认停靠左侧栏）：拖动 = 上下换序，落位后 DOM 顺序跟着变');
  root.clientWidth = 320;
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  const order0 = root.findAll('.kbwb-card').map((c) => c.dataset.mod);
  const quickEl = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'quick');
  view.beginGesture('move', mkEv2(200, 500), quickEl, 'quick', plugin.slotOf('quick'), undefined, quickEl.find('.kbwb-card-head'));
  eq(view.ghost, null, '窄栏不放横向落点虚影（单列里它没有意义）');
  view.onGestureMove(mkEv2(200, 500 + 8 * 200));
  await view.onGestureEnd();
  await settle();
  await new Promise((r) => setImmediate(r));
  const order1 = root.findAll('.kbwb-card').map((c) => c.dataset.mod);
  ok(order1.indexOf('quick') > order0.indexOf('quick'), '往下拖的卡在窄栏里真的排到后面（旧版看着就是"回到原位"）', { order0, order1 });
  delete root.clientWidth;
  await view.render();
  await settle();

  console.log('\n[23] styles.css 静默失效防线（选择器权重 / 合成层 / 命中区）');
  const fs = require('fs');
  const cssRaw = fs.readFileSync(process.env.KBWB_STYLES || path.join(__dirname, '..', 'styles.css'), 'utf8');
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/\.kbwb-card\s*>\s*\*\s*\{[^}]*position\s*:/.test(css),
    '没有 .kbwb-card > * 的 position 规则（等权重、写在后面，会把抓手/手柄的 absolute 顶掉）');
  ok(!/dragbar/.test(cssRaw), 'CSS 里不再有任何 .kbwb-dragbar 规则（抓手已整个删除，不留死规则）');
  ok(/\.kbwb-card\s*>\s*\.kbwb-card-head\s*\{[^}]*cursor:\s*grab/.test(css), '标题栏规则带 .kbwb-card > 限定且 cursor: grab');
  ok(/\.kbwb-card\s*>\s*\.kbwb-edge\s*\{[^}]*position:\s*absolute/.test(css), '三条手柄规则带 .kbwb-card > 限定且 absolute');
  const edgeBase = (css.match(/^\.kbwb-card > \.kbwb-edge\s*\{[^}]*\}/m) || [''])[0];
  ok(/opacity:\s*0;/.test(edgeBase), '手柄默认隐形（强调色线与滚动条并排，实测分不清哪根是滚动条）', edgeBase);
  ok(!/\.kbwb-card:hover\s*>\s*\.kbwb-edge/.test(css), '不许"悬停卡就显形"：那样只要鼠标在卡里，右边就多一条线与滚动条抢');
  ok(/\.kbwb-card > \.kbwb-edge:hover\s*\{[^}]*opacity:\s*0?\.\d/.test(css), '手抓到那条边才显形');
  ok(/\.kbwb-card\.is-resizing > \.kbwb-edge\s*\{[^}]*opacity/.test(css), '正在缩放的卡：那条边保持显形');
  eq((css.match(/\.kbwb-card\.is-resizing > \.kbwb-edge\s*\{/g) || []).length, 1, 'is-resizing 的手柄规则只有一条（不留重复/死规则）');
  const edgeR = (css.match(/\.kbwb-card\s*>\s*\.kbwb-edge-r\s*\{[^}]*\}/) || [''])[0];
  const edgeB = (css.match(/\.kbwb-card\s*>\s*\.kbwb-edge-b\s*\{[^}]*\}/) || [''])[0];
  const edgeC = (css.match(/\.kbwb-card\s*>\s*\.kbwb-edge-corner\s*\{[^}]*\}/) || [''])[0];
  ok(parseFloat((edgeR.match(/width:\s*([\d.]+)px/) || [])[1] || 0) >= 12, '右边手柄命中区 ≥12px（原来 7px 抓不到）', edgeR);
  ok(parseFloat((edgeB.match(/height:\s*([\d.]+)px/) || [])[1] || 0) >= 12, '下边手柄命中区 ≥12px', edgeB);
  ok(parseFloat((edgeC.match(/width:\s*([\d.]+)px/) || [])[1] || 0) >= 20, '角柄命中区 ≥20px', edgeC);
  ok(/\.kbwb-ghost\s*\{[^}]*position:\s*absolute/.test(css), '落点虚影绝对定位（不进网格流）');
  ok(!/\.kbwb-ghost\s*\{[^}]*margin/.test(css), '虚影不再用 margin 对齐（绝对定位自己算坐标）');
  ok(/\.kbwb-grid\s*\{[^}]*contain:[^;}]*layout/.test(css), '网格带 contain: layout（改坐标不外溢到整页）');
  ok(!/backdrop-filter/.test(css), '全文件没有 backdrop-filter 声明（含字元素提层丢 ClearType）');
  const dragBlock = (css.match(/\.kbwb-card\.is-dragging\s*\{[^}]*\}/) || [''])[0];
  ok(!/opacity\s*:/.test(dragBlock), 'is-dragging 不用 opacity 提层', dragBlock);
  const narrowBlock = (css.match(/@container kbwb-pane \(max-width: 420px\) \{([\s\S]*?)\n\}/) || ['', ''])[1];
  ok(/\.kbwb-card\s*>\s*\.kbwb-card-head\s*\{[^}]*cursor:\s*grab/.test(narrowBlock),
    '窄栏（≤420px）里拖标题栏 —— 小抓手已在第二十一轮整个删除（它一路压页签 20×9px、压 4 字标题 9×7px、压长 chip 9×8px）');
  const narrowCardBlock = (css.match(/@container kbwc \(max-width: 300px\) \{([\s\S]*?)\n\}/) || ['', ''])[1];
  ok(/\.kbwb-card\s*>\s*\.kbwb-card-head\s*\{[^}]*cursor:\s*grab/.test(narrowCardBlock),
    '窄卡（卡片自身 ≤300px）同样只靠标题栏拖（w=780 时 4 字标题曾被抓手压 9x7px、页签被压 35x9px）');
  ok(/\.kbwb-card\s*>\s*\.kbwb-card-head\s*\{[^}]*cursor:\s*grab/.test(css), '头部 cursor 提示可拖');
  ok(/\.kbwb-nudge\s*\{[^}]*position:\s*absolute/.test(css), '让位预演框绝对定位（不进网格流）');
  const nudgeBlock = (css.match(/^\.kbwb-nudge\s*\{[^}]*\}/m) || [''])[0];
  ok(/pointer-events:\s*none/.test(nudgeBlock), '预演框不吃鼠标（不会挡住下面的卡）', nudgeBlock);
  ok(!/\.kbwb-card\.is-nudged/.test(css), '松手后的"让位高亮"已删除（用户：被压住的时候不用提醒）');
  ok(!/\.kbwb-card\.is-dragging\s*>\s*\.kbwb-card-body\s*\{[^}]*visibility:\s*hidden/.test(css),
    '拖动中正文保持可见（用户要求；不再用 visibility:hidden 藏掉）');
  const bodyBlock = (css.match(/^\.kbwb-card-body\s*\{[^}]*\}/m) || [''])[0];
  ok(/scrollbar-gutter:\s*stable/.test(bodyBlock), '滚动条槽位预留：出不出滚动条内容都不横移，右侧胶囊不被挤');
  const marginBottom = parseFloat((bodyBlock.match(/margin-bottom:\s*([\d.]+)px/) || [])[1] || 0);
  ok(marginBottom >= 10 && marginBottom <= 16,
    '卡体底部空白在 10–16px 区间（用户定的）：实测 ' + marginBottom + 'px。' +
    '空白必须在滚动容器"外面"（margin-bottom），加在里面的 padding-bottom 只有滚到底才露出来');
  ok(!/^\.kbwb-card-body::after\s*\{/m.test(css),
    '卡体不许有 ::after 渐隐层：负 margin 会糊住最后一行，占真实高度又会在列表不溢出时浮在卡片中间成硬边带（两张用户截图都是它）');
  ok(!/\.kbwb-card-body::after/.test(css), '全文件不再引用 .kbwb-card-body::after（不留死规则）');
  // 第三十二轮：月历红点是"格子里第三个盒子"（号数 / ● / 红点），窄卡里会不会压字只有量才知道，
  // 而 audit 的 calCells 探针已经钉住几何；这里钉住书写规则本身（退回 top/right 曾经真的压住 1px）。
  const dotBlock = (css.match(/\.kbwb-cal-cell\s*>\s*\.kbwb-cal-dot\s*\{[^}]*\}/) || [''])[0];
  ok(/position:\s*absolute/.test(dotBlock), '红点规则带 .kbwb-cal-cell > 限定且 absolute（等权重通配会顶掉 absolute）', dotBlock);
  ok(/bottom:\s*\d+(\.\d+)?px/.test(dotBlock) && !/top:\s*\d+(\.\d+)?px/.test(dotBlock),
    '红点贴格底、不贴格顶：号数在格子上半部，top 定位在 27px 格子里实测压住两位数号数 1.0×5.0px（audit 的 calCells 会当场报）', dotBlock);
  ok(!/transform|opacity|backdrop-filter|mask/.test(dotBlock), '红点规则不碰 transform / opacity / backdrop-filter / mask');
  const cellBlock = (css.match(/^\.kbwb-cal-cell\s*\{[^}]*\}/m) || [''])[0];
  ok(/position:\s*relative/.test(cellBlock), '格子是 red 点的定位父（absolute 才有参照，不会跑到卡外）', cellBlock);
  // 「＋ 新建笔记」是这轮唯一的建笔记入口：老库的月历还是 26 行（layoutList 不改老坐标），
  // 不钉住的话按钮落在折叠区外 258px（实测），等于把入口藏起来了。
  const bottomBlock = (css.match(/^\.kbwb-cal-bottom\s*\{[^}]*\}/m) || [''])[0];
  ok(/position:\s*sticky/.test(bottomBlock) && /bottom:\s*0/.test(bottomBlock),
    '月历底部那块是 sticky + bottom:0（新建笔记按钮永远在可视区内）', bottomBlock);
  ok(/background:\s*var\(--background-primary\)/.test(bottomBlock),
    'sticky 块用不透明底色（与置顶带同一做法），不用 backdrop-filter', bottomBlock);
  ok(!/backdrop-filter|mask:/.test(bottomBlock), 'sticky 块不碰 backdrop-filter / mask');
  ok(/\.kbwb-todo-del\s*\{/.test(css), '待办行的删除按钮有规则（不是只建了 DOM 没样式）');
  ok(!/transform|backdrop-filter|mask|opacity/.test((css.match(/\.kbwb-todo-(row|text|body)[^{]*\{[^}]*\}/g) || []).join('\n')),
    '待办的含字元素（行/正文）没有 transform / backdrop-filter / mask / 常驻 opacity（Windows 合成层丢 ClearType）');
  // 第三十三轮：入场动效的门禁（真机症状「点月历日期，整个月历卡闪一下」）
  const riseBlock = (css.match(/^\.kbwb-animate \.kbwb-card\s*\{[^}]*\}/m) || [''])[0];
  ok(/animation:\s*kbwb-rise/.test(riseBlock), '首屏水落入场仍挂在 .kbwb-animate .kbwb-card 上（没被这条修复弄丢）', riseBlock);
  ok(/both/.test(riseBlock), 'fill-mode 是 both（正因如此 --i*32ms 的延迟期间整卡 opacity:0 = 「闪一下」的放大器）', riseBlock);
  const noRiseBlock = (css.match(/^\.kbwb-animate \.kbwb-card\.kbwb-no-rise\s*\{[^}]*\}/m) || [''])[0];
  ok(/animation:\s*none/.test(noRiseBlock), '重建节点由 .kbwb-no-rise 关掉入场动效（替换不是入场）', noRiseBlock);
  const noRiseSel = ((noRiseBlock.match(/^[^{]+/) || [''])[0]).trim();
  ok((noRiseSel.match(/\./g) || []).length >= 3,
    '.kbwb-no-rise 那条选择器至少三个类 ⇒ 权重高于 .kbwb-animate .kbwb-card，不依赖书写顺序', noRiseSel);

  // 第三十四轮：写作量「无基线」不许装在 6px 轨道里（用户截图：文字被挤压，实测被切 7px）
  const trackBlk = (css.match(/^\.kbwb-write-bar-track\s*\{[^}]*\}/m) || [''])[0];
  ok(/height:\s*6px/.test(trackBlk) && /overflow:\s*hidden/.test(trackBlk),
    '轨道仍是 6px + overflow:hidden（柱子本身的设计没动）—— 正因如此任何文字都不许放进去', trackBlk);
  const noneBlk = (css.match(/^\.kbwb-write-bar-none\s*\{[^}]*\}/m) || [''])[0];
  ok(/flex:\s*1 1 auto/.test(noneBlk), '「无基线」自己占一格（flex: 1 1 auto），不再靠轨道给宽度', noneBlk);
  ok(parseFloat((noneBlk.match(/line-height:\s*([\d.]+)/) || [])[1] || 0) >= 1.2,
    '「无基线」有正常行高（<1.2 就会被行盒挤字）', noneBlk);
  ok(!/\.kbwb-write-bar-track\s+\.kbwb-write-bar-none/.test(css),
    'CSS 里不许出现「轨道里的无基线」这种后代规则（那是把字塞进 6px 盒子的另一半证据）');

  // 第三十五轮：月历底部改成直接列文件名（用户：别再写「笔记 N 篇」）
  const notesRow = (css.match(/^\.kbwb-cal-notes\s*\{[^}]*\}/m) || [''])[0];
  ok(/display:\s*flex/.test(notesRow) && /flex-wrap:\s*wrap/.test(notesRow),
    '文件名那一行是 flex + 可换行（放不下就折，不撑破 sticky 块）', notesRow);
  const noteChip = (css.match(/^\.kbwb-cal-note\s*\{[^}]*\}/m) || [''])[0];
  ok(/max-width:\s*100%/.test(noteChip) && /text-overflow:\s*ellipsis/.test(noteChip),
    '超长文件名截字而不是把 sticky 块顶高（calBottom 会报当日面板被挤）', noteChip);
  ok(!/transform|backdrop-filter|mask|opacity/.test(noteChip), '文件名 chip 不碰合成层属性（含字元素丢 ClearType）', noteChip);
  ok(!/\.kbwb-cal-open/.test(css), '「笔记 N 篇」那条 CSS 已随按钮一起删掉（不留死规则，同 dragbar 的规矩）');
  for (const gone of ['kbwb-task-src', 'kbwb-mod-sel']) {
    ok(!new RegExp('\\.' + gone).test(css), '死规则 .' + gone + ' 已删且不许回来（第三十七轮体检清掉的）');
  }
  eq((cssRaw.match(/\{/g) || []).length, (cssRaw.match(/\}/g) || []).length, 'CSS 花括号配对');

  console.log('\n[24] 压小预演：拖动途中就画出"缩小后的框"，松手后高亮 + 提示谁让了位');
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  const pinB = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned');
  const qSlot = plugin.slotOf('quick');
  view.beginGesture('move', mkEv2(600, 300), pinB, 'pinned', plugin.slotOf('pinned'), undefined, pinB.find('.kbwb-card-head'));
  const gp = view.gesture;
  // 空位落点：先拖到没人的一格，不该出现预演框。
  // 14 张卡装箱后原来那个 300 + 8 * 200 的落点已经站了人 —— 从当前布局现算一格真空位，
  // 意图不变：落点谁都没压住 → 不该画出让位框。
  const pinBox24 = plugin.slotOf('pinned');
  const occupied24 = plugin.layoutList().filter((s) => s.on && s.id !== 'pinned')
    .map((s) => ({ col: s.col, row: s.row, w: s.w, h: s.h }));
  let free24 = null;
  for (let r = 1; r <= 400 && !free24; r++) {
    for (let c = 1; c + pinBox24.w <= 49; c++) {
      if (c === gp.col && r === gp.row) continue;      // 得真的挪一下，否则落点没变、预演根本不重算
      const box = { col: c, row: r, w: pinBox24.w, h: pinBox24.h };
      if (!occupied24.some((o) => visHit(box, o))) { free24 = box; break; }
    }
  }
  ok(!!free24, '从 layoutList() 里现算得到一个真空位（14 张卡装箱后仍然找得到）', free24);
  // 网格坐标 → 指针坐标：列宽 = view.gesture.colW，行高 = 8px（换算写法同 [18]/[20]）
  view.onGestureMove(mkEv2(600 + (free24.col - gp.col) * gp.colW, 300 + (free24.row - gp.row) * 8));
  eq(view.gesture.tCol, free24.col, '落点列号 = 现算的真空位');
  eq(view.gesture.tRow, free24.row, '落点行号 = 现算的真空位');
  eq((view.nudgeEls || []).length, 0, '落点没压住任何人 → 没有让位框');
  // 压到「快捷新建」的右半段（快捷新建占 1-32 栏，收藏落 12-27 栏）→ 它该被压窄到 11 栏
  view.onGestureMove(mkEv2(600 + (12 - gp.col) * gp.colW, 300 + (qSlot.row - gp.row) * 8));
  const nudges = view.nudgeEls || [];
  ok(nudges.length >= 1, '压住别人时画出让位框', nudges.length);
  ok(nudges.every((n) => /translate/.test(n.style.transform || '') && !n.style.gridColumn),
    '让位框是绝对定位 + transform（和落点虚影一样不进网格流）');
  const pv = (gp.preview || [])[0];
  ok(pv && pv.id === 'quick', '预演的正是被压住的那张', gp.preview);
  ok(pv && pv.w < qSlot.w, '预演框 = 压窄后的框（不是原框）', { before: qSlot.w, after: pv && pv.w });
  eq(nudges[0].style.width, Math.round(pv.w * gp.colW - 10) + 'px', '框宽按"压窄后的栏数"画', pv.w);

  stub.Notice.last = null;
  await view.onGestureEnd();
  await settle();
  eq((view.nudgeEls || []).length, 0, '松手后预演框立刻撤掉');
  // 用户要求："被压住的时候不用提醒"
  eq(stub.Notice.last, null, '落位压住别人时不弹 Notice', stub.Notice.last);
  const quickCard = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'quick');
  ok(!quickCard.hasClass('is-nudged'), '被让位的卡不再加高亮类（提醒已去掉）');

  console.log('\n[25] 置顶：收藏的子集，钉在收藏卡顶部，取消收藏会一并撤掉');
  const P1 = '实习/讲解待办/REA介绍与DSH接入判断.md';
  const P2 = '实习/学习文档(md)/LLM Wiki介绍与本机实践.md';
  const P3 = '每周AI消息汇总/2026-W45.md';
  plugin.pins = []; plugin.sticks = [];
  plugin.togglePin(P1);
  plugin.togglePin(P2);
  eq(plugin.pinnedPaths().length, 2, '先收藏两篇');
  eq(plugin.stuckPaths().length, 0, '还没有置顶');
  plugin.toggleStick(P2);
  eq(plugin.stuckPaths().length, 1, '置顶一篇');
  plugin.toggleStick(P3);
  eq(plugin.pinnedPaths().length, 3, '置顶会自动进收藏（不留悬空置顶）', plugin.pinnedPaths());
  plugin.togglePin(P3);                       // 取消收藏
  eq(plugin.stuckPaths().length, 1, '取消收藏会一并撤掉置顶', plugin.stuckPaths());
  await plugin.resetLayout();
  await view.render();
  await settle();
  const pinCard = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned');
  const strip = pinCard.find('.kbwb-sticky');
  ok(!!strip, '收藏卡里有置顶带（sticky 在卡顶）');
  eq(strip.findAll('.kbwb-item').length, 1, '置顶带里只有置顶的那篇');
  ok(strip.textContent.includes('LLM Wiki'), '置顶带里就是被置顶的笔记', strip.textContent.slice(0, 40));
  eq(pinCard.findAll('.kbwb-pin').length, 2, '每行都有 📌 开关', pinCard.findAll('.kbwb-pin').length);
  eq(pinCard.findAll('.kbwb-pin.is-on').length, 1, '置顶行的 📌 是点亮态');
  eq((pinCard.find('.kbwb-chip') || {}).textContent, '置顶 1', 'chip 用短文案（长了会钻到居中抓手底下，实测压 25×8px）');
  const firstInCard = pinCard.findAll('.kbwb-item')[0];
  const pinBody = pinCard.find('.kbwb-card-body');
  ok(pinBody.children.some((ch) => ch === strip), '置顶带是卡体的直接子元素（sticky 才有效）');
  ok(firstInCard === strip.findAll('.kbwb-item')[0], 'DOM 顺序：置顶在最上');
  pinCard.find('.kbwb-pin.is-on').click();    // 点 📌 取消置顶
  await new Promise((r) => setImmediate(r));
  eq(plugin.stuckPaths().length, 0, '点 📌 取消置顶');
  ok(plugin.pinnedPaths().indexOf(P2) >= 0, '取消置顶不影响收藏');
  await view.render();
  await settle();
  const pinCard2 = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned');
  eq(pinCard2.find('.kbwb-sticky'), null, '没有置顶时不渲染置顶带');
  plugin.togglePin(P1); plugin.togglePin(P2);   // 收尾：清掉测试期间加的收藏
  plugin.pins = []; plugin.sticks = [];

  console.log('\n[26] 字体默认值与跳转留白（顶栏挡住搜索卡的回归）');
  eq(plugin.settings.uiFont, 'MiSans', '界面字体默认已换成 MiSans（Chromium 实测 HIT）');
  ok(!!plugin.applyFonts, 'applyFonts 在位（把字体栈写成 --kbwb-ui）');
  const probeHost = dom.createRoot();
  plugin.settings.uiFont = 'MiSans';
  plugin.applyFonts(probeHost);
  ok(/MiSans/.test(probeHost.style.getPropertyValue('--kbwb-ui') || ''), '选 MiSans 时真的写进 --kbwb-ui', probeHost.style.getPropertyValue('--kbwb-ui'));
  plugin.settings.uiFont = '';
  plugin.applyFonts(probeHost);
  eq(probeHost.style.getPropertyValue('--kbwb-ui'), '', '选"跟随"时移除变量而不是塞空串');
  ok(/\.kbwb-card\s*\{[^}]*scroll-margin-top:\s*(7[0-9]|8[0-9]|9[0-9])px/.test(css),
    '卡片有 scroll-margin-top ≥70px：scrollIntoView 后不会被 sticky 顶栏挡住');
  const stickyBlock = (css.match(/^\.kbwb-sticky\s*\{[^}]*\}/m) || [''])[0];
  ok(/position:\s*sticky/.test(stickyBlock) && /background:\s*var\(--background-primary\)/.test(stickyBlock),
    '置顶带 sticky + 不透明底色（不用 backdrop-filter）', stickyBlock);
  ok(!/backdrop-filter|transform|opacity/.test(stickyBlock), '置顶带不提合成层：带里全是中文');
  const pinBtn = (css.match(/^\.kbwb-pin\s*\{[^}]*\}/m) || [''])[0];
  ok(/width:\s*22px/.test(pinBtn) && /height:\s*22px/.test(pinBtn), '📌 命中区 22×22，与 ★ 同级', pinBtn);

  console.log('\n[27] 点收藏/置顶不整版重绘（"闪一下回到最上面"的根因）');
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  plugin.pins = []; plugin.sticks = [];
  await view.render();
  await settle();
  const cardsBefore = root.findAll('.kbwb-card');
  const recentCard = cardsBefore.find((c) => c.dataset.mod === 'recent');
  const starInRecent = recentCard.findAll('.kbwb-star')[0];
  ok(!!starInRecent, '「最近」卡里有 ★ 按钮');
  starInRecent.click();
  await new Promise((r) => setImmediate(r));
  await settle();
  eq(plugin.pinnedPaths().length, 1, '点 ★ 写进收藏');
  ok(starInRecent.hasClass('is-on'), '点下去的那颗 ★ 当场变点亮态');
  const cardsAfter = root.findAll('.kbwb-card');
  eq(cardsAfter.map((c) => c.dataset.mod).join(','), cardsBefore.map((c) => c.dataset.mod).join(','), '卡片顺序不变');
  ok(cardsBefore.filter((c) => c.dataset.mod !== 'pinned').every((c) => cardsAfter.indexOf(c) >= 0),
    '除收藏卡外，其余 13 张卡的节点没被换掉（没走整版重绘 = 不会塌滚动高度）');
  const pinnedNew = cardsAfter.find((c) => c.dataset.mod === 'pinned');
  ok(cardsBefore.indexOf(pinnedNew) < 0, '收藏卡被就地重建');
  eq(pinnedNew.findAll('.kbwb-item').length, 1, '重建后的收藏卡里有那一篇');
  ok(pinnedNew.find('.kbwb-item') && pinnedNew.find('.kbwb-item').dataset.path === plugin.pinnedPaths()[0],
    '行上带 data-path（syncStars 靠它就地更新 ★）');

  console.log('\n[27b] 整版重建期间容器不能空着（空着 = scrollTop 被夹到顶 = 闪回顶部）');
  const emptyTicks = [];
  const rp = view.render();
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setImmediate(r));
    if (!root.children.length) emptyTicks.push(i);
  }
  await rp;
  await settle();
  eq(emptyTicks.length, 0, '构建走游离容器再同帧换入：整个过程中容器始终有内容', emptyTicks);
  eq(root.findAll('.kbwb-card-name').length, 14, '换入后 14 张卡齐全');
  const gridNow2 = root.find('.kbwb-grid');
  ok(!!gridNow2, '网格在真实容器里（syncBoxes / refreshCard 都靠它定位）');

  console.log('\n[27c] 连点 ★ 两次：两次单卡重建串行执行，不留重复卡也不丢卡');
  plugin.pins = []; plugin.sticks = [];      // 上一节留了一条收藏，不清掉会把"两次点击"变成"取消再收藏"
  await view.render();
  await settle();
  const recentCard2 = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'recent');
  const star2 = recentCard2.findAll('.kbwb-star')[0];
  star2.click();
  star2.click();                       // 连点：收藏又立刻取消
  await new Promise((r) => setImmediate(r));
  await settle();
  eq(plugin.pinnedPaths().length, 0, '两次点击互相抵消');
  ok(!star2.hasClass('is-on'), '★ 回到未点亮态');
  eq(root.findAll('.kbwb-card').length, 14, '网格里还是 14 张卡（没重复、没丢）', root.findAll('.kbwb-card').length);
  eq(root.findAll('.kbwb-card').filter((c) => c.dataset.mod === 'pinned').length, 1, '收藏卡只有一张');

  console.log('\n[28] 坐标刻度升级：旧 12 栏配置一次性换算成 48 栏（视觉位置不变）');
  const origLoadData = plugin.loadData;
  plugin.loadData = async () => ({
    layout: [
      { id: 'tasks', col: 5, row: 43, w: 8, h: 30, on: true, collapsed: false },
      { id: 'pinned', col: 9, row: 28, w: 4, h: 20, on: true, collapsed: false },
    ],
  });
  await plugin.loadAll();
  // 直接看 settings.layout：layoutList() 会因为缺模块触发 autoPack，掩盖换算结果
  const mv = {};
  for (const x of plugin.settings.layout) mv[x.id] = x;
  eq(mv.tasks.col, 17, '旧 col 5 → 17（起点 (5-1)/12 = 16/48）');
  eq(mv.tasks.w, 32, '旧 w 8 → 32（视觉宽度不变）');
  eq(mv.pinned.col, 33, '旧 col 9 → 33');
  eq(mv.pinned.w, 16, '旧 w 4 → 16');
  eq(mv.tasks.row, 43, '行单元刻度没变（row 原样）');
  eq(plugin.settings.layoutScale, 48, '换算后记下刻度，不会二次翻倍');
  plugin.loadData = async () => ({
    layoutScale: 48,
    layout: [{ id: 'tasks', col: 17, row: 43, w: 32, h: 30, on: true, collapsed: false }],
  });
  await plugin.loadAll();
  eq(plugin.settings.layout[0].col + ',' + plugin.settings.layout[0].w, '17,32', '已是 48 栏制的数据原样保留');
  plugin.loadData = origLoadData;
  await plugin.resetLayout();
  await view.render();
  await settle();

  console.log('\n[29] 统计缓存：不 invalidate 的刷新不再重读全库');
  let reads = 0;
  const origCachedRead = vault.cachedRead;
  vault.cachedRead = async (f) => { reads++; return origCachedRead(f); };
  plugin.statsCache = null; plugin.statsJob = null; plugin.wordsCache = null;
  await plugin.computeStats();
  const first = reads;
  await plugin.computeStats();
  eq(reads, first, '第二次 computeStats 命中结果缓存（不再重读正文）');
  plugin.statsCache = null;                       // 模拟 refreshViews(true)
  await plugin.computeStats();
  eq(reads, first, '结果缓存清掉后，只要库没动，字数仍走签名缓存（不重读正文）');
  plugin.statsCache = null; plugin.statsJob = null; plugin.wordsCache = null;
  await plugin.computeStats();
  ok(reads > first, '两层缓存都没了才会真的重扫全库', { before: first, after: reads });
  vault.cachedRead = origCachedRead;

  console.log('\n[30] 面板最小尺寸：侧栏拖不穿，设 0 撤销，关掉视图也撤销');
  const mkBox = () => {
    const s = new Map();
    return {
      _s: s,
      style: {
        setProperty(k, v) { s.set(k, String(v)); },
        removeProperty(k) { s.delete(k); },
        getPropertyValue(k) { return s.get(k) || ''; },
      },
    };
  };
  const pLeaf = mkBox(); const pDock = mkBox(); const pInner = mkBox();
  pInner.closest = (sel) => (sel.indexOf('workspace-leaf') >= 0 ? pLeaf : (sel.indexOf('mod-left-split') >= 0 ? pDock : null));
  pLeaf.closest = (sel) => (sel.indexOf('mod-left-split') >= 0 ? pDock : null);
  view.containerEl = pInner;
  plugin.settings.minPaneWidth = 300; plugin.settings.minPaneHeight = 220;
  view.applyMinSize();
  eq(pDock.style.getPropertyValue('min-width'), '300px', '侧栏：宽度地板加在整条侧栏上（min-* 压得住分割器写的内联 width）');
  eq(pLeaf.style.getPropertyValue('min-height'), '220px', '高度地板加在叶子上（上下分屏才有效）');
  plugin.settings.minPaneWidth = 0;
  view.applyMinSize();
  eq(pDock.style.getPropertyValue('min-width'), '', '设 0 = 不限制：撤掉属性，而不是塞一个 0');
  view.clearMinSize();
  eq(pLeaf.style.getPropertyValue('min-height'), '', '关掉视图撤销限制，不把侧栏永久卡在某宽度');
  const pLeaf2 = mkBox(); const pInner2 = mkBox();
  pInner2.closest = (sel) => (sel.indexOf('workspace-leaf') >= 0 ? pLeaf2 : null);
  view.containerEl = pInner2;
  plugin.settings.minPaneWidth = 320; plugin.settings.minPaneHeight = 0;
  view.applyMinSize();
  eq(pLeaf2.style.getPropertyValue('min-width'), '320px', '主区域（没有侧栏祖先）：宽度地板落在叶子自己身上');
  view.clearMinSize();
  eq(pLeaf2.style.getPropertyValue('min-width'), '', '主区域同样能撤销');
  view.containerEl = { addClass() {}, isConnected: true, empty() {}, style: { setProperty() {}, removeProperty() {} } };
  plugin.settings.minPaneWidth = 300; plugin.settings.minPaneHeight = 220;

  console.log('\n[30b] 分屏里 min-* 要落在 split 的直接子元素上（否则垂直方向压不住）');
  const pSplit = mkBox(); const pTabs = mkBox(); const pLeaf3 = mkBox(); const pInner3 = mkBox();
  pInner3.parentElement = pLeaf3; pLeaf3.parentElement = pTabs; pTabs.parentElement = pSplit;
  pInner3.closest = (sel) => {
    if (sel.indexOf('workspace-leaf') >= 0) return pLeaf3;
    if (sel.indexOf('mod-left-split') >= 0 || sel.indexOf('mod-right-split') >= 0) return null;
    if (sel.indexOf('workspace-split') >= 0) return pSplit;
    return null;
  };
  view.containerEl = pInner3;
  plugin.settings.minPaneWidth = 300; plugin.settings.minPaneHeight = 220;
  view.applyMinSize();
  eq(pTabs.style.getPropertyValue('min-height'), '220px',
    '高度地板落在 .workspace-tabs（分割器真正改尺寸的那一层），不是只加在叶子上');
  eq(pTabs.style.getPropertyValue('min-width'), '300px', '主区域分屏：宽度地板同样落在直接子元素上');
  eq(pLeaf3.style.getPropertyValue('min-height'), '220px',
    '第二十一轮：叶子也写上（第十八轮只压一层，真机主区域上下压不住 ⇒ 改成链上一起压，不再猜）');
  eq(pSplit.style.getPropertyValue('min-height'), '', '但绝不压 .workspace-split 本身（会连同一分屏里的另一个面板一起卡住）');
  view.clearMinSize();
  eq(pTabs.style.getPropertyValue('min-height'), '', '关掉视图一并撤销');
  view.containerEl = { addClass() {}, isConnected: true, empty() {}, style: { setProperty() {}, removeProperty() {} } };

  console.log('\n[31] 勾任务：只重建任务卡，列表滚动位置不回顶');
  view.taskFilter = 'open';                       // 前面几节把筛选切到「逾期」并勾掉过任务
  await plugin.resetLayout();
  await settle();
  await view.render();
  await settle();
  const tkCard = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'tasks');
  const tkBody = tkCard.find('.kbwb-card-body');
  ok(!!tkBody, '任务卡有卡体');
  tkBody.scrollTop = 120;                        // 用户滚到列表中间
  const statsBefore = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'stats');
  plugin.statsCache = { md: 3 };                // 假装统计已经算过
  const box1 = tkCard.findAll('.kbwb-checkbox')[0];
  ok(!!box1, '任务卡里有复选框');
  box1.click();
  await new Promise((r) => setImmediate(r));
  await settle();
  const after31 = root.findAll('.kbwb-card');
  eq(after31.length, 14, '还是 14 张卡');
  ok(after31.find((c) => c.dataset.mod === 'stats') === statsBefore, '统计卡节点没被换 = 没走整版重绘');
  const tkNew = after31.find((c) => c.dataset.mod === 'tasks');
  ok(tkNew !== tkCard, '任务卡被就地重建');
  const tkBody2 = tkNew.find('.kbwb-card-body');
  ok(!!tkBody2, '重建后的任务卡有卡体');
  eq(tkBody2.scrollTop, 120, '任务列表的滚动位置保住了（用户看到的"跳回最上面"就是它丢了）');
  ok(!!plugin.statsCache, '没有 invalidate 统计缓存（"卡一下"的来源）');
  plugin.statsCache = null;

  console.log('\n[32] 整版重绘也保住每张卡的滚动位置（60s 自动刷新不再把列表顶回去）');
  await view.render();
  await settle();
  const navB = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'nav').find('.kbwb-card-body');
  const pinB2 = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned').find('.kbwb-card-body');
  navB.scrollTop = 90; pinB2.scrollTop = 40;
  root.scrollTop = 200;
  await view.render();
  await settle();
  eq(root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'nav').find('.kbwb-card-body').scrollTop, 90,
    '知识库卡滚到 90px 后重绘仍在 90px');
  eq(root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'pinned').find('.kbwb-card-body').scrollTop, 40,
    '收藏卡同样保住');
  eq(root.scrollTop, 200, '面板自身的滚动也保住');

  console.log('\n[33] 刚写完文件、缓存被清空的窗口里，同文档的任务不会消失');
  const P_REA = '实习/讲解待办/REA介绍与DSH接入判断.md';
  const origGetCache = app.metadataCache.getFileCache;
  await plugin.collectTasks();                       // 先建立 lastTaskFiles
  const baseline = await plugin.collectTasks();
  const reaBase = baseline.filter((t) => t.file.path === P_REA).length;
  ok(reaBase >= 1, '基线：这篇文档有任务行', reaBase);
  app.metadataCache.getFileCache = (f) => (f.path === P_REA ? null : origGetCache(f));
  const during = await plugin.collectTasks();
  eq(during.filter((t) => t.file.path === P_REA).length, reaBase,
    'getFileCache 返回 null（刚写入的重建窗口）时，任务改由正文按行兜底，不消失');
  app.metadataCache.getFileCache = () => null;
  const allNull = await plugin.collectTasks();
  ok(Array.isArray(allNull), '所有文件都没缓存也不炸');
  app.metadataCache.getFileCache = origGetCache;
  const back = await plugin.collectTasks();
  eq(back.filter((t) => t.file.path === P_REA).length, reaBase, '缓存回来后数量一致（兜底没造成重复）');

  console.log('\n[34] 以当前尺寸做基准：capturePaneMin 量的就是被限制的那个元素');
  const pLeaf4 = mkBox(); const pInner4 = mkBox();
  pInner4.parentElement = pLeaf4;
  pInner4.closest = (sel) => (sel.indexOf('workspace-leaf') >= 0 ? pLeaf4 : null);
  pLeaf4.getBoundingClientRect = () => ({ height: 640, width: 320 });
  view.containerEl = pInner4;
  const origLeaves = app.workspace.getLeavesOfType;
  app.workspace.getLeavesOfType = () => [{ view }];
  plugin.settings.minPaneHeight = 220; plugin.settings.minPaneWidth = 300;
  eq(plugin.capturePaneMin('height'), 640, '取当前高度');
  eq(plugin.settings.minPaneHeight, 640, 'minPaneHeight 记下了当前尺寸');
  eq(plugin.capturePaneMin('width'), 320, '取当前宽度');
  await settle();
  view.applyMinSize();
  eq(pLeaf4.style.getPropertyValue('min-height'), '640px', '地板按新基准真的写上了');
  eq(pLeaf4.style.getPropertyValue('min-width'), '320px', '宽度同理');
  plugin.settings.minPaneHeight = 220; plugin.settings.minPaneWidth = 300;
  app.workspace.getLeavesOfType = origLeaves;
  view.containerEl = { addClass() {}, isConnected: true, empty() {}, style: { setProperty() {}, removeProperty() {} } };

  console.log('\n[35] 设置页真渲染（display() 不抛错；层级检测与两个基准按钮都在）');
  let capturedTab = null;
  plugin.addSettingTab = (t) => { capturedTab = t; };
  await plugin.onload();
  ok(!!capturedTab, 'onload 注册了设置页');
  const origLeaves35 = app.workspace.getLeavesOfType;
  app.workspace.getLeavesOfType = () => [{ view }];
  const tabRoot = dom.createRoot();
  capturedTab.containerEl = tabRoot;
  let threw = null;
  try { capturedTab.display(); } catch (e) { threw = e && e.message; }
  eq(threw, null, 'display() 不抛错');
  const tabTxt = tabRoot.textContent;
  ok(tabTxt.indexOf('最小尺寸现在施加在') >= 0, '层级检测那行渲染出来了');
  ok(tabTxt.indexOf('48 列') >= 0, '模块画板说明写的是 48 列（不再是过期的 12 列）');
  // Setting 的名称/描述不进容器（桩不模拟渲染），所以用桩记下的最后一个组件来验
  const dd = stub.Setting.lastDropdown;
  ok(!!dd && dd._opts.some((o) => o[0] === 'tabs'), '「施加在哪一层」下拉有 .workspace-tabs 这一档', dd && dd._opts.map((o) => o[0]));
  ok(!!dd && dd._v === 'auto', '下拉默认值 = auto', dd && dd._v);
  const sBtns = [];
  const origAddButton = stub.Setting.prototype.addButton;
  stub.Setting.prototype.addButton = function (cb) { const r = origAddButton.call(this, cb); sBtns.push(stub.Setting.lastButton); return r; };
  capturedTab.display();
  stub.Setting.prototype.addButton = origAddButton;
  const sLabels = sBtns.map((b) => b._label);
  ok(sLabels.indexOf('取当前高度') >= 0 && sLabels.indexOf('取当前宽度') >= 0, '两个"以当前尺寸为基准"按钮都在', sLabels);
  ok(sLabels.indexOf('重新检测') >= 0, '「重新检测」按钮在', sLabels);
  const hBtn = sBtns.filter((b) => b._label === '取当前高度')[0];
  plugin.settings.minPaneHeight = 220;
  // 桩里 addButton 的 onClick 不 return 像素，验返回值测的是桩不是插件。
  // 换成给视图一条能量到的容器链，验完整路径：点按钮 → 当前高度写进设置 → Notice 回报。
  const pLeaf35 = mkBox(); const pInner35 = mkBox();
  pInner35.parentElement = pLeaf35;
  pInner35.closest = (sel) => (sel.indexOf('workspace-leaf') >= 0 ? pLeaf35 : null);
  pLeaf35.getBoundingClientRect = () => ({ height: 640, width: 320 });
  view.containerEl = pInner35;
  stub.Notice.last = null;
  let fireErr = null;
  try { hBtn.fire(); } catch (e) { fireErr = e && e.message; }
  await settle();
  eq(fireErr, null, '点「取当前高度」不抛错');
  eq(plugin.settings.minPaneHeight, 640, '按钮把当前高度写进 minPaneHeight', plugin.settings.minPaneHeight);
  ok(String(stub.Notice.last || '').indexOf('640px') >= 0, 'Notice 回报了新地板', stub.Notice.last);
  // 收尾还原：containerEl 若留在盒子上，后面的渲染会写进这个游离树里
  plugin.settings.minPaneHeight = 220;
  view.containerEl = { addClass() {}, isConnected: true, empty() {}, style: { setProperty() {}, removeProperty() {} } };
  app.workspace.getLeavesOfType = origLeaves35;

  const tick = async (n) => { for (let i = 0; i < (n || 6); i++) await new Promise((r) => setImmediate(r)); await settle(); };
  const dstr = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

  console.log('\n[36] 到期日历（第二十轮）');
  const syn = [
    { done: false, markers: { due: '2020-01-01' } },
    { done: false, markers: { due: TODAY } },
    { done: false, markers: { due: dstr(5) } },
    { done: false, markers: { due: dstr(40) } },
    { done: false, markers: {} },
    { done: true, markers: { due: TODAY } },
  ];
  const gsyn = view.groupByDue(syn, TODAY);
  eq(gsyn.overdue.length, 1, '📅 早于今天 → 逾期');
  eq(gsyn.today.length, 1, '📅 = 今天 → 今天到期');
  eq(gsyn.soon.length, 1, '📅 在 14 天内 → 未来 14 天');
  eq(gsyn.later.length, 1, '📅 超 14 天 → 14 天以后（不被吞掉）');
  eq(gsyn.undated, 1, '没写 📅 的未完成任务计入 undated 提示');
  eq(gsyn.overdue.length + gsyn.today.length + gsyn.soon.length + gsyn.later.length + gsyn.undated, 5,
    '未完成且有/无日期的 5 条不重不漏（已完成的不进这张卡）');
  await view.render();
  const dueCard = cardOf('due');
  ok(!!dueCard, '到期日历卡在网格里');
  const g36 = view.groupByDue(await plugin.collectTasks(), TODAY);
  const wantGroups = ['overdue', 'today', 'soon', 'later'].filter((k) => g36[k].length);
  const domGroups = dueCard.findAll('.kbwb-due-group');
  eq(domGroups.length, wantGroups.length, 'DOM 里的分组数 = groupByDue 的非空组数', { dom: domGroups.length, want: wantGroups });
  eq(dueCard.findAll('.kbwb-task').length, wantGroups.reduce((n, k) => n + g36[k].length, 0),
    '卡里的任务行数 = 各组行数之和');
  eq(dueCard.findAll('.kbwb-due-group').filter((x) => x.classes().indexOf('is-overdue') >= 0).length,
    g36.overdue.length ? 1 : 0, '只有逾期那组带 is-overdue');
  ok(!dueCard.find('.kbwb-skeleton'), '到期卡不留骨架条');

  console.log('\n[37] 速记本（真往库里写一个文件，只追加）');
  ok(contents.get('每日笔记/速记.md') === undefined, '起手：速记本文件还不存在');
  await view.render();
  let scrCard = cardOf('scratch');
  const scrInput = scrCard.findAll('.kbwb-scratch-input')[0];
  const scrBtn = scrCard.findAll('.kbwb-scratch-go')[0];
  ok(!!scrInput && !!scrBtn, '速记卡有输入框与「追加」按钮');
  scrInput.value = '  测试速记   一句  ';
  scrBtn.click();
  await tick();
  const sc1 = contents.get('每日笔记/速记.md');
  ok(/^# 速记\n\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} 测试速记 一句\n$/.test(sc1), '新建文件 = 标题 + 一行（空白被压平）', JSON.stringify(sc1));
  scrCard = cardOf('scratch');
  const scrRows = scrCard.findAll('.kbwb-scratch-line');
  eq(scrRows.length, 1, '写完卡里立刻出现这一条（只重建这张卡）');
  ok(/测试速记 一句/.test(scrRows[0].textContent), '行文本对得上', scrRows[0].textContent);
  ok(cardOf('scratch').findAll('.kbwb-scratch-input')[0].value === '', '写完清空输入框');
  const scrInput2 = cardOf('scratch').findAll('.kbwb-scratch-input')[0];
  scrInput2.value = '回车也能写';
  scrInput2.fire('keydown', { key: 'Enter' });
  await tick();
  const sc2 = contents.get('每日笔记/速记.md');
  eq(sc2.split('\n').filter((l) => l.indexOf('- ') === 0).length, 2, '回车提交 = 第二行，第一行没被动过');
  eq(cardOf('scratch').findAll('.kbwb-scratch-line').length, 2, '卡里两条');
  ok(/测试速记 一句/.test(cardOf('scratch').findAll('.kbwb-scratch-line')[1].textContent), '新的在上（第一行是「回车也能写」）');

  console.log('\n[38] 标签总览（全量标签 + 过滤 + 点击转搜索）');
  plugin.statsCache = null; plugin.statsJob = null;
  const s38 = await plugin.computeStats();
  await view.render();
  const tagCard = cardOf('tags');
  ok(!!tagCard, '标签总览卡在网格里');
  ok(tagCard.findAll('.kbwb-tagrow').length === s38.topTags.length, '列的是全量标签（统计卡只切前 12，这里不切）',
    { rows: tagCard.findAll('.kbwb-tagrow').length, all: s38.topTags.length });
  ok(String(tagCard.textContent).indexOf('点击转成搜索') < 0, '这张卡不重复统计卡的说明文案');
  const tf = tagCard.findAll('.kbwb-tagfilter-input')[0];
  ok(!!tf, '有过滤输入框');
  tf.value = 'zzz-不存在-的-标签';
  tf.fire('input', {});
  eq(tagCard.findAll('.kbwb-tagrow').length, 0, '过滤后没有匹配行');
  ok(!!tagCard.find('.kbwb-empty'), '过滤无命中时给空态而不是空白');
  tf.value = '';
  tf.fire('input', {});
  eq(tagCard.findAll('.kbwb-tagrow').length, s38.topTags.length, '清空过滤恢复全量');
  const row0 = tagCard.findAll('.kbwb-tagrow')[0];
  row0.click();
  eq(view.searchText, s38.topTags[0][0], '点标签 = 写进搜索词');
  eq(view.jumpToSearch, true, '并请求跳到搜索卡（不还原滚动）');
  await tick();   // 点标签里那下 render() 没 await，直接再调 render 会被合并/让路，要等它真跑完
  eq(view.jumpToSearch, false, '跳转标记用完即清');

  console.log('\n[39] 月历（周一起算 · 点某天 = 打开或创建日记）');
  const c39 = view.monthCells(2026, 10);
  eq(c39.length % 7, 0, '格子铺满整周（尾部补空）');
  eq(c39.filter(Boolean).length, 30, '2026 年 11 月 30 天');
  eq(c39.indexOf(1), (new Date(2026, 10, 1).getDay() + 6) % 7, '1 号落在「周一为第一列」的那一格');
  eq(view.monthCells(2024, 1).filter(Boolean).length, 29, '2024 年 2 月闰年 29 天');
  await view.render();
  let calCard = cardOf('calendar');
  eq(calCard.findAll('.kbwb-cal-cell').length, view.monthCells(view.calCursor.y, view.calCursor.m).length,
    'DOM 格子数与 monthCells 一致');
  eq(calCard.findAll('.kbwb-cal-cell').filter((x) => x.classes().indexOf('is-today') >= 0).length, 1, '本月视图里恰有一个「今天」');
  const navBtns = calCard.findAll('.kbwb-cal-navbtn').map((b) => b.textContent);
  ok(navBtns.indexOf('本月') >= 0, '有「本月」按钮（跑远了能回来）', navBtns);
  const calCursor0 = { y: view.calCursor.y, m: view.calCursor.m };
  calCard.findAll('.kbwb-cal-navbtn')[2].click();
  await tick();
  eq(view.calCursor.m, (calCursor0.m + 1) % 12, '点 › 翻到下月');
  eq(cardOf('calendar').findAll('.kbwb-cal-cell').filter((x) => x.classes().indexOf('is-today') >= 0).length, 0,
    '翻到下月后「今天」不该还亮着');
  cardOf('calendar').findAll('.kbwb-cal-navbtn')[1].click();
  await tick();
  eq(view.calCursor.y + '/' + view.calCursor.m, calCursor0.y + '/' + calCursor0.m, '点「本月」回到当月');
  const todayPath = plugin.dailyFormatPath(new Date());
  mkFile(todayPath, '# 今天的日记\n', Date.now());
  await view.render();          // 建档本身不会触发重绘（桩里没接 vault 事件），要自己渲一次
  await tick();
  calCard = cardOf('calendar');
  const hasCells = calCard.findAll('.kbwb-cal-cell').filter((x) => x.classes().indexOf('is-has') >= 0);
  ok(hasCells.length === 1, '有日记的那天标出 ●', hasCells.map((x) => x.textContent));
  // 第三十二轮改了交互：点格子 = 只选中那天（不弹框、不建文件），"打开或创建日记"改走卡片底部那个按钮。
  // 格子点击 → refreshCard('calendar') → 整张卡换成新节点，所以按钮必须在重绘之后从卡里重新找，不能拿旧引用。
  const calNewBtn = () => cardOf('calendar').findAll('.kbwb-cal-new')[0];
  const openedBefore = openedPaths.length;
  if (hasCells[0]) hasCells[0].click();      // 现在 = 选中那天（不弹框）
  await tick();
  calNewBtn().click();
  await tick(12);
  const dayModal = stub.Modal.last;
  ok(!!dayModal && dayModal.isOpen, '已有日记 → 点它弹"这天已建几篇"的列表（不再闷头打开第一篇）');
  const dayRows0 = dayModal.contentEl.findAll('.kbwb-dayrow');
  eq(dayRows0.length, 1, '列表里就那一篇');
  ok(/已建 1 篇/.test(dayModal.contentEl.find('.kbwb-modal-title').textContent), '标题写了已建几篇', dayModal.contentEl.find('.kbwb-modal-title').textContent);
  dayRows0[0].click();
  await tick();
  eq(openedPaths.length, openedBefore + 1, '点列表里的一行 = 进去');
  eq(openedPaths[openedPaths.length - 1].path, todayPath, '进去的就是那篇日记');
  const probeDate = new Date(view.calCursor.y, view.calCursor.m, PD(5));
  const probePath = plugin.dailyFormatPath(probeDate);
  const cellDay5 = cardOf('calendar').findAll('.kbwb-cal-cell').find((x) => {
    const n = x.find('.kbwb-cal-num');
    return n && n.textContent === String(PD(5));
  });
  ok(!!cellDay5, '找到 ' + PD(5) + ' 号那格');
  eq(filesByPath.has(stub.normalizePath(probePath)), false, '起手：' + PD(5) + ' 号还没有日记');
  const ymdOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const btnIn = (root, label) => root.findAll('button').find((b) => b.textContent === label);
  cellDay5.click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  // 第二十三轮：点空白日期不再直接建，先弹框确认标题（用户："先确认标题再按照标题建立笔记"）
  eq(filesByPath.has(stub.normalizePath(probePath)), false, '点空白日期【不直接建】——先弹确认框');
  const mAsk = stub.Modal.last;
  ok(!!mAsk && mAsk.isOpen, '确认框打开了');
  const hintEl = mAsk.contentEl.find('.kbwb-modal-hint');
  ok(!!hintEl && /为 \d{4}-\d{2}-\d{2} 建立笔记/.test(hintEl.textContent), '框里写清了是为哪一天建的', hintEl && hintEl.textContent);
  const askInput = mAsk.contentEl.findAll('.kbwb-input')[0];
  eq(askInput.value, plugin.dailyNameFor(probeDate), '标题默认用「日记」的格式');
  askInput.value = '周复盘 第五周';
  askInput.fire('keydown', { key: 'Enter' });
  await tick(12);
  const renamedPath = stub.normalizePath('周复盘 第五周.md');
  ok(filesByPath.has(renamedPath), '按【确认后的标题】建了笔记', Array.from(filesByPath.keys()));
  eq(filesByPath.has(stub.normalizePath(probePath)), false, '一次点击只建一个文件（没顺手把默认名那篇也建了）');
  eq((plugin.dailyNotes[ymdOf(probeDate)] || []).join(','), renamedPath, '这天记住了用的是哪篇（数组：同一天可以多篇）');
  await tick();
  const cell5after = cardOf('calendar').findAll('.kbwb-cal-cell').find((x) => {
    const n = x.find('.kbwb-cal-num');
    return n && n.textContent === String(PD(5));
  });
  ok(!!cell5after && cell5after.classes().indexOf('is-has') >= 0, '重绘后 ' + PD(5) + ' 号标出 ●（按记住的那篇标的）');
  const openedBefore45 = openedPaths.length;
  cell5after.click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const dayList5 = stub.Modal.last;
  ok(dayList5 !== mAsk && dayList5.isOpen, '第二十五轮：再点 5 号 = 弹"这天已建几篇"的列表，不再闷头打开');
  eq(dayList5.contentEl.findAll('.kbwb-dayrow').length, 1, '列表里就那一篇');
  dayList5.contentEl.findAll('.kbwb-dayrow')[0].click();
  await tick();
  eq(openedPaths.length, openedBefore45 + 1, '点列表里那行 = 进去');
  eq(openedPaths[openedPaths.length - 1].path, renamedPath, '进去的就是改名建的那篇');

  // 取消 = 什么都不建
  const cell12 = cardOf('calendar').findAll('.kbwb-cal-cell').find((x) => {
    const n = x.find('.kbwb-cal-num');
    return n && n.textContent === String(PD(12));
  });
  cell12.click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const mCancel = stub.Modal.last;
  ok(mCancel !== mAsk && mCancel.isOpen, '点另一个空白日期 = 弹新框');
  btnIn(mCancel.contentEl, '取消').click();
  await tick(12);
  const key12 = ymdOf(new Date(view.calCursor.y, view.calCursor.m, PD(12)));
  eq(plugin.dailyNotes[key12], undefined, '取消 → 不记映射');
  eq(filesByPath.has(stub.normalizePath(plugin.dailyNameFor(new Date(view.calCursor.y, view.calCursor.m, PD(12))) + '.md')), false, '取消 → 一个文件都不建');

  // 空标题不提交（框还开着），Escape 关掉
  const cell19 = cardOf('calendar').findAll('.kbwb-cal-cell').find((x) => {
    const n = x.find('.kbwb-cal-num');
    return n && n.textContent === String(PD(19));
  });
  cell19.click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const mEmpty = stub.Modal.last;
  const emptyInput = mEmpty.contentEl.findAll('.kbwb-input')[0];
  emptyInput.value = '   ';
  emptyInput.fire('keydown', { key: 'Enter' });
  await tick();
  ok(mEmpty.isOpen, '空标题不提交（框还开着，不会默默建一篇没名字的）');
  emptyInput.fire('keydown', { key: 'Escape' });
  await tick();
  ok(!mEmpty.isOpen, 'Escape 关掉确认框');
  eq(Object.keys(plugin.dailyNotes).length, 1, '整场只有"周复盘"那一条映射');

  console.log('\n[40] 写作量（快照不在 render 里写盘）');
  plugin.writingLog = {};
  plugin.statsCache = null; plugin.statsJob = null;
  const words40 = (await plugin.computeStats()).words;
  await view.render();
  const wr0 = cardOf('writing');
  eq(Object.keys(plugin.writingLog).length, 0, 'render() 不写快照（只在启动与 60s 刷新里写）');
  ok(!!wr0.find('.kbwb-empty'), '没有基线时给空态，不画假柱子');
  ok(String(wr0.textContent).indexOf('基线') >= 0, '空态文案解释了为什么要等一天', String(wr0.textContent).slice(0, 60));
  eq(wr0.findAll('.kbwb-write-bar-row').length, 0, '没基线时一根柱子都不画');
  eq(wr0.findAll('.kbwb-write-num')[0].textContent, String(words40), '今天的总数照常显示');
  plugin.writingLog[dstr(-1)] = words40 - 1234;
  await view.render();
  await tick();
  const wr1 = cardOf('writing');
  eq(wr1.findAll('.kbwb-write-bar-row').length, 7, '有昨天基线后画满 7 天');
  eq(wr1.findAll('.kbwb-write-bar-fill').length, 1, '只有真有差值的那天有柱子，其余留「无基线」');
  ok(String(wr1.textContent).indexOf('+1234') >= 0, '差值显示 +1234', String(wr1.textContent).slice(0, 80));
  ok(String(cardOf('writing').findAll('.kbwb-chip')[0].textContent).indexOf('近 7 天') >= 0, 'chip 汇总近 7 天');
  await plugin.snapshotWriting();
  ok(Number.isFinite(plugin.writingLog[TODAY]), 'snapshotWriting 写今天这一笔（由定时器/启动调用）');
  plugin.writingLog = {};

  console.log('\n[41] 标签总览：框选多选（纯函数 + 卡内交互）');
  eq(view.marqueeHits([
    { name: 'a', top: 0, bottom: 20, left: 0, right: 100 },
    { name: 'b', top: 20, bottom: 40, left: 0, right: 100 },
    { name: 'c', top: 60, bottom: 80, left: 0, right: 100 },
  ], { left: 0, right: 100, top: 15, bottom: 45 }).join(','), 'a,b', '框住一部分算命中，没框到的不算');
  eq(view.marqueeHits([], { left: 0, right: 1, top: 0, bottom: 1 }).length, 0, '空列表不炸');
  const tf41 = new Map([
    ['x', [{ path: '1.md', stat: { mtime: 3 } }]],
    ['y', [{ path: '2.md', stat: { mtime: 5 } }, { path: '1.md', stat: { mtime: 3 } }]],
  ]);
  eq(view.pickTagNotes(tf41, ['x', 'y'], 'all').map((x) => x.path).join(','), '1.md', '都含 = 交集');
  eq(view.pickTagNotes(tf41, ['x', 'y'], 'any').map((x) => x.path).join(','), '2.md,1.md', '任一 = 并集，按修改时间新的在前');
  eq(view.pickTagNotes(tf41, ['没这个标签'], 'any').length, 0, '标签不存在时给空列表而不是崩');
  eq(view.pickTagNotes(null, ['x'], 'any').length, 0, 'stats 没带 tagFiles 也不崩');

  plugin.statsCache = null; plugin.statsJob = null;
  const s41 = await plugin.computeStats();
  view.tagSel = []; view.tagQuery = ''; view.tagMode = null;
  await view.render();
  const tagCard41 = cardOf('tags');
  const rows41 = tagCard41.findAll('.kbwb-tagrow');
  ok(rows41.length >= 1, '标签行渲染出来', rows41.length);
  rows41[0].fire('click', { ctrlKey: true });
  await settle();
  eq(view.tagSel.length, 1, 'Ctrl/⌘ 点一下 = 加入选择');
  let tc = cardOf('tags');
  ok(!!tc.find('.kbwb-tagrow.is-sel'), '选中的行有 is-sel 标记');
  ok(!!tc.find('.kbwb-tagselbar'), '出现选择条');
  const btns41 = tc.findAll('.kbwb-tagsel-btn').map((b) => b.textContent);
  ok(btns41.indexOf('都含') >= 0 && btns41.indexOf('任一') >= 0 && btns41.indexOf('清空') >= 0, '都含 / 任一 / 清空 三个按钮都在', btns41);
  eq((String((cardOf('tags').find('.kbwb-chip') || {}).textContent)).slice(0, 3), '已选 ', 'chip 改成「已选 N」');
  cardOf('tags').findAll('.kbwb-tagsel-btn')[0].click();
  const res41 = cardOf('tags').find('.kbwb-tagres');
  ok(!!res41 && !!res41.find('.kbwb-subtitle'), '点「都含」后列出共同笔记（垫片不支持后代选择器，分两步查）');
  ok(!!res41 && res41.findAll('.kbwb-item').length >= 1, '共同笔记里有那一篇', res41 && res41.findAll('.kbwb-item').length);
  tc = cardOf('tags');
  tc.findAll('.kbwb-tagsel-btn')[2].click();
  await settle();
  eq(view.tagSel.length, 0, '「清空」撤掉全部选择');
  view.tagSel = [s41.topTags[0][0]];
  view._mqEndedAt = 0;
  await view.render();
  cardOf('tags').findAll('.kbwb-tagrow')[0].fire('click', {});
  await settle();
  eq(view.tagSel.length, 0, '已有选择时点一下 = 取消这个标签（而不是跳搜索）');
  view._mqEndedAt = 0;
  await view.render();
  cardOf('tags').findAll('.kbwb-tagrow')[0].fire('click', {});
  eq(view.jumpToSearch, true, '没有选择时点一下仍然转搜索（旧行为没被框选顶掉）');
  view.jumpToSearch = false; view.searchText = '';
  await view.render();

  const tc2 = cardOf('tags');
  const list41 = tc2.find('.kbwb-taglist');
  const rowsNow = tc2.findAll('.kbwb-tagrow');
  rowsNow.forEach((r, i) => {
    r.getBoundingClientRect = () => ({ top: i * 20, bottom: i * 20 + 20, left: 0, right: 200, width: 200, height: 20 });
  });
  view.startTagMarquee(
    { clientX: 5, clientY: 5, button: 0, pointerId: 1, target: { closest: () => null } },
    { body: tc2.find('.kbwb-card-body') }, list41);
  ok(!!list41.find('.kbwb-marquee'), '起手后画出框选矩形');
  view.moveTagMarquee({ clientX: 40, clientY: 25 });
  view.endTagMarquee();
  await settle();
  ok(rowsNow.length >= 2, '库里有两行标签（框选要能一次框住多行）', rowsNow.length);
  eq(view.tagSel.length, rowsNow.length, '框住全部行 → 全部标签进选择', view.tagSel);
  eq(document.count('pointermove'), 0, '松手后 document 上的移动监听摘干净（不泄漏）');
  view.tagSel = []; view.tagMode = null;
  await view.render();

  console.log('\n[42] 缩放手柄仍在（去掉抓手不能顺手把缩放也弄坏）');
  const card42 = cardOf('due');
  ok(!card42.find('.kbwb-dragbar'), '到期卡里没有小抓手');
  ['kbwb-edge-r', 'kbwb-edge-b', 'kbwb-edge-corner'].forEach((k) => {
    ok(!!card42.find('.' + k), '三条缩放手柄还在：' + k);
  });
  ok(!!card42.find('.kbwb-card-head'), '标题栏在（唯一拖动入口）');

  console.log('\n[43] min-* 压一串 + 实测低于地板时钉回去');
  const pSplit4 = mkBox(); const pTabs4 = mkBox(); const pLeaf4b = mkBox(); const pInner4b = mkBox();
  pInner4b.parentElement = pLeaf4b; pLeaf4b.parentElement = pTabs4; pTabs4.parentElement = pSplit4;
  pInner4b.closest = (sel) => {
    if (sel.indexOf('workspace-leaf') >= 0) return pLeaf4b;
    if (sel.indexOf('workspace-tabs') >= 0) return pTabs4;
    if (sel.indexOf('mod-left-split') >= 0 || sel.indexOf('mod-right-split') >= 0) return null;
    if (sel.indexOf('workspace-split') >= 0) return pSplit4;
    return null;
  };
  view.containerEl = pInner4b;
  plugin.settings.minPaneWidth = 300; plugin.settings.minPaneHeight = 220;
  view.applyMinSize();
  const hl43 = view.minTargetsFor('height');
  ok(hl43.length >= 2, '高度方向不再猜一层：链上至少压了直接子元素与叶子', hl43.map((e) => (e === pTabs4 ? 'tabs' : e === pLeaf4b ? 'leaf' : '?')));
  eq(pTabs4.style.getPropertyValue('min-height'), '220px', 'split 的直接子元素被压');
  eq(pLeaf4b.style.getPropertyValue('min-height'), '220px', '叶子也被压');
  eq(pSplit4.style.getPropertyValue('min-height'), '', 'split 本身不压');
  eq(pSplit4.style.getPropertyValue('min-width'), '', 'split 本身宽度也不压');
  pTabs4.getBoundingClientRect = () => ({ width: 250, height: 120, top: 0, left: 0, right: 250, bottom: 120 });
  const pinned43 = view.enforcePaneMin();
  ok(pinned43 >= 1, '实测低于地板 → enforcePaneMin 出手', pinned43);
  eq(pTabs4.style.getPropertyValue('height'), '220px', '内联 height 被钉回地板');
  eq(pTabs4.style.getPropertyValue('width'), '300px', '内联 width 同理');
  pTabs4.getBoundingClientRect = () => ({ width: 900, height: 900, top: 0, left: 0, right: 900, bottom: 900 });
  view.enforcePaneMin();
  eq(pTabs4.style.getPropertyValue('height'), '', '高于地板后自动松开：把我们钉的 height 还原成接手前的值（不然用户拉大之后那次数值会赖着不走）');
  view.clearMinSize();
  eq(pTabs4.style.getPropertyValue('height'), '', '撤销 = 还原成接手前的值（Obsidian 的分割器也在写这个属性）');
  eq(pTabs4.style.getPropertyValue('min-height'), '', 'min-* 一并撤掉');
  eq(pLeaf4b.style.getPropertyValue('min-height'), '', '链上每一层都撤干净，不留半套');
  view.containerEl = { addClass() {}, isConnected: true, empty() {}, style: { setProperty() {}, removeProperty() {} } };

  console.log('\n[44] 笔记体检的「全盘扫描」按钮（第二十二轮）');
  plugin.lastScan = null;
  let scanCalls = 0;
  const origFullScan = plugin.fullScan.bind(plugin);
  plugin.fullScan = (...a) => { scanCalls++; return origFullScan(...a); };
  await view.render();
  eq(scanCalls, 0, 'render() 绝不触发全盘扫描（一次要读几百上千个文件）');
  const hy44 = cardOf('hygiene');
  const dir44 = hy44.find('.kbwb-scan-dir');
  const run44 = hy44.find('.kbwb-scan-run');
  ok(!!dir44 && !!run44, '体检卡里有目录输入框与「全盘扫描」按钮');
  eq(hy44.find('.kbwb-scan-stop')._hidden, true, '没在扫描时「停止」是隐藏的');
  dir44.value = '  实习/讲解待办/  ';
  dir44.fire('input', {});
  eq(plugin.settings.scanRoot, '实习/讲解待办', '目录写进设置并去掉首尾斜杠');
  dir44.value = '';
  dir44.fire('input', {});
  eq(plugin.settings.scanRoot, '', '清空输入框 = 扫整库');
  diskExtra.push({ path: '隐藏目录/没被索引的笔记.md', text: '# 隐藏\n\n#私密\n' });
  stub.Notice.last = null;
  run44.click();
  await tick(20);
  const hy44b = cardOf('hygiene');
  ok(!!hy44b.find('.kbwb-scan-group'), '扫完在卡里列出结果分组（磁盘上有、索引里没有的那篇）');
  ok(/磁盘 \d+ 篇/.test(hy44b.find('.kbwb-scan-status').textContent), '状态行报了篇数与耗时', hy44b.find('.kbwb-scan-status').textContent);
  ok(/走过 \d+ 个目录/.test(hy44b.find('.kbwb-scan-status').textContent), '状态行报走过多少个目录（磁盘列表是自己逐层下钻的，不指望 recursive 标志）', hy44b.find('.kbwb-scan-status').textContent);
  ok(/全盘扫描/.test(String(stub.Notice.last)), 'Notice 回报了不一致数量', stub.Notice.last);
  const lines44 = hy44b.findAll('.kbwb-scan-line');
  ok(lines44.length >= 1, '结果行渲染出来', lines44.length);
  ok(lines44.some((l) => l.classes().indexOf('is-openable') < 0), '没被索引的那些行标成不可点（点开无效）');
  const clr44 = hy44b.find('.kbwb-scan-clear');
  ok(!!clr44, '有「清除结果」按钮');
  clr44.click();
  eq(plugin.lastScan, null, '清除后 lastScan 置空');
  plugin.fullScan = origFullScan;
  diskExtra.length = 0;

  console.log('\n[45] 当日任务模板：月历建出来的笔记带上当天的任务（第二十四轮）');
  // [31] 已经把夹具里那条 open 任务勾掉了，这里补三篇有代表性的（今天/逾期/没日期）
  mkFile('实习/讲解待办/夹具任务.md', [
    '- [ ] 夹具：今天要做的 📅' + TODAY,
    '- [ ] 夹具：早就逾期的 📅2020-01-01',
    '- [ ] 夹具：没写日期的',
  ].join('\n'), Date.now());
  const tasksBefore45 = await plugin.collectTasks();
  const dueToday45 = tasksBefore45.filter((t) => !t.done && t.markers.due === TODAY).length;
  ok(dueToday45 >= 1, '夹具里有"今天到期"的任务', dueToday45);
  ok(tasksBefore45.filter((t) => !t.done && t.markers.due && t.markers.due < TODAY).length >= 1, '也有逾期的');
  ok(tasksBefore45.filter((t) => !t.done && !t.markers.due).length >= 1, '也有没写 📅 的');
  plugin.settings.dailyCreateTemplate = '';        // 故意指不到任何模板 ⇒ 走内置默认模板
  const calNow = cardOf('calendar');
  const cell20 = calNow.findAll('.kbwb-cal-cell').find((x) => {
    const n = x.find('.kbwb-cal-num');
    return n && n.textContent === String(PD(20));
  });
  ok(!!cell20, '找到 ' + PD(20) + ' 号那格');
  cell20.click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const m45 = stub.Modal.last;
  ok(!!m45 && m45.isOpen, '点空白日期先弹确认框（不直接建）');
  const in45 = m45.contentEl.findAll('.kbwb-input')[0];
  in45.value = '2026-11-20 任务';
  in45.fire('keydown', { key: 'Enter' });
  await tick(20);
  const created45 = contents.get('2026-11-20 任务.md');
  ok(!!created45, '按确认后的标题建了笔记（模板找不到也不会失败，退回内置默认）', Array.from(contents.keys()).slice(-3));
  ok(created45.indexOf(KbWorkbenchPlugin.KBWB_GENERATED_MARK) >= 0,
    '成品里留着常驻指纹 KBWB:GENERATED（TASKS 标记会被任务填掉，不能当识别依据 —— 实测踩过）');
  ok(/^# 2026-11-20 周./m.test(created45), '标题里是那一天 + 中文星期', created45.split('\n').filter((l) => l.startsWith('# '))[0]);
  ok(created45.indexOf('{{') < 0, '没有字面占位符残留');
  const taskLines45 = created45.split('\n').filter((l) => /^- \[[ x]\]/.test(l));
  ok(taskLines45.length >= 1, '任务被填成可勾的行', taskLines45.slice(0, 3));
  ok(taskLines45.some((l) => l.indexOf('[[') >= 0), '每行末尾挂了出处链接');
  const tasksAfter45 = await plugin.collectTasks();
  eq(tasksAfter45.length, tasksBefore45.length, '生成的任务页没有把任务"复制"进清单（副本不算）');
  plugin.settings.dailyCreateTemplate = '模板/每日任务模板.md';

  console.log('\n[46] 月历：这天已建几篇的列表 +「新增笔记」再建一篇（第二十五轮）');
  const findCell = (label) => cardOf('calendar').findAll('.kbwb-cal-cell').find((x) => {
    const n = x.find('.kbwb-cal-num');
    return n && n.textContent === label;
  });
  const D20 = String(PD(20));
  const key20 = ymdOf(new Date(view.calCursor.y, view.calCursor.m, PD(20)));
  const opened46 = openedPaths.length;
  findCell(D20).click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const dm46 = stub.Modal.last;
  ok(!!dm46 && dm46.isOpen, '点已有笔记的日子 → 弹列表');
  eq(dm46.contentEl.findAll('.kbwb-dayrow').length, 1, '列表里 1 篇（[45] 建的那篇）');
  const addBtn46 = dm46.contentEl.findAll('button').find((b) => b.textContent === '新增笔记');
  ok(!!addBtn46, '列表里有「新增笔记」按钮');
  addBtn46.click();
  await tick(12);
  const m46 = stub.Modal.last;
  ok(m46 !== dm46 && m46.isOpen, '点「新增笔记」→ 进标题确认框');
  ok(/为 \d{4}-\d{2}-\d{2} 建立笔记/.test(m46.contentEl.find('.kbwb-modal-hint').textContent), '确认框里写清了是哪一天', m46.contentEl.find('.kbwb-modal-hint').textContent);
  const in46 = m46.contentEl.findAll('.kbwb-input')[0];
  in46.value = '2026-11-20 复盘';
  in46.fire('keydown', { key: 'Enter' });
  await tick(20);
  ok(filesByPath.has(stub.normalizePath('2026-11-20 复盘.md')), '同一天下面建出了第二篇', Array.from(filesByPath.keys()).slice(-3));
  eq(plugin.dailyNotesFor(new Date(view.calCursor.y, view.calCursor.m, PD(20))).length, 2, '这天现在记着两篇');
  findCell(D20).click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const dm46b = stub.Modal.last;
  eq(dm46b.contentEl.findAll('.kbwb-dayrow').length, 2, '列表变成两篇');
  dm46b.contentEl.findAll('.kbwb-dayrow')[0].click();
  await tick();
  ok(openedPaths.length > opened46, '点行 = 进去');
  findCell(D20).click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const dm46c = stub.Modal.last;
  const createdBefore46 = filesByPath.size;
  dm46c.contentEl.findAll('button').find((b) => b.textContent === '关闭').click();
  await tick(12);
  eq(filesByPath.size, createdBefore46, '按「关闭」= 一篇都不建');
  ok(plugin.dailyNotes[key20].length === 2, '关闭也不动已记的映射', plugin.dailyNotes[key20]);

  console.log('\n[47] 新建笔记：模板列表 + 当场新增模板（同一个目录）');
  const quick47 = cardOf('quick');
  const btns47 = quick47.findAll('.kbwb-btn').map((b) => b.textContent);
  ok(btns47.indexOf('新增模板') >= 0, '快捷新建里有「新增模板」按钮', btns47);
  quick47.findAll('.kbwb-btn').find((b) => b.textContent.indexOf('新建笔记') >= 0).click();
  await tick(12);
  const m47 = stub.Modal.last;
  ok(!!m47 && m47.isOpen, '「新建笔记」弹框');
  const rows47 = m47.contentEl.findAll('.kbwb-modal-tplrow');
  ok(rows47.length >= 2, '框里列出模板目录（含「不用模板」和「＋ 新增模板」）', rows47.map((r) => r.textContent));
  ok(!!m47.contentEl.find('.kbwb-modal-tplrow-new'), '有「＋ 新增模板」那一行');
  m47.contentEl.find('.kbwb-modal-tplrow-new').click();
  const form47 = m47.contentEl.find('.kbwb-modal-newtpl');
  ok(!!form47 && form47.style.display !== 'none', '点了之后出现模板名输入框');
  form47.findAll('.kbwb-modal-newtpl-name')[0].value = '会议记录';
  form47.findAll('button').find((b) => b.textContent === '建模板').click();
  await tick(12);
  ok(filesByPath.has(stub.normalizePath('模板/会议记录.md')), '新模板建在同一个模板目录下', Array.from(filesByPath.keys()).filter((k) => k.indexOf('模板/') === 0));
  const tplText47 = contents.get('模板/会议记录.md');
  ok(tplText47.indexOf('{{title}}') >= 0, '模板里留着 {{title}} 占位符（不在模板名上就替换掉）', tplText47.slice(0, 60));
  const rows47b = m47.contentEl.findAll('.kbwb-modal-tplrow');
  const picked47 = rows47b.find((r) => r.getAttr('title') === '模板/会议记录.md');
  ok(!!picked47 && picked47.classes().indexOf('is-on') >= 0, '新模板出现在列表里并自动选中');
  const title47 = m47.contentEl.findAll('.kbwb-input')[0];
  title47.value = '某次会议';
  m47.contentEl.findAll('button').find((b) => b.textContent === '创建').click();
  await tick(20);
  const note47 = contents.get('某次会议.md');
  ok(!!note47, '按选中的模板建了笔记', Array.from(filesByPath.keys()).slice(-3));
  ok(note47.indexOf('## 要点') >= 0, '笔记里是模板的内容');
  ok(note47.indexOf('# 某次会议') >= 0, '标题占位符换成了笔记名', note47.split('\n').filter((l) => l.startsWith('# '))[0]);
  ok(note47.indexOf('{{') < 0, '成品里没有字面占位符');

  // 卡片上的「新增模板」按钮：只建模板、不建笔记
  const before48 = filesByPath.size;
  cardOf('quick').findAll('.kbwb-btn').find((b) => b.textContent.indexOf('新增模板') >= 0).click();
  await tick(12);
  const m48 = stub.Modal.last;
  ok(/新增模板/.test(m48.contentEl.find('.kbwb-modal-title').textContent), '那个框的标题是「新增模板」', m48.contentEl.find('.kbwb-modal-title').textContent);
  ok(!m48.contentEl.find('.kbwb-modal-tpls'), '模板名模式下不再列模板（避免自己套自己）');
  const tn48 = m48.contentEl.findAll('.kbwb-input')[0];
  tn48.value = '周总结';
  m48.contentEl.findAll('button').find((b) => b.textContent === '创建').click();
  await tick(20);
  ok(filesByPath.has(stub.normalizePath('模板/周总结.md')), '模板建好了');
  eq(filesByPath.size, before48 + 1, '只多了一个文件（没顺手建笔记）', filesByPath.size - before48);

  console.log('\n[48] 月历的模板列表 = 模板库里的那些文件（②）· 建出来的正文来自库里那份（③）');
  // ②：列表里每一行都必须是真实文件，不再有合成的那一行（「不用模板」/「默认（当天任务模板）」都不是文件）。
  // ③：开局选中要落在设置「当日任务模板」指的那份文件上 —— 于是默认建出来的内容 == 库里那份。
  // 夹具那份和内置副本故意写得不一样（带哨兵句）：成品里出现哨兵，才证明读的是**文件**而不是内置常量。
  mkFile('模板/每日任务模板.md', [
    '---',
    'title: "{{date:YYYY-MM-DD}} 当日任务"',
    '---',
    '',
    '# {{date:YYYY-MM-DD}} {{weekday}} · 当日任务',
    '',
    '> 夹具哨兵句：这一句只在库里那份模板里有，内置副本没有。',
    '',
    '## 今天到期 📅',
    '',
    '<!--KBWB:TASKS:due-->',
    '',
    '## 已逾期（挑一条今天做掉）',
    '',
    '<!--KBWB:TASKS:overdue-->',
    '',
    '## 今天已经勾掉的',
    '',
    '<!--KBWB:TASKS:done-->',
    '',
    '## 没写 📅 的未完成任务（挑几条）',
    '',
    '<!--KBWB:TASKS:undated-->',
    '',
    '## 接下来',
    '',
    '- [ ] ',
    '',
  ].join('\n'), Date.now());
  await plugin.createTemplate('月历测试模板', '');
  const calFiles = plugin.listTemplatesForPicker();
  ok(calFiles.some((f) => f.basename === '每日任务模板'), '夹具那份进了模板列表', calFiles.map((f) => f.basename));
  const cellOf = (label) => cardOf('calendar').findAll('.kbwb-cal-cell').find((x) => {
    const n = x.find('.kbwb-cal-num');
    return n && n.textContent === label;
  });
  ok(!!cellOf(String(PD(24))), '找到 ' + PD(24) + ' 号那格');
  cellOf(String(PD(24))).click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const calModal = stub.Modal.last;
  ok(!!calModal.contentEl.find('.kbwb-modal-tpls'), '月历的确认框里也有模板列表');
  // 用户截图的症状：标题行写着「模板（/）」且下面一句"这个目录下还没有模板"
  const lbl48 = calModal.contentEl.find('.kbwb-modal-label');
  ok(!!lbl48 && lbl48.textContent.indexOf('（/）') < 0, '目录标签不是 "/"（normalizePath("") 在真机上就是 "/"）', lbl48 && lbl48.textContent);
  ok(!!lbl48 && /（模板）/.test(lbl48.textContent), '目录标签显示真实的模板目录', lbl48 && lbl48.textContent);
  ok(!calModal.contentEl.find('.is-empty'), '列出了模板，不再报"这个目录下还没有模板"');
  const calRows = calModal.contentEl.findAll('.kbwb-modal-tplrow');
  const calNames = calRows.map((r) => r.textContent);
  ok(!calNames.some((t) => /不用模板|默认（当天任务模板）/.test(t)), '②不再有那一行合成的条目', calNames);
  const realRows = calRows.filter((r) => String(r.getAttr('title') || '').endsWith('.md'));
  eq(realRows.length, calFiles.length, '②列表的行数 = 模板库里的文件数（不多不少）');
  ok(realRows.every((r) => calFiles.some((f) => f.path === r.getAttr('title'))), '②每一行都对应模板库里的一个真实文件',
    realRows.map((r) => r.getAttr('title')));
  const onRow = realRows.find((r) => r.classes().indexOf('is-on') >= 0);
  ok(!!onRow && onRow.getAttr('title') === '模板/每日任务模板.md', '②开局选中落在「当日任务模板」那份文件上',
    onRow ? onRow.getAttr('title') : null);
  const calTitle = calModal.contentEl.findAll('.kbwb-input')[0];
  calTitle.value = '24 号的实验';
  calModal.contentEl.findAll('button').find((b) => b.textContent === '创建').click();
  await tick(20);
  const noteLib = contents.get('24 号的实验.md');
  ok(!!noteLib, '建出来了', Array.from(filesByPath.keys()).slice(-3));
  ok(noteLib.indexOf('夹具哨兵句') >= 0, '③正文就是库里那份模板（内置副本里没有这句哨兵）', noteLib.slice(0, 120));
  ok(noteLib.indexOf('KBWB:GENERATED') >= 0, '③成品带常驻指纹');
  ok(/今天到期/.test(noteLib) && /^- \[ \] 夹具：今天要做的/m.test(noteLib), '③库里那份的标记被换成了当天任务',
    noteLib.split('\n').filter((l) => /^- \[.\]/.test(l)).slice(0, 2));
  ok(noteLib.indexOf('{{') < 0, '③没有字面占位符残留');

  // 点另一份 → 用的就是另一份（选哪个用哪个）
  cellOf(String(PD(25))).click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const calModal2 = stub.Modal.last;
  const pickTpl = calModal2.contentEl.findAll('.kbwb-modal-tplrow')
    .find((r) => r.getAttr('title') === '模板/月历测试模板.md');
  ok(!!pickTpl, '列表里能点到「月历测试模板」');
  pickTpl.click();
  ok(pickTpl.classes().indexOf('is-on') >= 0, '点一下就选中');
  const calTitle2 = calModal2.contentEl.findAll('.kbwb-input')[0];
  calTitle2.value = '25 号的另一篇';
  calModal2.contentEl.findAll('button').find((b) => b.textContent === '创建').click();
  await tick(20);
  const noteOther = contents.get('25 号的另一篇.md');
  ok(!!noteOther && noteOther.indexOf('## 要点') >= 0, '选了哪份就用哪份', noteOther && noteOther.slice(0, 60));
  ok(!!noteOther && noteOther.indexOf('夹具哨兵句') < 0, '没串到库里那份的内容');

  console.log('\n[49] 缩放也要让位（用户："放大缩小页面的时候不会让其他页面跟着一起让出位置"）');
  await plugin.resetLayout();
  await view.render();
  await tick();
  // 钉一张在体检卡右边、同一水平带的卡：把体检卡往右拉大就必然压住它
  await plugin.setBox('hygiene', { col: 1, row: 1, w: 16, h: 20 });
  await plugin.setBox('writing', { col: 17, row: 1, w: 12, h: 20 });
  await view.render();
  await tick();
  const hyEl49 = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'hygiene');
  const wrEl49 = root.findAll('.kbwb-card').find((c) => c.dataset.mod === 'writing');
  ok(!!hyEl49 && !!wrEl49, '两张卡都在 DOM 里');
  const wrBox0 = plugin.slotOf('writing');
  const wrStyle0 = wrEl49.style.gridColumn;
  view.beginGesture('resize', mkEv(300, 300), hyEl49, 'hygiene', plugin.slotOf('hygiene'), 'x');
  view.onGestureMove(mkEv(300 + colW * 8, 300));
  eq(hyEl49.style.gridColumn, '1 / span 24', '拖右边把体检卡拉到 24 栏（已经盖住右边的写作量）');
  const nudge49 = root.findAll('.kbwb-nudge');
  ok(nudge49.length >= 1, '缩放途中就画出"谁会让位"的预演框（以前只有拖动才有，缩放途中什么都没有）', nudge49.length);
  ok(nudge49.some((n) => n.dataset.for === 'writing'), '预演框里正是被压住的那张', nudge49.map((n) => n.dataset.for));
  await view.onGestureEnd();
  eq(root.findAll('.kbwb-nudge').length, 0, '松手撤掉预演框');
  eq(plugin.slotOf('hygiene').w, 24, '放大那张保持拉到的尺寸（它是锚，消解不许动它）');
  const wrBox1 = plugin.slotOf('writing');
  ok(wrBox1.col > wrBox0.col, '写作量向右让位了', [wrBox0, wrBox1]);
  eq(wrEl49.style.gridColumn, wrBox1.col + ' / span ' + wrBox1.w, '让位的卡内联坐标跟着写回（松手不整页重建也要更新到它）');
  ok(wrStyle0 !== wrEl49.style.gridColumn, 'DOM 真的变了，不是只写了 data.json');
  const vis49 = plugin.layoutList().filter((s) => s.on);
  let hit49 = null;
  for (let a = 0; a < vis49.length && !hit49; a++) {
    for (let b = a + 1; b < vis49.length && !hit49; b++) {
      const p = vis49[a], q = vis49[b];
      if (p.col < q.col + q.w && q.col < p.col + p.w && p.row < q.row + q.h && q.row < p.row + p.h) hit49 = [p.id, q.id];
    }
  }
  eq(hit49, null, '缩放落定后整版没有任何两卡重叠');

  console.log('\n[50] 同一天「新增笔记」不改标题也要建新的（用户："点了创建新笔记，还是指向原有的笔记"）');
  const D26 = String(PD(26));
  const d26 = new Date(view.calCursor.y, view.calCursor.m, PD(26));
  const day26 = plugin.dailyNameFor(d26);
  const p26a = stub.normalizePath(day26 + '.md');
  cellOf(D26).click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const m50a = stub.Modal.last;
  eq(m50a.contentEl.findAll('.kbwb-input')[0].value, day26, '空白日期：默认标题就是日期名');
  m50a.contentEl.findAll('button').find((b) => b.textContent === '创建').click();
  await tick(20);
  ok(filesByPath.has(p26a), '第一篇建出来了', Array.from(filesByPath.keys()).slice(-3));
  const first26 = contents.get(p26a);

  // 同一天再来一篇：默认标题必须自己让开，否则会命中"同名直接打开"
  cellOf(D26).click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const dm50 = stub.Modal.last;
  ok(/已建 1 篇/.test(dm50.contentEl.find('.kbwb-modal-title').textContent), '先弹"这天已建几篇"', dm50.contentEl.find('.kbwb-modal-title').textContent);
  dm50.contentEl.findAll('button').find((b) => b.textContent === '新增笔记').click();
  await tick(12);
  const m50b = stub.Modal.last;
  const in50b = m50b.contentEl.findAll('.kbwb-input')[0];
  eq(in50b.value, day26 + ' 2', '默认标题自动让开成「日期 2」（撞车根因就在这）');
  m50b.contentEl.findAll('button').find((b) => b.textContent === '创建').click();
  await tick(20);
  const p26b = stub.normalizePath(day26 + ' 2.md');
  ok(filesByPath.has(p26b), '第二篇真的建出来了', Array.from(filesByPath.keys()).slice(-3));
  eq(contents.get(p26a), first26, '第一篇一个字没动（没被覆盖）');
  eq(plugin.dailyNotesFor(d26).length, 2, '这天现在记着两篇');

  // 兜底：用户手动把标题改回撞名的那个，也要照建（不是偷偷打开旧的）
  cellOf(D26).click();
  await tick();
  calNewBtn().click();                        // 新建/已建列表改走卡片底部那个按钮
  await tick(12);

  const dm50c = stub.Modal.last;
  dm50c.contentEl.findAll('button').find((b) => b.textContent === '新增笔记').click();
  await tick(12);
  const m50c = stub.Modal.last;
  const in50c = m50c.contentEl.findAll('.kbwb-input')[0];
  in50c.value = day26;                       // 故意改回撞名的标题
  m50c.contentEl.findAll('button').find((b) => b.textContent === '创建').click();
  await tick(20);
  const p26c = stub.normalizePath(day26 + ' 3.md');
  ok(filesByPath.has(p26c), 'ensureNew 兜底：撞名照建，自动存成「日期 3」', Array.from(filesByPath.keys()).slice(-3));
  eq(plugin.dailyNotesFor(d26).length, 3, '这天记着三篇');

  console.log('\n[51] 待办卡（每日/每周）+ 月历的选中日、红点与卡片底部按钮（第三十二轮）');
  /* 起手把浏览状态摆回"今天 + 每日页签"：待办卡的「每日」跟着 view.calSelected 走，
     而 [50] 收场时选中日是 PD(26) 那天，不清回来下面全按错的日子断言。 */
  view.calSelected = TODAY;
  view.todosMode = null;
  view.todosWeekKey = '';
  const dp51 = plugin.todoFilePath('daily');
  const wp51 = plugin.todoFilePath('weekly');
  eq(dp51, '待办/每日待办.md', 'h) 每日待办文件的默认落点');
  eq(wp51, '待办/每周待办.md', 'h) 每周待办文件的默认落点');
  ok(!filesByPath.has(dp51) && !filesByPath.has(wp51), 'h) 起手：两篇待办文件都还不存在');
  await view.render();
  await tick();

  /* a) 卡片渲染 + 两个页签 */
  const todoCard51 = cardOf('todos');
  ok(!!todoCard51, 'a) 「待办」卡渲染出来了');
  const tabs51 = todoCard51.find('.kbwb-tabs').findAll('.kbwb-tab');
  eq(tabs51.length, 2, 'a) 卡头两个页签', tabs51.map((b) => b.textContent));
  eq(tabs51.map((b) => b.dataset.m).join(','), 'daily,weekly', 'a) 页签的 data-m = daily / weekly');
  eq(tabs51.map((b) => b.textContent).join(','), '每日,每周', 'a) 页签文字');
  ok(tabs51[0].classes().indexOf('is-active') >= 0, 'a) 默认停在「每日」，它带 is-active', tabs51[0].classes());
  ok(tabs51[1].classes().indexOf('is-active') < 0, 'a)「每周」默认不是选中态');
  ok(!!todoCard51.find('.kbwb-todo-list'), 'a) 卡里有 .kbwb-todo-list');
  ok(!!todoCard51.find('.kbwb-empty'), 'a) 这天一条待办都没有 → 用现成的 .kbwb-empty 空态');
  eq((todoCard51.find('.kbwb-chip') || {}).textContent, '', 'a) 空 → chip 不写文案');
  eq((todoCard51.find('.kbwb-chip') || {})._hidden, true, 'a) 空 → chip 隐藏');
  const th51 = todoCard51.findAll('.kbwb-count.kbwb-hint');
  ok(th51.length >= 1 && String(th51[th51.length - 1].textContent).indexOf(dp51) >= 0, 'a) 底部一行 .kbwb-count.kbwb-hint 写了文件路径', th51.map((x) => x.textContent));

  /* h) render() 不许建文件 —— 趁两篇都还不存在时验（读卡只读，不顺手建档） */
  const size51h = filesByPath.size;
  await view.render();
  await tick();
  eq(filesByPath.size, size51h, 'h) 渲一次整版，库里一个文件都没多（render() 不建档）');
  ok(!filesByPath.has(dp51) && !filesByPath.has(wp51), 'h) 渲完之后两篇待办文件仍然不存在');

  /* b) 在待办卡里加一条 → 落进「每日待办.md」 */
  const tc51b = cardOf('todos');
  const form51 = tc51b.find('.kbwb-todo-form');
  ok(!!form51, 'b) 待办卡里有添加框 .kbwb-todo-form');
  ok(!!form51.find('.kbwb-input') && !!form51.find('.kbwb-todo-input'), 'b) 添加框里的输入框同时带 .kbwb-input 与 .kbwb-todo-input');
  eq(form51.find('.kbwb-todo-go').textContent, '加', 'b) 按钮文字是「加」');
  const ti51 = form51.find('.kbwb-todo-input');
  const sizeBefore51b = filesByPath.size;
  ti51.value = '测试待办一条';
  ti51.fire('keydown', { key: 'Enter' });
  await tick();
  ok(filesByPath.has(dp51), 'b) 回车之后真的建出了 ' + dp51, Array.from(filesByPath.keys()).filter((k) => k.indexOf('待办/') === 0));
  eq(filesByPath.size, sizeBefore51b + 1, 'b) 只多了一个文件（没顺手建第二篇）', filesByPath.size - sizeBefore51b);
  const daily51 = contents.get(dp51) || '';
  ok(daily51.indexOf('## ' + TODAY) >= 0, 'b) 文件里出现「## 今天」这一组', daily51);
  ok(/^- \[ \] 测试待办一条$/m.test(daily51), 'b) 正文以「- [ ] 」落在这一组里', daily51);
  const tc51c = cardOf('todos');
  eq((tc51c.find('.kbwb-todo-input') || {}).value, '', 'b) 写完清空输入框');
  const row51 = tc51c.find('.kbwb-todo-list').findAll('.kbwb-todo-row')[0];
  ok(!!row51, 'b) 卡里出现这一条 .kbwb-todo-row');
  ok(row51.classes().indexOf('is-done') < 0, 'b) 未完成的行不带 is-done', row51.classes());
  eq(row51.find('.kbwb-todo-text').find('.kbwb-todo-body').textContent, '测试待办一条', 'b) 正文在 .kbwb-todo-body 里');
  eq(row51.findAll('.kbwb-todo-del')[0].textContent, '×', 'b) 删除按钮文字 ×');
  eq(tc51c.find('.kbwb-chip').textContent, '待办 1', 'b) 有未完成 → chip 写「待办 N」');

  /* c) 点行上的勾 → 文件里变 - [x]，月历那天的红点消失 */
  const box51 = cardOf('todos').find('.kbwb-todo-list').findAll('.kbwb-checkbox')[0];
  ok(!!box51, 'c) 行上有 .kbwb-checkbox');
  box51.click();
  await tick();
  const daily51b = contents.get(dp51) || '';
  ok(/^- \[x\] 测试待办一条$/m.test(daily51b), 'c) 勾一下 → 文件里这一行变成 - [x]', daily51b);
  ok(!/^- \[ \] 测试待办一条$/m.test(daily51b), 'c) 原来那行 - [ ] 不再存在（没多留一条）');
  ok(cardOf('todos').find('.kbwb-todo-list').findAll('.kbwb-todo-row')[0].classes().indexOf('is-done') >= 0, 'c) 行上带 is-done');
  eq(cardOf('todos').find('.kbwb-chip').textContent, '已清空', 'c) 全完成 → chip「已清空」');
  const cellToday51 = cardOf('calendar').findAll('.kbwb-cal-cell').find((x) => x.classes().indexOf('is-today') >= 0);
  ok(!!cellToday51, 'c) 找到「今天」那格');
  ok(cellToday51.classes().indexOf('is-todo') < 0, 'c) 待办全勾掉之后今天不再有 is-todo', cellToday51.classes());
  eq(cellToday51.findAll('.kbwb-cal-dot').length, 0, 'c) 红点元素也跟着消失');

  /* d) 红点：探针日一律走 PD(n)（PD(12) 在 [39] 里点过"取消"，保证没有日记） */
  const key1251 = ymdOf(new Date(view.calCursor.y, view.calCursor.m, PD(12)));
  await plugin.addTodo('daily', key1251, '一条');
  await view.render();          // 纯改状态（直接写文件）不会自动重绘
  await tick();
  const cell1251 = cellOf(String(PD(12)));
  ok(!!cell1251, 'd) 找到 PD(12) 那格');
  eq(cell1251.findAll('.kbwb-cal-num')[0].textContent, String(PD(12)), 'd) 号数对得上');
  ok(cell1251.classes().indexOf('is-todo') >= 0, 'd) 该日有未完成待办 → 新类 is-todo', cell1251.classes());
  eq(cell1251.findAll('.kbwb-cal-dot').length, 1, 'd) 红点是独立的一个 .kbwb-cal-dot', cell1251.classes());
  eq(cell1251.findAll('.kbwb-cal-dot')[0].textContent, '', 'd) .kbwb-cal-dot 是空 span（红点由 CSS 画）');
  ok(cell1251.classes().indexOf('is-has') < 0, 'd) 这天没有日记 → 不带 is-has');
  eq(cell1251.findAll('.kbwb-cal-mark')[0].textContent, '', 'd) 没有日记时 .kbwb-cal-mark 是空串');
  const shared51 = await plugin.todosForRender();
  ok(shared51 === plugin._todosShared, 'd) 一次渲染共用一份扫描（缓存在 plugin._todosShared）');
  eq(shared51.openDaily[key1251], true, 'd) openDaily 里有这个探针日');
  ok(!shared51.openDaily[TODAY], 'd) 全勾掉的那天不在 openDaily 里', Object.keys(shared51.openDaily || {}));
  const cellToday51d = cardOf('calendar').findAll('.kbwb-cal-cell').find((x) => x.classes().indexOf('is-today') >= 0);
  ok(cellToday51d.classes().indexOf('is-todo') < 0, 'd) 整版重绘之后，全勾掉的那天仍然不 is-todo');
  eq(cellToday51d.findAll('.kbwb-cal-dot').length, 0, 'd) 全勾掉的那天没有 .kbwb-cal-dot');
  /* ● 与红点共存：PD(20) 那天在 [45][46] 已经有两篇日记，再给它加一条未完成待办 */
  const key2051 = ymdOf(new Date(view.calCursor.y, view.calCursor.m, PD(20)));
  await plugin.addTodo('daily', key2051, '另一条');
  await view.render();
  await tick();
  const cell2051 = cellOf(String(PD(20)));
  ok(!!cell2051, 'd) 找到 PD(20) 那格');
  ok(cell2051.classes().indexOf('is-has') >= 0, 'd) 有日记 → is-has');
  ok(cell2051.classes().indexOf('is-todo') >= 0, 'd) 同一天还有未完成待办 → is-todo（两个标记共存）', cell2051.classes());
  eq(cell2051.findAll('.kbwb-cal-mark')[0].textContent, '●', 'd) ● 仍写在 .kbwb-cal-mark 的文字里');
  eq(cell2051.findAll('.kbwb-cal-dot').length, 1, 'd) 共存时红点还是独立一个元素（没把 ● 顶掉）');

  /* e) 点格子只选中：不弹框、格子 is-sel、当日面板跟着换 */
  const modalBefore51e = stub.Modal.last;
  const sizeBefore51e = filesByPath.size;
  cell2051.click();
  await tick();
  ok(stub.Modal.last === modalBefore51e, 'e) 点格子不弹任何框（Modal.last 引用没变过）');
  ok(!stub.Modal.last || !stub.Modal.last.isOpen, 'e) 也没有框是开着的');
  eq(filesByPath.size, sizeBefore51e, 'e) 点格子也不建任何文件（前后一样多）');
  const cal51e = cardOf('calendar');
  ok(!!cellOf(String(PD(20))) && cellOf(String(PD(20))).classes().indexOf('is-sel') >= 0, 'e) 被点的那一格带上 is-sel', cellOf(String(PD(20))) && cellOf(String(PD(20))).classes());
  eq(cal51e.findAll('.kbwb-cal-cell').filter((x) => x.classes().indexOf('is-sel') >= 0).length, 1, 'e) 同时只有一格是选中态');
  const dayWrap = cal51e.find('.kbwb-cal-day');
  ok(!!dayWrap, 'e) 卡里有当日待办面板 .kbwb-cal-day');
  eq(dayWrap.dataset.date, key2051, 'e) 面板 dataset.date = 选中那天');
  const dayHead = dayWrap.find('.kbwb-cal-day-head');
  ok(/^\d{4}-\d{2}-\d{2} 周.$/.test(dayHead.find('.kbwb-cal-day-date').textContent), 'e) 日期行是「YYYY-MM-DD 周X」', dayHead.find('.kbwb-cal-day-date').textContent);
  eq(dayHead.find('.kbwb-cal-day-count').textContent, '待办 1', 'e) 计数写「待办 N」');
  const dayForm51 = dayWrap.find('.kbwb-todo-form');
  ok(!!dayForm51 && !!dayForm51.find('.kbwb-todo-input') && dayForm51.find('.kbwb-todo-go').textContent === '加', 'e) 面板自己也带一个添加框');
  const dayList51 = dayWrap.find('.kbwb-cal-day-list');
  eq(dayList51.findAll('.kbwb-todo-row').length, 1, 'e) 面板里列出那天的待办行');
  ok(/另一条/.test(dayList51.findAll('.kbwb-todo-row')[0].textContent), 'e) 行的正文对得上');
  const foot51 = cal51e.find('.kbwb-cal-foot');
  ok(!!foot51, 'e) 卡片底部有 .kbwb-cal-foot');
  eq(foot51.findAll('.kbwb-cal-new')[0].textContent, '＋ 新建笔记', 'e) 底部按钮文字「＋ 新建笔记」');
  const notes20 = plugin.dailyNotesFor(new Date(view.calCursor.y, view.calCursor.m, PD(20)));
  // 第三十五轮：这里原来断的是「笔记 N 篇」按钮，用户要求改成直接显示文件名
  const notesRow51 = cal51e.find('.kbwb-cal-notes');
  ok(!!notesRow51, 'e) 选中日已有日记 → 底部直接列文件名那一行');
  const chips51 = notesRow51 ? notesRow51.findAll('.kbwb-cal-note') : [];   // 回归时是 null：红得干净，别抛
  eq(chips51.map((b) => b.textContent).join(','),
    notes20.slice(0, 3).map((f) => f.basename).join(','), 'e) chip 文案就是那几篇的文件名（不带 .md）', chips51.map((b) => b.textContent));
  ok(!cal51e.find('.kbwb-cal-open'), 'e)「笔记 N 篇」那个按钮已经不存在了');
  ok(!foot51.find('.kbwb-cal-open'), 'e) 脚上也没有（同一个卡里搜不到）');
  const hint51 = cal51e.findAll('.kbwb-count.kbwb-hint');
  ok(String(hint51[hint51.length - 1].textContent).indexOf('● = 有日记｜红点 = 有未完成待办｜日记位置：') === 0, 'e) 最底那行图例改成新文案', String(hint51[hint51.length - 1].textContent).slice(0, 40));
  // 选中日不是今天 → 整版重绘一次，让待办卡的「每日」跟上选中日，并出现「回今天」
  await view.render();
  await tick();
  const tc51f = cardOf('todos');
  const head51 = tc51f.find('.kbwb-todo-head');
  ok(String(head51.find('.kbwb-todo-when').textContent).indexOf(key2051) === 0, 'e)「每日」页签跟着选中日走（刚点的就是 PD(20) 那天）', head51.find('.kbwb-todo-when').textContent);
  const backToday = head51.find('.kbwb-todo-today');
  ok(!!backToday && backToday.textContent === '回今天', 'e) 选中日不是今天 → 有「回今天」按钮');
  backToday.click();
  await tick();
  eq(view.calSelected, TODAY, 'e) 点「回今天」把选中日改回今天');

  /* f) 底部那个按钮走的正是原来那条链 */
  const modBefore51f = stub.Modal.last;
  cardOf('calendar').find('.kbwb-cal-foot').findAll('.kbwb-cal-new')[0].click();
  await tick(12);
  const dayM51 = stub.Modal.last;
  ok(!!dayM51 && dayM51 !== modBefore51f && dayM51.isOpen, 'f) 选中日已有日记 → 底部按钮弹的是 DayNotesModal');
  ok(!!dayM51.contentEl.find('.kbwb-dayrow'), 'f) 框里是「这天已建几篇」的行');
  btnIn(dayM51.contentEl, '关闭').click();
  await tick(12);
  cellOf(String(PD(12))).click();
  await tick();
  const foot12 = cardOf('calendar').find('.kbwb-cal-foot');
  ok(!cardOf('calendar').find('.kbwb-cal-notes'), 'f) 空白那天没有文件名那一行（只剩「＋ 新建笔记」）');
  ok(!foot12.find('.kbwb-cal-open'), 'f) 也不许有旧的「笔记 N 篇」按钮复活');
  const modBefore51g = stub.Modal.last;
  foot12.findAll('.kbwb-cal-new')[0].click();
  await tick(12);
  const ask51 = stub.Modal.last;
  ok(!!ask51 && ask51 !== modBefore51g && ask51.isOpen, 'f) 空白日期 → 同一个按钮弹的是 NameModal（标题确认框）');
  ok(/为 \d{4}-\d{2}-\d{2} 建立笔记/.test(ask51.contentEl.find('.kbwb-modal-hint').textContent), 'f) 提示里写清是为哪一天建的', ask51.contentEl.find('.kbwb-modal-hint').textContent);
  eq(plugin.dailyNotes[key1251], undefined, 'f) 弹框本身不记映射');
  const sizeBefore51c = filesByPath.size;
  btnIn(ask51.contentEl, '取消').click();
  await tick(12);
  eq(filesByPath.size, sizeBefore51c, 'f) 取消 = 一个文件都不建');

  /* g) 切「每周」：周键走 ISO 周（周一起算），写的是另一篇文件 */
  const tabs51g = cardOf('todos').find('.kbwb-tabs').findAll('.kbwb-tab');
  tabs51g[1].click();
  await tick();
  ok(tabs51g[1].classes().indexOf('is-active') >= 0, 'g) 切过去之后「每周」是选中态');
  ok(tabs51g[0].classes().indexOf('is-active') < 0, 'g)「每日」不再是选中态');
  const wk51 = KbWorkbenchPlugin.isoWeekKey(new Date());
  const whenW = cardOf('todos').find('.kbwb-todo-head').find('.kbwb-todo-when').textContent;
  ok(whenW.indexOf('-W') >= 0, 'g) 周签头部含 ISO 周键', whenW);
  ok(whenW.indexOf(wk51) === 0, 'g) 周键 = isoWeekKey(今天)', { whenW, wk51 });
  ok(/^\d{4}-W\d{2}｜\d+月\d+日 ~ \d+月\d+日$/.test(whenW), 'g) 形状是「2026-W45｜11月2日 ~ 11月8日」', whenW);
  const prevW = cardOf('todos').find('.kbwb-todo-head').find('.kbwb-todo-w');
  ok(!!prevW && prevW.textContent === '‹ 上一周', 'g) 每周页签有「‹ 上一周」');
  const tiw = cardOf('todos').find('.kbwb-todo-form').find('.kbwb-todo-input');
  ok(!!tiw, 'g) 每周页签也有添加框');
  tiw.value = '每周一条';
  tiw.fire('keydown', { key: 'Enter' });
  await tick();
  ok(filesByPath.has(wp51), 'g) 每周那条落到另一篇文件：' + wp51);
  const weekly51 = contents.get(wp51) || '';
  ok(weekly51.indexOf('## ' + wk51) >= 0, 'g) 分组键就是 isoWeekKey(今天)', weekly51);
  ok(/^- \[ \] 每周一条$/m.test(weekly51), 'g) 正文落在这一周里', weekly51);
  ok((contents.get(dp51) || '').indexOf('每周一条') < 0, 'g) 没串到每日那篇里');
  prevW.click();
  await tick();
  const prevKey = KbWorkbenchPlugin.shiftWeekKey(wk51, -1);
  ok(String(cardOf('todos').find('.kbwb-todo-when').textContent).indexOf(prevKey) === 0, 'g)「‹ 上一周」把周键往前挪一格', cardOf('todos').find('.kbwb-todo-when').textContent);
  const backWeek = cardOf('todos').find('.kbwb-todo-head').find('.kbwb-todo-today');
  ok(!!backWeek && backWeek.textContent === '回本周', 'g) 不在本周时给「回本周」');
  backWeek.click();
  await tick();
  ok(String(cardOf('todos').find('.kbwb-todo-when').textContent).indexOf(wk51) === 0, 'g) 点「回本周」回到本周');

  /* i) 这两篇里的勾不进全库任务清单（故意的：与「任务」「到期日历」两条路分开） */
  const dp51txt = contents.get(dp51) || '';
  ok(/^- \[[ x]\]/m.test(dp51txt), 'i) 每日那篇里确实有任务行（不是拿空文件凑数）', dp51txt);
  ok(plugin.isTodoFile(dp51) && plugin.isTodoFile(wp51), 'i) isTodoFile 认得这两篇');
  ok(!plugin.isTodoFile('实习/讲解待办/REA介绍与DSH接入判断.md'), 'i) 别的文件不误伤');
  const tasks51 = await plugin.collectTasks();
  eq(tasks51.filter((t) => t.file.path === dp51).length, 0, 'i) collectTasks() 里没有每日那篇的条目');
  eq(tasks51.filter((t) => t.file.path === wp51).length, 0, 'i) 每周那篇也不进');
  ok(tasks51.length > 0, 'i) 任务清单本身照常工作（不是整张卡空了）', tasks51.length);
  console.log('\n[52] 单卡重建不许重播入场动效（用户真机反馈：「点月历的日期，整个月历卡闪一下」）');
  /* 根因链（DOM 垫片跑不了 CSS 动画，所以 612 条全绿也抓不住它）：
     render() 只在【下一次整版渲染】开头摘掉 .kbwb-animate ⇒ 首屏之后它一直挂在宿主上；
     而 _refreshCardNow 插进网格的是一个全新节点，card() 又给它写了 --i（且 cardIndex 每次重建 +1）
     ⇒ 命中 .kbwb-animate .kbwb-card ⇒ fill-mode both ⇒ 新卡在 --i*32ms 里整块 opacity:0，再淡入 0.4s
     ⇒ 用户看到「闪一下」，而且点得越多 --i 越大、闪得越久。 */
  const host52 = view.contentEl;
  host52.addClass('kbwb-animate');   // 复现真机状态：刚开完面板、还没经历第二次整版渲染
  const cal52old = cardOf('calendar');
  ok(host52.classes().indexOf('kbwb-animate') >= 0, 'a) 前提：宿主带着 .kbwb-animate（旧版就是靠它把重建的卡点亮成入场）');
  const cell52 = cellOf(String(PD(12)));
  ok(!!cell52, 'b) 找到探针日那一格');
  cell52.click();
  await tick();
  const cal52 = cardOf('calendar');
  ok(cal52 !== cal52old, 'b) 点日期走的确实是「换一个新节点」（不是原地改类，所以才会撞上入场动效）');
  ok(cal52.classes().indexOf('kbwb-no-rise') >= 0, 'b) 换进来的新节点带 kbwb-no-rise', cal52.classes());
  eq(cal52.style.getPropertyValue('--i'), '0', 'b) 新节点的 --i 归零（旧版这里是不断累加的 cardIndex = 延迟越来越长）', cal52.style.getPropertyValue('--i'));
  const todos52 = cardOf('todos');
  ok(todos52.classes().indexOf('kbwb-no-rise') >= 0, 'c) 联动的待办卡同样不许重播（refreshTodoLinked 刷两张）', todos52.classes());
  const grid52 = view.contentEl.find('.kbwb-grid');
  eq(grid52.findAll('.kbwb-card').length, 14, 'c) 换入换出没留重复卡（14 张还在原位）');
  ok(!!cellOf(String(PD(12))) && cellOf(String(PD(12))).classes().indexOf('is-sel') >= 0, 'c) 该做的还是做了：选中日跟着走');
  await view.render();
  await tick();
  const cal52r = cardOf('calendar');
  ok(cal52r.classes().indexOf('kbwb-no-rise') < 0, 'd) 整版渲染出来的卡【不带】kbwb-no-rise（别把首屏水落入场一起关掉）', cal52r.classes());
  ok(host52.classes().indexOf('kbwb-animate') < 0, 'd) 整版渲染会摘掉 .kbwb-animate（第二道防线，别删 render() 开头那句）');


  console.log('\n[53] 写作量的「无基线」不许塞进柱子轨道里（用户真机截图：文字被挤压）');
  /* 症状：12px 的行盒装进 height:6px + overflow:hidden 的 .kbwb-write-bar-track ⇒ 上下各切 ~3px。
     真浏览器实测（preview.html?audit=1 的 writeBars 行）修复前 = 「11/1 被切 7px」。 */
  plugin.writingLog = {};
  plugin.statsCache = null; plugin.statsJob = null;
  const words53 = (await plugin.computeStats()).words;
  plugin.writingLog[dstr(-1)] = words53 - 188;   // 与用户截图同形：只有昨天+今天两个基线
  await view.render();
  await tick();
  const wr53 = cardOf('writing');
  const rows53 = wr53.findAll('.kbwb-write-bar-row');
  eq(rows53.length, 7, 'a) 七天七行（这一条不是本轮改的，钉住别被顺手弄坏）');
  const none53 = wr53.findAll('.kbwb-write-bar-none');
  const fill53 = wr53.findAll('.kbwb-write-bar-fill');
  eq(none53.length, 6, 'b) 六行「无基线」（只有今天有差值）', none53.length);
  eq(fill53.length, 1, 'b) 一根真柱子');
  eq(wr53.findAll('.kbwb-write-bar-track').length, 1, 'b) 轨道也只有 1 个 —— 没数的那些天不再需要轨道');
  none53.forEach((el, i) => {
    // 断言失败时别把 DOM 节点丢给 JSON.stringify（循环引用会把整个 harness 崩掉，回归就看不全了）
    ok(!el.closest('.kbwb-write-bar-track'),
      'c) 第 ' + (i + 1) + ' 个「无基线」不在轨道里（6px + overflow:hidden 会切字）',
      '父链=' + (el.parentNode ? el.parentNode.classes().join('.') : '无父'));
    ok((el.parentNode ? el.parentNode.classes() : []).indexOf('kbwb-write-bar-row') >= 0,
      'c) 第 ' + (i + 1) + ' 个「无基线」的直接父是行本身',
      '父类=' + (el.parentNode ? el.parentNode.classes().join('.') : '无父'));
  });
  eq(rows53.filter((r) => r.findAll('.kbwb-write-bar-none').length === 1 && r.findAll('.kbwb-write-bar-fill').length === 0).length, 6,
    'd) 无基线的行恰好是「有 none、无 fill」那六行');
  eq(rows53.filter((r) => r.findAll('.kbwb-write-bar-fill').length === 1 && r.findAll('.kbwb-write-bar-none').length === 0).length, 1,
    'd) 有数的行恰好是「有 fill、无 none」那一行');
  const noneRow53 = rows53.find((r) => r.findAll('.kbwb-write-bar-none').length === 1);
  eq(noneRow53.findAll('.kbwb-write-bar-val')[0].textContent, '—', 'e) 无基线那行的数值列仍是「—」（改结构没把右侧弄丢）');
  eq(noneRow53.children.length, 3, 'e) 那一行还是三列：日期 / 无基线 / —（列对齐没塌）', noneRow53.children.length);
  const fillRow53 = rows53.find((r) => r.findAll('.kbwb-write-bar-fill').length === 1);
  ok(/%$/.test(fillRow53.findAll('.kbwb-write-bar-fill')[0].style.width || ''), 'f) 柱子的百分比宽度照常写', fillRow53.findAll('.kbwb-write-bar-fill')[0].style.width);
  ok(String(fillRow53.findAll('.kbwb-write-bar-fill')[0].getAttr('title') || '').indexOf('字') >= 0, 'f) 柱子的 title 提示没丢', fillRow53.findAll('.kbwb-write-bar-fill')[0].getAttr('title'));
  plugin.writingLog = {};

  console.log('\n[54] 月历翻月只重建月历卡（用户真机反馈：「在月份间切换的时候还是会有重载的问题，还是会跳」）');
  /* 翻月只改 this.calCursor，而 calCursor 全文件只有 buildCalendarCard 读（2878-2879）。
     原来这里写 this.render()：整版重绘 14 张卡 ⇒ 其它 13 张的节点全换新、各自滚动靠还原表兜，
     新内容高度一旦不同就被夹住 —— 用户看到的「重载/跳」就是这个。下面这条把「不许跳」写成可证伪的形式：
     别的卡必须是同一批节点对象。 */
  await view.render();
  await tick();
  let renderCalls54 = 0;
  const origRender54 = view.render.bind(view);
  view.render = function () { renderCalls54++; return origRender54.apply(this, arguments); };
  const cards54before = root.findAll('.kbwb-card');
  eq(cards54before.length, 14, 'a) 起手 14 张卡');
  const byId54 = {}; cards54before.forEach((x) => { byId54[x.dataset.mod] = x; });
  const cur54 = { y: view.calCursor.y, m: view.calCursor.m };
  const py = cur54.m === 0 ? cur54.y - 1 : cur54.y, pm = cur54.m === 0 ? 11 : cur54.m - 1;
  const prevChip54 = py + '·' + (pm + 1);
  const daysPrev54 = new Date(py, pm + 1, 0).getDate();
  const navBtns54 = byId54.calendar.findAll('.kbwb-cal-navbtn');
  eq(navBtns54.map((b) => b.textContent).join(','), '‹,本月,›', 'b) 三个翻月按钮都在');
  navBtns54[0].click();
  await tick(12);
  eq(renderCalls54, 0, 'c) 翻月【没有】走整版 render()（这就是「不跳」的判据）', renderCalls54);
  const cal54 = cardOf('calendar');
  ok(cal54 !== byId54.calendar, 'c) 月历卡确实被换成了新节点（不是没反应）');
  const sameOthers54 = Object.keys(byId54).filter((id) => id !== 'calendar' && cardOf(id) === byId54[id]);
  eq(sameOthers54.length, 13, 'd) 其余 13 张卡必须是原来那批节点（被换新 = 用户看到的跳）', sameOthers54.length);
  eq(String(cal54.find('.kbwb-chip').textContent), prevChip54, 'd) chip 翻到了上一月', cal54.find('.kbwb-chip').textContent);
  const dayCells54 = cal54.findAll('.kbwb-cal-cell').filter((x) => String(x.find('.kbwb-cal-num').textContent || '').trim() !== '');
  eq(dayCells54.length, daysPrev54, 'e) 新月份的天数对（' + prevChip54 + ' 应有 ' + daysPrev54 + ' 格）', dayCells54.length);
  eq(root.findAll('.kbwb-card').length, 14, 'e) 重建没留重复卡、也没丢卡');
  const nav2 = cardOf('calendar').findAll('.kbwb-cal-navbtn');
  nav2[1].click();
  await tick(12);
  eq(renderCalls54, 0, 'f)「本月」也只重建月历卡', renderCalls54);
  eq(String(cardOf('calendar').find('.kbwb-chip').textContent), cur54.y + '·' + (cur54.m + 1), 'f)「本月」把月份翻回来了');
  // 故意留下的例外：标签转搜索要消费 jumpToSearch（render() 里第 1199 行），必须走整版
  plugin.statsCache = null;
  const tag54 = root.findAll('.kbwb-tag')[0];
  ok(!!tag54, 'g) 统计卡里有标签胶囊（用来钉住那条故意保留的整版路径）');
  const calls54g = renderCalls54;
  tag54.click();
  await tick(12);
  ok(renderCalls54 > calls54g, 'g) 点标签仍走整版 render()（jumpToSearch 需要它，别被同族清扫掉）', { before: calls54g, after: renderCalls54 });
  eq(view.jumpToSearch, false, 'g) 标记被这次渲染消费掉了');
  view.render = origRender54;
  ok(typeof view.render === 'function', 'h) 计数包装已还原（测试污染过 [30b] 一次，别再犯）');

  console.log('\n[55] 日记改了名字仍然算那天的日记（用户：「我按照日记文档创建之后改了名字就不算日记了」）');
  plugin.coreConfig = { dailyFolder: '每日笔记', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' };
  view.calSelected = TODAY;
  view.calCursor = { y: now.getFullYear(), m: now.getMonth() };
  const day55 = PD(15);
  const key55 = ymdOf(new Date(view.calCursor.y, view.calCursor.m, day55));
  const old55 = '每日笔记/' + key55 + '.md';
  mkFile(old55, '# ' + key55 + ' 日记\n', Date.now());
  plugin.dailyNotes = {};
  plugin.rememberDailyNote(key55, old55);
  plugin._dailyIndex = null;
  await view.render();
  await tick();
  const cell55 = cellOf(String(day55));
  ok(!!cell55 && cell55.classes().indexOf('is-has') >= 0, 'a) 改名前这天标着 ●');
  // 真机改名：文件换路径 + 发 rename 事件（桩现在真的派发，测的是接线不是方法）
  let cur55 = old55;                                   // 夹具自己记住文件现在在哪，别靠猜路径前缀
  const moveTo55 = (np) => {
    const f = filesByPath.get(cur55);
    if (!f) return null;
    const body = contents.get(cur55) || '';
    contents.delete(cur55); filesByPath.delete(cur55);
    f.path = np; f.name = np.slice(np.lastIndexOf('/') + 1); f.basename = f.name.replace(/\.md$/i, '');
    filesByPath.set(np, f); contents.set(np, body);
    cur55 = np;
    return f;
  };
  const new55 = '每日笔记/' + key55 + ' 随笔.md';
  const f55 = moveTo55(new55);
  ok(!!f55, 'b) 夹具把文件搬走了（旧路径已不存在）');
  eq(plugin.dailyNotes[key55].join(','), old55, 'b) 事件还没发 ⇒ 映射仍指着旧路径（这就是用户看到的坏状态）');
  plugin._dailyIndex = null;
  vault.trigger('rename', f55, old55);
  await tick(12);
  eq(plugin.dailyNotes[key55].join(','), new55, 'c) rename 事件把映射搬到新路径（接线通）', plugin.dailyNotes[key55]);
  await view.render();
  await tick();
  const cell55c = cellOf(String(day55));
  ok(!!cell55c && cell55c.classes().indexOf('is-has') >= 0, 'c) 改名后这天仍然标 ●（用户报的就是它没了）', cell55c && cell55c.classes());
  eq(cell55c.findAll('.kbwb-cal-mark')[0].textContent, '●', 'c) ● 这个字符还在');
  cell55c.click();
  await tick(12);
  const foot55 = cardOf('calendar').find('.kbwb-cal-foot');
  const notesRow55 = cardOf('calendar').find('.kbwb-cal-notes');
  ok(!!notesRow55, 'd) 底部有文件名那一行');
  const chips55 = notesRow55 ? notesRow55.findAll('.kbwb-cal-note') : [];
  eq(chips55.map((b) => b.textContent).join(','), key55 + ' 随笔',
    'd) 显示的是【改名后】那篇的文件名（不再是「笔记 1 篇」）', chips55.map((b) => b.textContent));
  // e) 改名发生在插件没运行时（外部工具/同步盘）：没有 rename 事件，靠日期前缀兜底
  const new55b = '每日笔记/' + key55 + ' 手记.md';
  moveTo55(new55b);
  plugin.dailyNotes = {}; plugin.dailyNotes[key55] = [old55];
  plugin._dailyIndex = null;
  await view.render();
  await tick();
  const cell55e = cellOf(String(day55));
  ok(!!cell55e && cell55e.classes().indexOf('is-has') >= 0, 'e) 映射坏掉、没有事件，也按「文件名以日期开头」认出这天', cell55e && cell55e.classes());
  // f) 边界：名字不以日期开头 + 没有事件 ⇒ 不算（不瞎猜）
  const new55c = '每日笔记/无题.md';
  moveTo55(new55c);
  plugin.dailyNotes = {}; plugin.dailyNotes[key55] = [old55];
  plugin._dailyIndex = null;
  await view.render();
  await tick();
  const cell55f = cellOf(String(day55));
  ok(!!cell55f && cell55f.classes().indexOf('is-has') < 0, 'f) 名字不以日期开头又没有事件 ⇒ 不硬猜（边界写死）', cell55f && cell55f.classes());
  // g) 启动补映射：坏路径被补成真实存在的那篇（用户库里 2026-11-09 就是这个形状）
  moveTo55(new55);
  plugin.dailyNotes = {}; plugin.dailyNotes[key55] = [old55];
  plugin._dailyIndex = null;
  const rep55 = plugin.repairDailyNotes();
  ok(rep55 === true, 'g) repairDailyNotes 报告改了');
  eq(plugin.dailyNotes[key55].join(','), new55, 'g) 坏路径被补成真实那篇', plugin.dailyNotes[key55]);
  plugin.dailyNotes = {}; plugin._dailyIndex = null; plugin.coreConfig = null;

  console.log('\n[56] 月历底部直接列文件名（用户：「在月历下面不用显示"笔记一篇"了，直接显示文件名称」）');
  plugin.coreConfig = { dailyFolder: '每日笔记', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' };
  view.calCursor = { y: now.getFullYear(), m: now.getMonth() };
  const dayA = PD(7);
  const keyA = ymdOf(new Date(view.calCursor.y, view.calCursor.m, dayA));
  const pA = '每日笔记/' + keyA + '.md';
  mkFile(pA, '# A\n', Date.now());
  plugin.dailyNotes = {}; plugin.rememberDailyNote(keyA, pA);
  plugin._dailyIndex = null;
  view.calSelected = keyA;
  await view.render();
  await tick();
  const calA = cardOf('calendar');
  const rowA = calA.find('.kbwb-cal-notes');
  ok(!!rowA, 'a) 有笔记的日子出现文件名那一行');
  const chipsA = rowA ? rowA.findAll('.kbwb-cal-note') : [];        // 回归时 rowA 会是 null：让它红得干净，别抛异常遮住后面的断言
  eq(chipsA.map((b) => b.textContent).join(','), keyA, 'a) 文案就是文件名（不带 .md）', chipsA.map((b) => b.textContent));
  ok(!!rowA && !!rowA.closest('.kbwb-cal-bottom'), 'a) 那一行在 sticky 的 bottom 块里（滚到下面也看得见，不会掉回普通流）');
  const opA = openedPaths.length;
  if (chipsA[0]) chipsA[0].click();
  await tick();
  eq(openedPaths.length, opA + 1, 'b) 点文件名 = 打开那篇');
  eq(openedPaths[openedPaths.length - 1].path, pA, 'b) 打开的就是它（原来那个按钮写着 N 篇却只开第一篇）');
  for (const suf of [' 随笔', ' 复盘', ' 手记']) {
    const q = '每日笔记/' + keyA + suf + '.md';
    mkFile(q, '# x\n', Date.now() + 1000);
    plugin.rememberDailyNote(keyA, q);
  }
  plugin._dailyIndex = null;
  await view.render();
  await tick();
  const rowC = cardOf('calendar').find('.kbwb-cal-notes');
  const chipsC = rowC ? rowC.findAll('.kbwb-cal-note') : [];
  eq(chipsC.length, 4, 'c) 四篇 = 三个文件名 + 一个「另有 1 篇」', chipsC.map((b) => b.textContent));
  eq(chipsC[3] ? chipsC[3].textContent : '', '另有 1 篇', 'c) 第四个是溢出提示');
  ok(!!chipsC[3] && chipsC[3].classes().indexOf('is-more') >= 0, 'c) 溢出那颗带 is-more');
  eq(chipsC.slice(0, 3).filter((b) => String(b.textContent).indexOf(keyA) === 0).length, 3, 'c) 前三颗都是这天的文件名');
  const modBeforeC = stub.Modal.last;
  if (chipsC[3]) chipsC[3].click();
  await tick(12);
  ok(stub.Modal.last !== modBeforeC && !!stub.Modal.last && stub.Modal.last.isOpen, 'c) 点「另有 N 篇」才弹列表弹框（≤3 篇时不该再弹）');
  eq(stub.Modal.last && stub.Modal.last.contentEl ? stub.Modal.last.contentEl.findAll('.kbwb-dayrow').length : -1, 4, 'c) 列表里是全部四篇');
  const closeC = stub.Modal.last.contentEl.findAll('button').find((b) => b.textContent === '关闭');
  if (closeC) { closeC.click(); await tick(12); }
  ok(!/笔记 \d+ 篇/.test(cardOf('calendar').textContent), 'd) 整张卡里不再有「笔记 N 篇」这种文案', String(cardOf('calendar').textContent).match(/笔记 \d+ 篇/));
  view.calSelected = ymdOf(new Date(view.calCursor.y, view.calCursor.m, PD(8)));
  await view.render();
  await tick();
  ok(!cardOf('calendar').find('.kbwb-cal-notes'), 'e) 空白那天不画空行（sticky 块高度不变）');
  plugin.dailyNotes = {}; plugin._dailyIndex = null; plugin.coreConfig = null;

  console.log('\n[57] 第三十七轮体检：计数改查表后不许引入跨渲染的陈旧缓存');
  /* 按天 memo 试过又撤了：一次渲染里 30 个格子问的是 30 个不同日期，memo 只省 1 次调用，
     却引出【跨渲染读到旧结果】的生命周期问题（当时 [39] 立刻红）。这里把「不许缓存跨渲染存活」钉住。 */
  plugin.coreConfig = { dailyFolder: '每日笔记', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' };
  view.calCursor = { y: now.getFullYear(), m: now.getMonth() };
  const day57 = PD(21), key57 = ymdOf(new Date(view.calCursor.y, view.calCursor.m, day57));
  const p57 = '每日笔记/' + key57 + '.md';
  plugin.dailyNotes = {}; plugin._dailyIndex = null;
  await view.render(); await tick();
  ok(!cellOf(String(day57)).classes().includes('is-has'), 'a) 起手这天没有日记');
  mkFile(p57, '# 五十七\n', Date.now() + 5000);
  plugin._dailyIndex = null;                       // 桩里 mkFile 不发 vault 事件，手动清前缀索引（真机由 create 事件清）
  await view.render(); await tick();
  ok(!!cellOf(String(day57)) && cellOf(String(day57)).classes().includes('is-has'), 'b) 新建之后重绘立刻标上 ● —— 没有跨渲染的旧结果');
  const first57 = plugin.dailyNotesFor(new Date(view.calCursor.y, view.calCursor.m, day57));
  const second57 = plugin.dailyNotesFor(new Date(view.calCursor.y, view.calCursor.m, day57));
  ok(Array.isArray(first57) && first57.length === 1, 'c) 两次调用都拿到一条');
  ok(first57 !== second57, 'c) 两次返回的不是同一个数组对象 ⇒ 确实没做按天缓存（撤对了）');
  // 月历格子的 title 用 todosForRender 一次算好的计数
  await plugin.addTodo('daily', key57, '一条');
  await plugin.addTodo('daily', key57, '两条');
  plugin._todosShared = null;
  await view.render(); await tick();
  const c57 = cellOf(String(day57));
  ok(/待办 2 条/.test(String(c57.getAttr('title') || '')), 'd) title 里的「待办 N 条」来自 openCountDaily，数值对', c57.getAttr('title'));
  view.calSelected = key57;
  await view.render();
  await tick();
  const dayList57 = cardOf('calendar').find('.kbwb-cal-day-list');
  const boxes57 = dayList57 ? dayList57.findAll('.kbwb-checkbox') : [];
  eq(boxes57.length, 2, 'e) 当日面板列出这天的两条（走真 UI，不手填行号）', boxes57.length);
  boxes57[0].click();
  await tick(12);
  ok(/待办 1 条/.test(String(cellOf(String(day57)).getAttr('title') || '')),
    'e) 勾掉一条后 title 的计数跟着变（不是写死的）', cellOf(String(day57)).getAttr('title'));
  plugin.dailyNotes = {}; plugin._dailyIndex = null; plugin.coreConfig = null;

  console.log('\n----------------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nRENDER HARNESS ERROR:', err && err.stack ? err.stack : err);
  process.exit(2);
});