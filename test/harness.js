'use strict';
/*
 * kb-workbench 冒烟测试：用 obsidian 桩模块加载真实 main.js，
 * 跑数据层（任务扫描 / 勾选回写 / 目录树 / 统计 / 最近编辑）。
 * 只读，不写笔记库。运行：node test/harness.js
 */

const Module = require('module');
const fs = require('fs');
const path = require('path');

const stubPath = path.join(__dirname, 'obsidian-stub.js');
const stub = require(stubPath);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return stubPath;
  return origResolve.call(this, request, ...rest);
};

const PLUGIN = process.env.KBWB_MAIN || path.join(__dirname, '..', 'main.js');
/** 真实笔记库：[24] 要从磁盘上读「模板/每日任务模板.md」来对内置那份的结构（bench/scan-effect 同样直接吃真实库） */
const VAULT = process.env.KBWB_VAULT || path.join(__dirname, '..', 'vault');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, { actual, expected });
}

/* ------------------------------------------------ 假库 */

const pad = (n) => (n < 10 ? '0' + n : String(n));
const now = new Date();
const TODAY = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
const YESTERDAY = (() => { const d = new Date(Date.now() - 86400000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); })();

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

mkFile('A/写报告.md', [
  '# 写报告',
  '',
  '- [ ] 写季度报告 📅' + YESTERDAY,
  '- [ ] 今天要做的 📅' + TODAY,
  '- [x] 已完成的事 ✅' + TODAY,
  '- [ ] 没有日期的任务',
  '  - [ ] 子任务 #today',
  '- [ ] ',                     // 只有标记、没有正文的空任务（在普通笔记里，不是模板文件里）
].join('\n'), Date.now() - 5 * 60000);

mkFile('A/B/资料.md', [
  '---',
  'tags: [研究, 资料]',
  '---',
  '',
  '## 小标题',
  '这里有 #标签 与一些中文内容 words here.',
].join('\n'), Date.now() - 60 * 60000);

mkFile('z-根笔记.md', [
  '- [ ] 根目录任务',
].join('\n'), Date.now() - 120 * 60000);

mkFile('附件/图.png', 'binary-ish', Date.now() - 10 * 60000);

// 任务噪音三类：排除目录 / 模板占位 / 重复内容（都来自真实库的情况）
mkFile('raw/导入资料.md', [
  '- [ ] 导入资料里的勾选框',
  '- [ ] 另一条导入的勾选框',
].join('\n'), Date.now() - 40 * 60000);

mkFile('模板/每日模板.md', [
  '- [ ] 模板占位',
  '- [ ] ',
].join('\n'), Date.now() - 50 * 60000);

mkFile('C/复制甲.md', ['- [ ] 重复出现的同一件事'].join('\n'), Date.now() - 30 * 60000);
mkFile('C/复制乙.md', ['- [ ] 重复出现的同一件事'].join('\n'), Date.now() - 20 * 60000);

// 嵌套同名目录要排除；名字里只是含 raw 字样的正常目录不能误伤
mkFile('实习/raw/sources/导入.md', ['- [ ] 嵌套 raw 目录里的任务'].join('\n'), Date.now() - 45 * 60000);
mkFile('drawing/正常.md', ['- [ ] drawing 目录里的真任务'].join('\n'), Date.now() - 46 * 60000);

function buildCache(content) {
  const lines = content.split('\n');
  const listItems = [];
  const headings = [];
  const tags = [];
  let frontmatter = null;
  let offset = 0;
  const offsets = lines.map((l) => { const o = offset; offset += l.length + 1; return o; });
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      frontmatter = {};
      for (let i = 1; i < end; i++) {
        const m = lines[i].match(/^(\w+):\s*(.*)$/);
        if (m) frontmatter[m[1]] = m[2];
      }
      // 真实 Obsidian 的 CachedMetadata.tags 同时包含 YAML 与正文标签
      const fmTags = frontmatter.tags;
      if (fmTags) {
        String(fmTags).replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
          .forEach((t) => tags.push({ tag: '#' + t.replace(/^#/, ''), position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 1, offset: 1 } } }));
      }
    }
  }
  lines.forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) headings.push({ heading: h[2].trim(), level: h[1].length, position: { start: { line: i, col: 0, offset: offsets[i] }, end: { line: i, col: line.length, offset: offsets[i] + line.length } } });
    const t = line.match(/^(\s*)([-*+])[ \t]\[( |x|X|-)\]/);
    if (t) {
      listItems.push({
        task: t[3], parent: -1,
        position: { start: { line: i, col: 0, offset: offsets[i] }, end: { line: i, col: line.length, offset: offsets[i] + line.length } },
      });
    }
    const tagRe = /#([\p{L}\p{N}_\-/]+)/gu;
    let m;
    while ((m = tagRe.exec(line)) !== null) tags.push({ tag: '#' + m[1], position: { start: { line: i, col: m.index, offset: offsets[i] + m.index }, end: { line: i, col: m.index + m[0].length, offset: offsets[i] + m.index + m[0].length } } });
  });
  return { listItems, headings, tags, frontmatter, sections: [] };
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
    // 夹具照这个来：只给当前一层的文件 + 子目录，逼插件自己下钻（否则测的不是真机那条路）。
    // root 的 '/' 与 '' 都表示库根。
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
  cachedRead: async (f) => contents.get(f.path) || '',
  process: async (f, fn) => { const out = fn(contents.get(f.path)); contents.set(f.path, out); return out; },
  create: async (p, data) => mkFile(stub.normalizePath(p), data, Date.now()),
  createFolder: async () => {},
  on: () => ({}),
};

const app = {
  vault,
  metadataCache: { getFileCache: (f) => buildCache(contents.get(f.path) || ''), on: () => ({}) },
  workspace: {
    on: () => ({}),
    onLayoutReady: (cb) => cb(),
    getLeavesOfType: () => [],
    getLeaf: () => ({ setViewState() {}, openFile: async () => {}, view: {} }),
    revealLeaf: async () => {},
    getActiveViewOfType: () => null,
  },
  plugins: { getPlugin: () => null },
  setting: { open() {}, openTabById() {} },
};

/* ------------------------------------------------ 加载插件 */

console.log('\n[1] 模块加载与导出形态');
const KbWorkbenchPlugin = require(PLUGIN);
ok(typeof KbWorkbenchPlugin === 'function', 'main.js 导出一个构造函数');
eq(KbWorkbenchPlugin.default, KbWorkbenchPlugin, 'module.exports.default 指向同一个类（兼容两种加载器）');
ok(typeof KbWorkbenchPlugin.prototype.onload === 'function', 'prototype.onload 存在');
ok(typeof KbWorkbenchPlugin.prototype.onunload === 'function', 'prototype.onunload 存在');

const plugin = new KbWorkbenchPlugin(app, { id: 'kb-workbench' });
plugin.loadData = async () => null;

(async () => {
  await plugin.loadAll();
  plugin.recentMode = 'edited';
  plugin.statsCache = null;
  plugin.statsJob = null;

  console.log('\n[2] 设置默认值');
  eq(plugin.settings.recentCount, 8, 'recentCount 默认 8');
  eq(plugin.settings.taskLimit, 60, 'taskLimit 默认 60');
  ok(Array.isArray(plugin.settings.quickButtons), 'quickButtons 是数组');
  ok(Array.isArray(plugin.recentOpenedList), 'recentOpenedList 是数组');
  ok(Array.isArray(plugin.pins), 'pins 是数组');
  eq(plugin.settings.scratchPath, '每日笔记/速记.md', '速记本默认路径（第二十轮）');
  eq(plugin.settings.scratchLimit, 12, '速记显示条数默认 12');
  eq(plugin.settings.writingKeep, 120, '写作量快照默认留 120 天');

  console.log('\n[3] 目录树');
  const tree = plugin.folderTree();
  const names = tree.map((n) => n.name);
  const a = tree.find((n) => n.name === 'A');
  ok(!!a, '存在分区 A', names);
  eq(a.count, 2, 'A 分区笔记数 = 2（含子目录）');
  eq(a.children.length, 1, 'A 有一个子分区');
  eq(a.children[0].name, 'B', '子分区为 B');
  const rootNote = tree.find((n) => n.name === '（根目录笔记）');
  ok(!!rootNote && rootNote.count === 1, '根目录笔记单独成组', rootNote && rootNote.count);

  console.log('\n[4] 最近编辑');
  plugin.settings.recentCount = 3;
  const recent = plugin.recentEdited();
  eq(recent.length, 3, '按 recentCount 截断');
  ok(recent[0].file.path === 'A/写报告.md', '最新的排第一', recent.map((r) => r.file.path));
  ok(recent.every((r) => r.file.extension === 'md'), '只包含 markdown');

  console.log('\n[5] 任务扫描');
  const tasks = await plugin.collectTasks();
  eq(tasks.length, 8, '共识别 8 条任务（已滤掉排除目录/模板/重复）');
  const rawHit = tasks.find((t) => t.body.indexOf('导入资料') >= 0);
  ok(!rawHit, '默认排除 raw/ 目录里的任务');
  const nestedRaw = tasks.find((t) => t.body.indexOf('嵌套 raw') >= 0);
  ok(!nestedRaw, '嵌套层级（a/raw/…）里的任务也排除');
  const drawingTask = tasks.find((t) => t.body.indexOf('drawing 目录') >= 0);
  ok(!!drawingTask, '只是名字含 raw 字样的目录不误伤（drawing/）');
  const tplHit = tasks.find((t) => t.body.indexOf('模板占位') >= 0);
  ok(!tplHit, '模板文件里的占位任务不算待办');
  const dupTasks = tasks.filter((t) => t.body.indexOf('重复出现的同一件事') >= 0);
  eq(dupTasks.length, 1, '重复任务只保留一条');
  eq(dupTasks[0] && dupTasks[0].dup, 2, '重复条数记在 ×N 上');
  const skipped = plugin.lastTaskStats || {};
  ok(skipped.template >= 2, '统计：模板文件按"里面有几条任务行"计数（不读正文也算得对）', skipped);
  ok(skipped.empty >= 1, '统计：被过滤的空任务（普通笔记里那条只有标记的）', skipped);
  ok(skipped.dup >= 1, '统计：被去掉的重复任务', skipped);
  const overdue = tasks.find((t) => t.body.indexOf('写季度报告') === 0);
  ok(!!overdue && overdue.isOverdue === true, '📅 昨天 → 逾期', overdue && overdue.markers);
  const todayTask = tasks.find((t) => t.body.indexOf('今天要做的') === 0);
  ok(!!todayTask && todayTask.markers.due === TODAY && !todayTask.isOverdue, '📅 今天 → 不逾期');
  const doneTask = tasks.find((t) => t.body.indexOf('已完成的事') === 0);
  ok(!!doneTask && doneTask.done === true && doneTask.doneToday === true, '已完成且 ✅ 今天 → doneToday');
  const plain = tasks.find((t) => t.body.indexOf('没有日期') === 0);
  ok(!!plain && plain.done === false && !plain.isOverdue, '无日期任务状态正确');
  const sub = tasks.find((t) => t.body.indexOf('子任务') === 0);
  ok(!!sub && sub.indent === 2, '缩进被记录（子任务）', sub && sub.indent);

  console.log('\n[6] 勾选回写（vault.process）');
  const before = contents.get('A/写报告.md');
  await plugin.toggleTask(overdue);
  const afterDone = contents.get('A/写报告.md');
  ok(/^- \[x\] 写季度报告 📅/.test(afterDone.split('\n')[2]), '未完成 → 已完成', afterDone.split('\n')[2]);
  ok(afterDone.indexOf('✅' + TODAY) >= 0, '追加了完成日期 ✅' + TODAY);
  ok(before !== afterDone, '文件内容确实被改写');
  eq(afterDone.split('\n').length, before.split('\n').length, '行数不变（只改一行）');

  const relist = await plugin.collectTasks();
  const flipped = relist.find((t) => t.body.indexOf('写季度报告') === 0);
  ok(!!flipped && flipped.done === true, '重新扫描后状态为已完成');
  await plugin.toggleTask(flipped);
  const backLine = contents.get('A/写报告.md').split('\n')[2];
  ok(/^- \[ \] 写季度报告 📅/.test(backLine), '再勾一次 → 回到未完成', backLine);
  ok(backLine.indexOf('✅') < 0, '完成日期被移除');

  console.log('\n[7] 库统计');
  const stats = await plugin.computeStats();
  ok(stats.md === 9, 'markdown 笔记数 = 9', stats.md);
  ok(stats.nonMd === 1, '非 markdown 文件数 = 1', stats.nonMd);
  ok(stats.tagCount >= 3, '标签数 ≥ 3', stats.topTags);
  ok(typeof stats.words === 'number' && stats.words > 0, '字数统计为正值', stats.words);
  ok(stats.bytes > 0, '总容量为正', stats.bytes);
  ok(stats.folders.some((f) => f.name === 'A'), '分区统计含 A');

  console.log('\n[8] 收藏 / 打开历史');
  plugin.togglePin('A/写报告.md');
  ok(plugin.pinnedPaths()[0] === 'A/写报告.md', '收藏写入 pins');
  plugin.togglePin('A/写报告.md');
  eq(plugin.pinnedPaths().length, 0, '再点一次取消收藏');
  plugin.trackOpen(filesByPath.get('A/B/资料.md'));
  ok(plugin.recentOpened()[0].file.path === 'A/B/资料.md', '打开历史记录最新一篇');
  plugin.trackOpen(filesByPath.get('A/B/资料.md'));
  eq(plugin.recentOpenedList.length, 1, '同一篇不会重复占位');

  console.log('\n[9] 持久化载荷');
  await plugin.persist();
  ok(plugin.__data && Array.isArray(plugin.__data.opened), 'data 里带 opened');
  ok(plugin.__data && Array.isArray(plugin.__data.pins), 'data 里带 pins');
  ok(plugin.__data && typeof plugin.__data.recentCount === 'number', 'data 里带设置项（不会互相覆盖）');

  console.log('\n[10] 新建笔记流程（含模板与非法字符）');
  const created = [];
  plugin.app.vault.create = async (p, data) => { const f = mkFile(stub.normalizePath(p), data, Date.now()); created.push(f.path); return f; };
  plugin.app.vault.getAbstractFileByPath = (p) => filesByPath.get(stub.normalizePath(p)) || null;
  const origGetLeaf = app.workspace.getLeaf;
  app.workspace.getLeaf = () => ({ openFile: async () => {}, view: { setEphemeralState() {} } });
  await plugin.createNoteFlow({ folder: '新文件夹', forcedName: '标题:带*非法/字符' });
  ok(created.length === 1, '创建了一个文件', created);
  ok(/^新文件夹\/标题 带 非法 字符\.md$/.test(created[0]), '非法字符被替换、目录已建', created[0]);
  await plugin.createNoteFlow({ folder: '新文件夹', forcedName: '标题 带 非法 字符' });
  ok(created.length === 1, '同名不重复创建（直接打开已有）', created);
  app.workspace.getLeaf = origGetLeaf;

  console.log('\n[11] 自由网格布局');
  const def = plugin.layoutList();
  eq(def.length, 14, '默认 14 个模块（原 8 张 + 第二十轮 5 张 + 第三十二轮「待办」）');
  eq(def[0].id, 'search', '默认首位是搜索');
  const tk = def.find((s) => s.id === 'tasks');
  eq(tk.w, 32, '任务默认宽 32/48（= 旧的 8/12）');
  eq(tk.h, 30, '任务默认高 30 行单元');
  ok(def.every((s) => s.col >= 1 && s.row >= 1), '默认布局每张卡都有坐标（自动装箱）');

  const noOverlap = (list) => {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const p = list[a], q = list[b];
        if (p.col < q.col + q.w && q.col < p.col + p.w && p.row < q.row + q.h && q.row < p.row + p.h) return [p.id, q.id];
      }
    }
    return null;
  };
  eq(noOverlap(def), null, '默认布局互不重叠');

  await plugin.setBox('pinned', { col: 3, row: 7, w: 12, h: 30 });
  const p2 = plugin.slotOf('pinned');
  eq(p2.col + ',' + p2.row + ',' + p2.w + ',' + p2.h, '3,7,12,30', 'setBox 写入坐标与尺寸');

  await plugin.setBox('quick', { w: 99 });
  ok(plugin.slotOf('quick').w <= 48, '宽度被夹到 48 栏内', plugin.slotOf('quick').w);
  await plugin.setBox('quick', { h: 1 });
  ok(plugin.slotOf('quick').h >= 12, '高度有下限，不会被缩成 0', plugin.slotOf('quick').h);

  await plugin.setBox('stats', { col: 1, row: 1 });
  await plugin.setBox('search', { col: 1, row: 1 });
  ok(noOverlap(plugin.layoutList()) !== null, '手动摆到同一格会重叠（自由放置允许）');
  await plugin.tidyLayout();
  eq(noOverlap(plugin.layoutList()), null, '自动排列消除重叠');

  // 缩放（commitResize）：放大那张保持尺寸，被压住的跟着让位 —— 用户报的"缩放时别人不让位"
  await plugin.resetLayout();
  await plugin.setBox('hygiene', { col: 1, row: 1, w: 16, h: 20 });
  await plugin.setBox('writing', { col: 17, row: 1, w: 12, h: 20 });
  const wr0 = plugin.slotOf('writing');
  await plugin.commitResize('hygiene', { w: 24, h: 20 });
  const hy3 = plugin.slotOf('hygiene');
  eq(hy3.col + ',' + hy3.row + ',' + hy3.w + ',' + hy3.h, '1,1,24,20', 'commitResize 写入新尺寸，锚点不动');
  const wr3 = plugin.slotOf('writing');
  ok(wr3.col > wr0.col, '被压住的「写作量」向右让位了', [wr0, wr3]);
  eq(noOverlap(plugin.layoutList()), null, '放大后整版没有任何两卡重叠（以前 setBox 只管自己，会压在别人身上）');
  await plugin.commitResize('hygiene', { w: 8, h: 20 });
  ok(plugin.slotOf('hygiene').w === 8, '缩小同样只改自己（不需要别人让位）', plugin.slotOf('hygiene'));
  eq(noOverlap(plugin.layoutList()), null, '缩小后也不留重叠');

  await plugin.setModuleOn('hygiene', false);
  eq(plugin.hiddenModules().length, 1, '隐藏模块可枚举');
  await plugin.setCollapsed('stats', true);
  eq(plugin.slotOf('stats').collapsed, true, '折叠状态持久化');
  await plugin.resetLayout();
  eq(plugin.layoutList()[0].id, 'search', '重置布局回到默认');
  eq(plugin.hiddenModules().length, 0, '重置后没有隐藏模块');
  ok(plugin.__data && Array.isArray(plugin.__data.layout), '布局写进了 data.json');

  // 旧版只有 span 的配置要能自动迁移成坐标
  plugin.settings.layout = [{ id: 'search', span: 12, on: true }, { id: 'tasks', span: 8 }];
  const migrated = plugin.layoutList();
  eq(migrated.length, 14, '旧配置 + 缺失模块自动补全');
  ok(migrated.every((s) => s.col >= 1 && s.row >= 1 && s.w >= 2 && s.h >= 12), '旧配置自动装箱出合法坐标', migrated[1]);
  eq(noOverlap(migrated), null, '迁移后的布局不重叠');

  console.log('\n[12] 字体设置');
  eq(plugin.settings.numFont, 'Consolas', '数字字体默认 Consolas（本机实测命中）');
  let applied = {};
  const fakeHost = { style: { setProperty: (k, v) => { applied[k] = v; }, removeProperty: (k) => { delete applied[k]; } } };
  plugin.settings.uiFont = 'MiSans';
  plugin.applyFonts(fakeHost);
  ok(/MiSans/.test(applied['--kbwb-ui'] || ''), '界面字体写入 --kbwb-ui', applied);
  ok(/Consolas/.test(applied['--kbwb-num'] || ''), '数字字体写入 --kbwb-num', applied);
  applied = {};
  plugin.settings.uiFont = '';
  plugin.settings.numFont = '';
  plugin.applyFonts(fakeHost);
  ok(!applied['--kbwb-ui'], '选"跟随 Obsidian"时移除变量而不是塞空串');

  console.log('\n[13] 新增模块补位：不许把用户摆好的布局推倒重排');
  await plugin.resetLayout();
  const packed = plugin.layoutList();
  const oldIds = ['search', 'quick', 'pinned', 'recent', 'tasks', 'nav', 'stats', 'hygiene'];
  const savedOnly8 = packed.filter((s) => oldIds.indexOf(s.id) >= 0)
    .map((s) => ({ id: s.id, col: s.col, row: s.row, w: s.w, h: s.h }));
  plugin.settings.layout = savedOnly8;              // 假装这是老库：只有 8 张卡的坐标
  const grown = plugin.layoutList();
  eq(grown.length, 14, '老库补上新卡后共 14 张');
  for (const old of savedOnly8) {
    const nowBox = grown.find((s) => s.id === old.id);
    eq([nowBox.col, nowBox.row, nowBox.w, nowBox.h].join(','), [old.col, old.row, old.w, old.h].join(','),
      '已有卡 ' + old.id + ' 的位置尺寸没被 autoPack 推倒');
  }
  eq(noOverlap(grown), null, '补上来的新卡与旧卡不重叠');
  ok(grown.every((s) => s.col >= 1 && s.row >= 1), '14 张卡都有合法坐标');
  await plugin.resetLayout();

  console.log('\n[14] 日记命名只有一套（月历卡与今日笔记共用）');
  eq(plugin.dailyNameFor(new Date(2026, 10, 4)), '2026-11-04', 'dailyNameFor 走 YYYY-MM-DD');
  eq(plugin.dailyFormatPath(new Date(2026, 10, 4)), '2026-11-04.md', '没有日记文件夹时落库根');
  plugin.coreConfig = { dailyFolder: '每日笔记', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' };
  eq(plugin.dailyFormatPath(new Date(2026, 10, 4)), '每日笔记/2026-11-04.md', '有日记文件夹时拼进去');
  plugin.coreConfig = { dailyFolder: '', dailyFormat: 'YYYY/MM/DD', dailyTemplate: '' };
  ok(plugin.dailyFormatPath(new Date(2026, 10, 4)).indexOf('2026-11-04.md') >= 0,
    '格式含 / 这类非法字符时退回 ymd，不会创建歪名字', plugin.dailyFormatPath(new Date(2026, 10, 4)));
  plugin.coreConfig = null;

  console.log('\n[15] 速记本：只追加，不整篇重写');
  plugin.settings.scratchPath = '每日笔记/速记.md';
  eq((await plugin.readScratchLines()).length, 0, '文件不存在时读速记返回空数组（不报错）');
  const wrote = await plugin.appendScratch('  记一句   带多余   空格  ');
  eq(plugin.scratchPath(), '每日笔记/速记.md', 'scratchPath 归一化');
  ok(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} 记一句 带多余 空格$/.test(wrote), '空白被压成一个空格', wrote);
  const scratchTxt = contents.get('每日笔记/速记.md');
  ok(/^# 速记\n\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} 记一句 带多余 空格\n$/.test(scratchTxt), '新建时带标题 + 一行', JSON.stringify(scratchTxt));
  await plugin.appendScratch('第二句');
  eq(contents.get('每日笔记/速记.md').split('\n').filter((l) => l.indexOf('- ') === 0).length, 2, '第二次追加不动第一行');
  eq(await plugin.appendScratch('   '), null, '空内容不写盘');
  const lines2 = await plugin.readScratchLines();
  eq(lines2.length, 2, 'readScratchLines 读到两条');
  eq(lines2[0].text, '第二句', '新的在前');
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(lines2[0].stamp), '时间戳解析出来', lines2[0].stamp);

  console.log('\n[16] 写作量快照：只在变了时写盘、按天数裁剪');
  plugin.writingLog = {};
  plugin.statsCache = null; plugin.statsJob = null;
  const w1 = await plugin.snapshotWriting();
  const todayKey = new Date().getFullYear() + '-' + pad(new Date().getMonth() + 1) + '-' + pad(new Date().getDate());
  ok(Number.isFinite(w1) && plugin.writingLog[todayKey] === w1, '今天记了一笔', plugin.writingLog);
  const far = [];
  for (let i = 1; i <= 10; i++) {
    const d = new Date(Date.now() - i * 86400000);
    far.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
  }
  far.forEach((k, i) => { plugin.writingLog[k] = 100 + i; });
  plugin.settings.writingKeep = 7;
  await plugin.snapshotWriting();
  const kept = Object.keys(plugin.writingLog).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  eq(kept.length, 7, '超过 writingKeep 的旧快照被裁掉');
  ok(kept.indexOf(far[9]) < 0, '最旧的那天已不在', kept);
  ok(kept.indexOf(todayKey) >= 0, '今天这笔留着', kept);
  ok(plugin.__data && plugin.__data.writingLog && Number.isFinite(plugin.__data.writingLog[todayKey]),
    'persist 的 payload 带 writingLog', plugin.__data && Object.keys(plugin.__data.writingLog || {}));
  plugin.settings.writingKeep = 120;

  console.log('\n[17] loadAll 只认合法日期键（脏快照当没有，不炸）');
  plugin.loadData = async () => Object.assign({}, plugin.__data, {
    writingLog: { '2026-11-01': 123, '不是日期': 5, '2026-11-02': 'abc', '2026-11-03': -2 },
  });
  await plugin.loadAll();
  eq(Object.keys(plugin.writingLog).sort().join(','), '2026-11-01', '只保留合法键与非负数值');
  plugin.loadData = async () => null;
  await plugin.loadAll();
  eq(Object.keys(plugin.writingLog || {}).length, 0, '老 data.json 没这个字段 = 空快照');

  console.log('\n[18] 全盘扫描：磁盘 vs 缓存对账（只在按钮里跑，只读）');
  // 只读断言盯"已索引文件的内容 + 索引本身"：adapter 桩会把磁盘视图里的额外文件塞进
  // contents 好让 read 有东西返回，那是桩的行为，不是插件写了文件。
  const snapVals = () => JSON.stringify(Array.from(contents.entries()).filter(([k]) => filesByPath.has(k)));
  const before18 = snapVals();
  diskExtra.push({ path: '隐藏目录/没被索引的笔记.md', text: '# 隐藏\n\n#私密 标签在正文里\n\n[[A/写报告]]\n' });
  const origCacheFor = app.metadataCache.getFileCache;
  app.metadataCache.getFileCache = (f) => (f.path === 'A/B/资料.md' ? { listItems: [], headings: [], tags: [], sections: [] } : origCacheFor(f));
  const scan18 = await plugin.fullScan();
  app.metadataCache.getFileCache = origCacheFor;
  ok(scan18.disk >= 9, '磁盘篇数含那篇没被索引的', scan18.disk);
  ok(scan18.notIndexed.length === 1 && scan18.notIndexed[0].path === '隐藏目录/没被索引的笔记.md',
    '报出「磁盘上有、Obsidian 没索引」', scan18.notIndexed.map((x) => x.path));
  ok(scan18.tagMissed.some((x) => x.path === 'A/B/资料.md'), '缓存说没标签、正文里其实有 → tagMissed', scan18.tagMissed.map((x) => x.path));
  ok(scan18.orphanDiff.some((x) => x.path === 'A/写报告.md'), '隐藏篇链到了它、缓存认为没人链 → orphanDiff', scan18.orphanDiff.map((x) => x.path));
  eq(scan18.indexed, scan18.scanned - scan18.notIndexed.length, 'indexed 计数自洽');
  eq(snapVals(), before18, '全盘扫描没改写任何已索引文件（只读）');
  eq(filesByPath.has('隐藏目录/没被索引的笔记.md'), false, '也没顺手把磁盘上那篇"建"进索引');
  ok(plugin.lastScan === scan18, '结果留在 plugin.lastScan（重绘不丢）');
  plugin.clearScan();
  eq(plugin.lastScan, null, 'clearScan 清掉结果');

  plugin.settings.scanCap = 2;
  const cap18 = await plugin.fullScan();
  ok(cap18.capped && cap18.scanned <= 2, '超过 scanCap 就截断并说明', { capped: cap18.capped, scanned: cap18.scanned });
  plugin.settings.scanCap = 3000;
  const stop18 = await plugin.fullScan(null, () => true);
  ok(stop18.stopped && stop18.scanned === 0, 'shouldStop 立刻生效（「停止」按钮走这条路）', stop18.scanned);
  let prog18 = -1;
  await plugin.fullScan((n) => { prog18 = n; });
  ok(prog18 === -1 || prog18 >= 25, '每 25 篇回调一次进度（小库不到 25 就不报，正常）', prog18);
  const origList = vault.adapter.list;
  delete vault.adapter.list;
  const noList = await plugin.fullScan();
  ok(/adapter\.list/.test(noList.error), '没有 adapter.list 的老版本给明确错误而不是崩', noList.error);
  vault.adapter.list = origList;
  diskExtra.length = 0;
  plugin.lastScan = null;

  console.log('\n[19] 当日任务模板：占位符与标记填充（纯函数）');
  const F = KbWorkbenchPlugin.fillTaskMarkers;
  const T = (text, due, done, doneMark, base) => ({
    text, done: !!done, markers: { due: due || '', done: doneMark || '' },
    doneToday: !!done && doneMark === TODAY,
    file: { path: (base || 'A') + '/笔记.md', basename: (base || 'A') + '/笔记' },
  });
  const tasks19 = [T('今天要做的', TODAY), T('写季度报告', YESTERDAY), T('没写日期的任务'), T('已完成的事', '', 'x', TODAY), T('别的文件里的', TODAY, false, '', 'B')];
  const filled = F('到期:\n<!--KBWB:TASKS:due-->\n逾期:\n<!--KBWB:TASKS:overdue-->\n勾掉:\n<!--KBWB:TASKS:done-->\n没日期:\n<!--KBWB:TASKS:undated-->\n', tasks19, TODAY, 30);
  ok(filled.indexOf('到期:\n- [ ] 今天要做的 —— [[A/笔记]]') >= 0, 'due 组填进来了，带出处链接', filled.split('\n')[1]);
  ok(filled.indexOf('逾期:\n- [ ] 写季度报告') >= 0, 'overdue 组 = 📅 早于今天的');
  ok(filled.indexOf('勾掉:\n- [x] 已完成的事') >= 0, 'done 组用 - [x]');
  ok(filled.indexOf('没日期:\n- [ ] 没写日期的任务') >= 0, 'undated 组 = 没写 📅 的未完成');
  ok(filled.indexOf('[[B/笔记]]') > 0, '出处链接用的是源笔记名');
  eq(F('X:<!--KBWB:TASKS:all-->', [], TODAY, 30), 'X:- （没有）', '空组给一行「（没有）」而不是留空标题');
  eq(F('没有标记的模板', tasks19, TODAY, 30), '没有标记的模板', '模板里没标记就原样返回');
  const capped = F('<!--KBWB:TASKS:undated-->', [T('一'), T('二'), T('三')], TODAY, 2);
  ok(capped.indexOf('另有 1 条没列进来') > 0, '超过上限就写明还剩几条没列进来', capped);

  const S = KbWorkbenchPlugin.substituteTemplateTokens;
  eq(S('{{date:YYYY-MM-DD}}', { date: new Date(TODAY + 'T10:00:00+08:00') }), TODAY, '{{date:YYYY-MM-DD}} 被换掉');
  eq(S('{{date}} 与 {{title}}', { date: new Date(TODAY + 'T10:00:00+08:00'), title: '当日任务' }), TODAY + ' 与 当日任务', '{{date}} / {{title}} 被换掉');
  ok(/^周[一二三四五六日]$/.test(S('{{weekday}}', { date: new Date(TODAY + 'T10:00:00+08:00') })), '{{weekday}} 出中文星期');
  ok(/^\d{2}:\d{2}$/.test(S('{{time}}', { date: new Date(TODAY + 'T10:00:00+08:00') })), '{{time}} 出 HH:mm');
  ok(S('{{date}}', {}).indexOf('{{') < 0, '没给日期也不会留字面占位符');

  console.log('\n[20] 模板路径解析（daily-notes.json 里的 template 不带 .md）');
  ok(!!plugin.resolveVaultFile('模板/每日模板'), '「模板/每日模板」（无扩展名）找得到 —— 核心「日记」就是这么存的');
  eq(plugin.resolveVaultFile('模板/每日模板').path, '模板/每日模板.md', '解析到真实路径');
  ok(!!plugin.resolveVaultFile('每日模板'), '只给 basename 也能找到');
  eq(plugin.resolveVaultFile('不存在的东西'), null, '找不到就返回 null，不乱建');
  eq(plugin.resolveVaultFile(''), null, '空路径返回 null');

  console.log('\n[21] buildDailyContent：模板 + 当天任务一起落地');
  mkFile('模板/当日任务测试.md', ['# {{date:YYYY-MM-DD}} {{weekday}}', '', '## 今天到期', '', '<!--KBWB:TASKS:due-->', '', '## 已逾期', '', '<!--KBWB:TASKS:overdue-->', ''].join('\n'), Date.now());
  plugin.settings.dailyCreateTemplate = '模板/当日任务测试';      // 故意不带 .md，走 resolveVaultFile 那条路
  plugin.statsCache = null; plugin.hygieneCache = null;
  const built21 = await plugin.buildDailyContent(new Date(TODAY + 'T10:00:00+08:00'), TODAY);
  eq(built21.template, '模板/当日任务测试.md', '用的就是设置里那个模板');
  ok(built21.hadMarkers, '模板里确实有 KBWB 标记');
  ok(built21.text.indexOf('{{') < 0, '成品里没有字面占位符', built21.text.slice(0, 40));
  ok(built21.text.indexOf('- [ ] 今天要做的') >= 0, '今天的任务被填进 due 段', built21.text.slice(0, 120));
  ok(built21.text.indexOf('- [ ] 写季度报告') >= 0, '逾期的任务被填进 overdue 段');

  console.log('\n[22] 生成的当日任务页不会再进任务清单（副本不算任务）');
  const before22 = (await plugin.collectTasks()).length;
  mkFile('每日笔记/' + TODAY + '.md', KbWorkbenchPlugin.KBWB_TASKS_MARK + 'due-->\n- [ ] 今天要做的 📅' + TODAY + ' —— [[A/笔记]]\n', Date.now());
  const after22 = await plugin.collectTasks();
  eq(after22.length, before22, '带 KBWB 标记的那篇里的任务行不算进清单（否则同文去重会顶掉源笔记那条）');
  ok(plugin.lastTaskStats.template >= 1, '它被记成"模板/副本"类跳过', plugin.lastTaskStats);
  plugin.settings.dailyCreateTemplate = '模板/每日任务模板.md';

  console.log('\n[23] 模板目录 / 列表 / 新增模板 / 一天多篇（第二十五轮）');
  plugin.settings.templateDir = '';
  eq(plugin.templateDir(), '模板', '没设模板夹时退到「模板」');
  plugin.settings.templateDir = '额外附加学习文档';
  eq(plugin.templateDir(), '额外附加学习文档', '设置里指定的目录优先');
  plugin.settings.templateDir = '';
  const pick23 = plugin.listTemplatesForPicker().map((f2) => f2.path);
  ok(pick23.indexOf('模板/每日模板.md') >= 0, '列表 = 模板目录下的所有 .md', pick23);
  const t23 = await plugin.createTemplate('会议记录', '');
  ok(!!t23 && t23.path === '模板/会议记录.md', '新增模板落在同一个目录', t23 && t23.path);
  ok(String(contents.get('模板/会议记录.md')).indexOf('{{title}}') >= 0, '骨架里留着 {{title}}（建笔记时才换，不在模板名上就替换）');
  const t23dup = await plugin.createTemplate('会议记录', '');
  ok(!!t23dup && t23dup.path === '模板/会议记录.md', '同名不覆盖，返回已有的那一个');
  eq(await plugin.createTemplate('   ', ''), null, '空模板名不建文件');

  plugin.dailyNotes = {};
  plugin.rememberDailyNote('2026-11-09', '每日笔记/A.md');
  plugin.rememberDailyNote('2026-11-09', '每日笔记/B.md');
  eq(plugin.dailyNotes['2026-11-09'].join(','), '每日笔记/A.md,每日笔记/B.md', '同一天可以记多篇');
  plugin.rememberDailyNote('2026-11-09', '每日笔记/A.md');
  eq(plugin.dailyNotes['2026-11-09'].length, 2, '重复记同一个路径不会写两遍');
  plugin.loadData = async () => Object.assign({}, plugin.__data, {
    dailyNotes: { '2026-11-11': '老格式字符串.md', '2026-11-12': ['数组一.md', '数组二.md'], '坏键': ['x.md'] },
  });
  await plugin.loadAll();
  eq(plugin.dailyNotes['2026-11-11'].join(','), '老格式字符串.md', '老的"一天一篇"字符串自动转成数组');
  eq(plugin.dailyNotes['2026-11-12'].length, 2, '本来就是数组的原样保留');
  eq(plugin.dailyNotes['坏键'], undefined, '非日期键丢掉');
  plugin.loadData = async () => null;
  await plugin.loadAll();

  mkFile('每日笔记/2026-11-13.md', '# 十三\n', Date.now());
  mkFile('每日笔记/别的名字.md', '# 别的\n', Date.now() - 1000);
  plugin.dailyNotes = { '2026-11-13': ['每日笔记/别的名字.md'], '2026-11-99': ['每日笔记/不存在.md'] };
  plugin.coreConfig = { dailyFolder: '每日笔记', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' };
  const notes23 = plugin.dailyNotesFor(new Date(2026, 10, 13));
  eq(notes23.length, 2, '列表 = 记住的那篇 + 按日期名推出来的那篇', notes23.map((x) => x.path));
  eq(notes23[0].path, '每日笔记/2026-11-13.md', '按修改时间新的在前');
  eq(plugin.dailyFormatPath(new Date(2026, 10, 13)), '每日笔记/2026-11-13.md', 'dailyFormatPath 就是按格式推的那篇（不读映射）');
  eq(plugin.dailyNotesFor(new Date(2026, 10, 20)).length, 0, '没建过的日子给空列表（月历据此决定弹列表还是弹确认框）');
  plugin.coreConfig = null;

  console.log('\n[24] 月历默认选中的那份必须是真文件；内置只是兜底，且不许与库里那份漂移（用户②③）');
  const shape = KbWorkbenchPlugin.dailyTasksTemplateShape;
  const shIn = shape(KbWorkbenchPlugin.KBWB_DEFAULT_DAILY_TASKS);
  eq(shIn.marks.join(','), 'due,overdue,done,undated', '内置兜底那份自己就有四段 KBWB:TASKS 标记');
  ok(shIn.generated, '内置兜底那份也带常驻指纹（生成物识别不能靠会被填掉的标记）');
  ok(shIn.heads.length >= 6, '内置那份的小节数', shIn.heads);

  // 真实库里那一份是"权威"：把它塞进假库，结构必须和内置那份对得上（漂移了这条就红）
  const realTpl = path.join(VAULT, '模板', '每日任务模板.md');
  if (fs.existsSync(realTpl)) {
    const realText = fs.readFileSync(realTpl, 'utf8');
    const shReal = shape(realText);
    eq(shReal.marks.join(','), shIn.marks.join(','), '库里那份与内置那份：四段标记一一对应');
    eq(shReal.heads.join('｜'), shIn.heads.join('｜'), '库里那份与内置那份：小节顺序一致');
    mkFile('模板/每日任务模板.md', realText, Date.now());
    // ②的落点：设置里那份必须真的在「选模板」列表里，否则月历的默认选中根本亮不起来
    const listed = plugin.listTemplatesForPicker().map((f2) => f2.path);
    ok(listed.indexOf('模板/每日任务模板.md') >= 0, '默认选中的那份是列表里的真文件（不是合成条目）', listed);
    plugin.settings.dailyCreateTemplate = '模板/每日任务模板.md';
    const d24 = new Date(TODAY + 'T10:00:00+08:00');
    const viaChoice = await plugin.buildDailyContent(d24, TODAY, '模板/每日任务模板.md');
    eq(viaChoice.template, '模板/每日任务模板.md', '②选了哪份就用哪份');
    ok(viaChoice.hadMarkers, '③库里那份的标记被认出来了（会被填上当天任务）');
    const viaDefault = await plugin.buildDailyContent(d24, TODAY, '');
    eq(viaDefault.template, '模板/每日任务模板.md', '③没点模板时也落在库里那份，不是内置');
    ok(viaDefault.text.indexOf(shReal.heads[0]) >= 0, '③成品里能看到库里那份的小节标题');
    // 内置那份与库里那份的措辞本来就允许不同，但正文必须分得开：确认内置不是被默认用掉的那条路
    ok(viaDefault.text !== KbWorkbenchPlugin.KBWB_DEFAULT_DAILY_TASKS
      || shReal.heads.join(',') === shIn.heads.join(','), '③默认那份来自文件（读出来的原文与内置常量不是同一条路）');

    // ③兜底不静默：库里那份没了 ⇒ 用内置，并且 Notice 说清楚
    filesByPath.delete('模板/每日任务模板.md');
    contents.delete('模板/每日任务模板.md');
    plugin.settings.dailyCreateTemplate = '模板/每日任务模板.md';   // 指到一个不存在的文件
    stub.Notice.last = null;
    const viaFallback = await plugin.buildDailyContent(d24, TODAY, '');
    eq(viaFallback.template, '（内置默认模板）', '③一份模板都没用到才落到内置');
    ok(/没用到模板/.test(String(stub.Notice.last)), '③用到兜底会明说，不再静默', stub.Notice.last);
    ok(viaFallback.text.indexOf(KbWorkbenchPlugin.KBWB_GENERATED_MARK) >= 0, '③兜底成品也带常驻指纹');
    plugin.settings.dailyCreateTemplate = '模板/每日任务模板.md';
  } else {
    console.log('  SKIP 真实库里找不到 模板/每日任务模板.md（结构核对需要它，跳过不计通过数）');
  }

  console.log('\n[25] normalizePath 的空串陷阱（本轮两个真 bug 的根；桩已与本体对齐）');
  const ND = KbWorkbenchPlugin.normDir;
  eq(ND(''), '', 'normDir("") = 未指定');
  eq(ND('/'), '', 'normDir("/") = 未指定（normalizePath 会把它变成 "/"，所以不能拿它判空）');
  eq(ND('  /  '), '', '只有一层斜杠也算未指定');
  eq(ND('/模板/'), '模板', '前后斜杠剥掉');
  eq(ND('模板/子'), '模板/子', '内部斜杠保留');
  // 桩必须和本体一致，否则"测试全绿、真机坏"会一直重演（obsidian.asar 里那句 `&&(e="/")`）
  eq(stub.normalizePath(''), '/', '桩忠实：normalizePath("") 返回 "/"，不是 ""');
  eq(stub.normalizePath('/'), '/', '桩忠实：normalizePath("/") 还是 "/"');

  plugin.coreConfig = { templaterFolder: '', templatesFolder: '模板', dailyFolder: '', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' };
  plugin.settings.templateDir = '';
  eq(plugin.templateDir(), '模板', '留空 = 自动取模板夹（真机上这条曾被 normalizePath("")===  "/" 永久跳过）');
  plugin.settings.templateDir = '/';
  eq(plugin.templateDir(), '模板', '设置里写一个孤零零的 "/" 也回到自动推断，不会变成"去叫 / 的目录"');
  plugin.settings.templateDir = '';
  const list25 = plugin.listTemplatesForPicker().map((f2) => f2.path);
  ok(list25.length >= 1, '模板列表非空（曾经恒空：dir="/" ⇒ 前缀 "//" 谁都匹配不上）', list25);
  ok(list25.every((p) => p.indexOf('模板/') === 0), '列出的都在模板目录下', list25);
  const t25 = await plugin.createTemplate('落点检查', '');
  ok(!!t25 && t25.path === '模板/落点检查.md', '新增模板落在模板目录，不是库根', t25 && t25.path);

  plugin.settings.scanRoot = '';
  const s25a = await plugin.fullScan();
  ok(s25a.disk >= 1, 'scanRoot 留空 = 整库，列得出磁盘篇数（曾经留空 = 去一个叫 / 的目录 ⇒ 0 篇）', { disk: s25a.disk, error: s25a.error });
  plugin.settings.scanRoot = '/';
  const s25b = await plugin.fullScan();
  eq(s25b.disk, s25a.disk, 'scanRoot 写成 "/" 与留空等价（都是整库）');
  eq(s25b.root, '（整库）', '结果里报"（整库）"，不是一堆斜杠');
  plugin.settings.scanRoot = '';
  plugin.lastScan = null;
  plugin.coreConfig = null;

  console.log('\n[26] 消解重叠只动被压到的那几张（用户："只需要被影响到的移走，其他的不要动"）');
  await plugin.resetLayout();
  const ids26 = plugin.layoutList().map((s) => s.id);
  // 无关的卡全部摆到远处（每张占一行，互不重叠），只留三张在同一水平带：
  //   hygiene = 锚（要放大）· writing = 被它压住 · pinned = 无关，但正好站在 writing「向右让」的必经位置
  // 旧写法优先向右让 ⇒ 会把 writing 塞到 pinned 身上，pinned 再被迫动（级联）。
  // 新写法挑落点时把"还没让位的卡"也算进去，于是 writing 改往下方让，pinned 原地不动。
  let row26 = 200;
  for (const id of ids26) { await plugin.setBox(id, { col: 1, row: row26, w: 8, h: 12 }); row26 += 20; }
  await plugin.setBox('hygiene', { col: 1, row: 1, w: 16, h: 20 });
  await plugin.setBox('writing', { col: 17, row: 1, w: 12, h: 20 });
  await plugin.setBox('pinned', { col: 25, row: 1, w: 12, h: 20 });
  const key26 = (s) => s.col + ',' + s.row + ',' + s.w + ',' + s.h;
  const snap26 = new Map(plugin.layoutList().map((s) => [s.id, key26(s)]));

  await plugin.commitResize('hygiene', { w: 24, h: 20 });   // 放大到 1..24，压住 writing(17..28)
  eq(key26(plugin.slotOf('hygiene')), '1,1,24,20', '锚点保持用户拉到的尺寸');
  const wr26 = plugin.slotOf('writing');
  ok(key26(wr26) !== snap26.get('writing'), '被压住的 writing 让位了', wr26);
  eq(key26(plugin.slotOf('pinned')), snap26.get('pinned'), '无关的 pinned 一步没动（没被级联卷进来）');
  const moved26 = plugin.layoutList()
    .filter((s) => s.id !== 'hygiene' && s.id !== 'writing' && key26(s) !== snap26.get(s.id))
    .map((s) => s.id);
  eq(moved26.join(','), '', '除锚点和被压住那张，没有任何一张卡被挪动', moved26);
  eq(noOverlap(plugin.layoutList()), null, '而且整版无重叠');

  const FF = KbWorkbenchPlugin.firstFreeRow;
  eq(FF([{ col: 1, row: 1, w: 8, h: 10 }], 1, 8, 10, 1), 11, 'firstFreeRow：往下找第一个空行');
  eq(FF([], 1, 8, 10, 5), 5, 'firstFreeRow：没东西挡着就停在原行');
  eq(FF([{ col: 1, row: 1, w: 48, h: 600 }], 1, 8, 10, 1), 0, 'firstFreeRow：600 行内放不下返回 0（这时才允许退回整版重排）');

  console.log('\n[27] 全盘扫描自己下钻：库根只回一层时也要列全（真机截图："磁盘 1 篇"）');
  plugin.settings.scanRoot = '';
  const s27 = await plugin.fullScan();
  const idx27 = (vault.getMarkdownFiles() || []).length;
  const lvl0 = await vault.adapter.list('', false);
  const lvlMd = ((lvl0 && lvl0.files) || []).filter((p) => /\.md$/i.test(p)).length;
  ok(s27.disk > lvlMd, '磁盘篇数远超"库根一层"（旧写法只信 list(root,true)，真机上就停在库根那 1 篇）',
    { disk: s27.disk, rootLevel: lvlMd, indexed: idx27 });
  ok(s27.disk >= idx27, '磁盘篇数不少于索引篇数（正常情况磁盘 ⊇ 索引：隐藏/排除的文件只在磁盘上）', { disk: s27.disk, indexed: s27.indexed });
  ok(s27.dirs > 1, '走过的目录不止一层（说明是自己逐层下的钻，不是指望 recursive 标志）', s27.dirs);
  eq(s27.lessThanIndex, 0, '没有"磁盘比索引少"的告警');
  plugin.lastScan = null;

  console.log('\n[28] 纯日记模板：不钉生成物指纹，日记里写的任务照常进任务卡');
  // 生成物指纹（KBWB:GENERATED）存在的理由只有一个：模板里的 KBWB:TASKS 标记被填成了**副本**，
  // 副本不能当新任务再算一遍。模板里一个标记都没有时一条副本都没产生，钉上去反而把整篇当副本跳过——
  // 用户在日记里自己写的 - [ ] 就永远看不见（探针实测）。所以指纹要按 hadMarkers 收口。
  plugin.coreConfig = { templaterFolder: '', templatesFolder: '模板', dailyFolder: '每日笔记', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' };
  mkFile('模板/纯日记探针.md', [
    '# {{date:YYYY-MM-DD}} {{weekday}} · 日记', '',
    '## 今天', '', '- ', '',
  ].join('\n'), Date.now());
  const d28 = new Date(TODAY + 'T10:00:00+08:00');
  const b28 = await plugin.buildDailyContent(d28, '日记探针', '模板/纯日记探针.md');
  eq(b28.template, '模板/纯日记探针.md', '用的是点的那份模板');
  eq(b28.hadMarkers, false, '这份模板里没有 KBWB 标记');
  ok(b28.text.indexOf(KbWorkbenchPlugin.KBWB_GENERATED_MARK) < 0, '不带标记 ⇒ 不钉 KBWB:GENERATED（否则整篇被当副本）');
  ok(b28.text.indexOf('{{') < 0, '占位符照样全部替换', b28.text.slice(0, 60));

  const b28b = await plugin.buildDailyContent(d28, '任务探针', '模板/当日任务测试.md');
  eq(b28b.hadMarkers, true, '带标记的模板仍然认得出标记');
  ok(b28b.text.indexOf(KbWorkbenchPlugin.KBWB_GENERATED_MARK) >= 0, '带标记 ⇒ 仍然钉指纹（"副本不算任务"这条不能丢）');

  // 把纯日记成品放进库，并在里面写一条勾：任务卡必须看得见
  const diaryPath = '每日笔记/' + TODAY + ' 日记探针.md';
  mkFile(diaryPath, b28.text + '\n- [ ] 日记里写的任务 📅' + TODAY + '\n', Date.now());
  const t28 = await plugin.collectTasks();
  ok(t28.some((t) => t.file && t.file.path === diaryPath), '日记里写的勾进了任务卡', t28.map((t) => t.file && t.file.path).slice(0, 6));
  // 而带副本的那篇仍旧不算任务
  const copyPath = '每日笔记/' + TODAY + ' 任务探针.md';
  mkFile(copyPath, b28b.text, Date.now());
  const t28b = await plugin.collectTasks();
  ok(!t28b.some((t) => t.file && t.file.path === copyPath), '带指纹的副本那篇依旧不算任务（没把上一轮的修复弄坏）');
  const rows28 = (t28b.filter((t) => t.file && t.file.path === copyPath)).length;
  eq(rows28, 0, '副本篇贡献 0 条任务');
  plugin.coreConfig = null;

  console.log('\n[29] 同一天再建一篇：默认标题要让开（用户："点了创建新笔记，还是指向原有的笔记"）');
  plugin.coreConfig = { templaterFolder: '', templatesFolder: '模板', dailyFolder: '每日笔记', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' };
  mkFile('每日笔记/2026-12-01.md', '# 一号\n', Date.now());
  eq(plugin.uniqueNameIn('每日笔记', '2026-12-01'), '2026-12-01 2', '撞名就让到「X 2」');
  mkFile('每日笔记/2026-12-01 2.md', '# 二号\n', Date.now());
  eq(plugin.uniqueNameIn('每日笔记', '2026-12-01'), '2026-12-01 3', '还撞就继续往后让');
  eq(plugin.uniqueNameIn('每日笔记', '2026-12-02'), '2026-12-02', '不撞名就原样用它');
  eq(plugin.uniqueNameIn('', 'z-根笔记'), 'z-根笔记 2', '库根那层同规则（夹具里 z-根笔记.md 已存在）');
  eq(plugin.uniqueNameIn('别的目录', '2026-12-01'), '2026-12-01', '换个目录就不算撞名');
  eq(plugin.uniqueNameIn('每日笔记', '  '), '', '空白标题规成空串，交给调用方报错');

  // createNoteFlow 的两种同名策略：ensureNew=true 必须照建；否则保持"打开已有的"
  const before29 = filesByPath.size;
  const dup29 = await plugin.createNoteFlow({ folder: '每日笔记', forcedName: '2026-12-01', content: '# 又一篇\n', ensureNew: true });
  ok(!!dup29 && dup29.path === '每日笔记/2026-12-01 3.md', 'ensureNew：撞名照建，自动存成「X 3」', dup29 && dup29.path);
  eq(filesByPath.size, before29 + 1, '确实多了一个文件');
  const opened29 = filesByPath.size;
  stub.Notice.last = null;
  const keep29 = await plugin.createNoteFlow({ folder: '每日笔记', forcedName: '2026-12-01', content: '# 不该建\n' });
  eq(keep29 && keep29.path, '每日笔记/2026-12-01.md', '不传 ensureNew 时仍是"同名直接打开"（快捷新建那条路的语义没变）');
  eq(filesByPath.size, opened29, '那次没有再建文件');
  ok(/直接打开/.test(String(stub.Notice.last)), '给了"已存在同名笔记，直接打开"的提示', stub.Notice.last);
  plugin.coreConfig = null;

  console.log('\n[30] 待办清单：ISO 周分组 + 两篇 markdown 的读写（第三十二轮）');
  const TD = KbWorkbenchPlugin;
  // ① 周键：周一起算，且跨年那一周归 ISO 年（不是自然年）
  const mkD = (y, m, d) => new Date(y, m - 1, d);
  eq(TD.isoWeekKey(mkD(2026, 11, 5)), '2026-W45', '2026-11-05（周四）在 2026-W45');
  eq(TD.isoWeekKey(mkD(2026, 11, 2)), '2026-W45', '同一周的周一还是 W45');
  eq(TD.isoWeekKey(mkD(2026, 11, 8)), '2026-W45', '同一周的周日仍算 W45（周一起算，不是周日起算）');
  eq(TD.isoWeekKey(mkD(2026, 11, 9)), '2026-W46', '下周一就换周');
  eq(TD.isoWeekKey(mkD(2025, 12, 29)), '2026-W01', '2025-12-29 那周属于 ISO 2026 的第 1 周');
  eq(TD.isoWeekKey(mkD(2027, 1, 1)), '2026-W53', '2027-01-01 还属于 2026-W53（ISO 年 ≠ 自然年）');
  eq(TD.isoWeekOf(mkD(2026, 11, 5)).monday.getDay(), 1, 'isoWeekOf 给回的是这一周的周一');
  eq(TD.shiftWeekKey('2026-W45', 1), '2026-W46', '周键 +1 周');
  eq(TD.shiftWeekKey('2026-W45', -1), '2026-W44', '周键 -1 周');
  eq(TD.shiftWeekKey('2026-W53', 1), '2027-W01', '跨年：W53 之后是下一年 W01');
  eq(TD.shiftWeekKey('2026-11-05', 1), '', '不是周键就返回空串（不猜）');
  ok(/~/.test(TD.weekSpanText('2026-W45')), 'weekSpanText 给出周一~周日区间', TD.weekSpanText('2026-W45'));

  // ② 解析：只认自己看得懂的行，用户在这两篇里写的别的东西一概不动
  const tdoc = [
    '# 每日待办',
    '',
    '## 2026-11-05',
    '- [ ] 写周报',
    '- [x] 跑测试',
    '  这行是随手写的说明，不是待办',
    '- [ ] ',
    '',
    '## 2026-11-06',
    '- [ ] 明天的事',
    '',
    '### 2026-11-06 的子标题（三级标题不算分组）',
    '- [ ] 挂在子标题下的行仍归 11-06 那一组',
    '',
    '## 随便一个标题',
    '- [ ] 这组没人认，因为标题不是日期/周键',
  ].join('\n');
  const tsecs = TD.parseTodoSections(tdoc);
  eq(tsecs.length, 2, '只认 "## 日期/周键" 两种分组', tsecs.map((s) => s.key));
  eq(tsecs[0].key, '2026-11-05', '第一组是 11-05');
  eq(tsecs[0].items.length, 2, '11-05 两条（空正文的 "- [ ] " 不算）');
  eq(tsecs[0].items[1].done, true, '第二行是已完成的');
  eq(tsecs[1].items.length, 2, '11-06 两条（三级标题下的行仍属于这一组）');
  ok(!tsecs.some((s) => /随便/.test(s.key)), '非日期标题不建组');
  eq(TD.todoOpenKeys(TD.parseTodoSections('# x\n\n## 2026-11-05\n- [x] 全勾完了\n'))['2026-11-05'], undefined, '全勾掉的组不算"有待办"（红点该消失）');
  eq(Object.keys(TD.todoOpenKeys(tsecs)).join(','), '2026-11-05,2026-11-06', '有未完成的就是红点的那些天');

  // ③ 加一条：已有组往组尾插；没有组就新建；空正文不动文件
  const tAdded = TD.addTodoInSection(tdoc, '2026-11-05', '新的一条');
  ok(/## 2026-11-05\n- \[ \] 写周报\n- \[x\] 跑测试\n- \[ \] 新的一条/.test(tAdded), '插到 11-05 那一组的最后一条之后', tAdded.split('\n').slice(2, 7));
  const tNewSec = TD.addTodoInSection(tdoc, '2026-11-30', '月底的事');
  ok(/## 2026-11-30\n- \[ \] 月底的事/.test(tNewSec), '没有这一组就新建一组');
  eq(TD.parseTodoSections(tNewSec).length, 3, '新建的那组也进解析结果');
  eq(TD.addTodoInSection(tdoc, '2026-11-05', '   '), null, '空白正文返回 null（调用方不动文件）');
  ok(/随手写的说明/.test(tAdded) && /挂在子标题下的行/.test(tAdded), '用户写的别的行一个字不丢');
  const tFlip = TD.setTodoDoneAt(tAdded, 3, true);
  ok(/- \[x\] 写周报/.test(tFlip), '按行号勾掉某一条');
  // 插入的新行落在组内最后一条之后（5），原来那行说明被推到 6 —— 拿 6 验「不是任务行就不改」
  eq(TD.setTodoDoneAt(tAdded, 6, true), null, '那一行不是任务行就不改（用户随手写的说明不会被涂成勾）');
  eq(TD.setTodoDoneAt(tAdded, 999, true), null, '行号越界返回 null');
  const tDrop = TD.dropTodoLine(tAdded, 4);
  ok(!/- \[x\] 跑测试/.test(tDrop) && /## 2026-11-05/.test(tDrop), '删行只删那一条，标题留着');
  eq(TD.dropTodoLine(tAdded, 2), null, '标题行不许被"删一条待办"删掉');

  // ④ 行号会漂：手改之后按正文找回那一行；找不回就不动
  eq(TD.findTodoLine(tFlip, 3, '写周报'), 3, '原行号上就是那条 → 用它');
  const tShift = ['# x', '', '## 2026-11-05', '- （插进来的一行正文）', '- [ ] 写周报'].join('\n');
  eq(TD.findTodoLine(tShift, 3, '写周报'), 4, '上面多插了一行 → 找同文的最近那一行，不改错行');
  eq(TD.findTodoLine(tShift, 3, '这条根本不存在'), -1, '找不到就返回 -1（调用方什么都不改）');
  const tDup = ['# x', '', '## 2026-11-05', '- [ ] 一样的', '- [ ] 一样的'].join('\n');
  eq(TD.findTodoLine(tDup, 4, '一样的'), 4, '同文两条时取离原行号最近的那条');

  // ⑤ 落盘：文件不存在先建（带一级标题），之后只用 vault.process 改那一段
  eq(plugin.todoFilePath('daily'), '待办/每日待办.md', '默认路径（每日）');
  eq(plugin.todoFilePath('weekly'), '待办/每周待办.md', '默认路径（每周）');
  plugin.settings.todoDailyPath = '   ';
  eq(plugin.todoFilePath('daily'), '待办/每日待办.md', '留空回默认 —— normalizePath("") 在真机是 "/"，判空必须走 normDir');
  plugin.settings.todoDailyPath = '待办/每日待办.md';
  const before30 = filesByPath.size;
  const wrote30 = await plugin.addTodo('daily', '2026-12-10', '盘上写一条');
  ok(!!wrote30, 'addTodo 返回写进去的正文');
  eq(filesByPath.size, before30 + 1, '第一次写自动创建文件（不往库里多塞别的）');
  const dailyText = contents.get('待办/每日待办.md');
  ok(/^# 每日待办/.test(dailyText), '新建的文件带一级标题', dailyText.slice(0, 20));
  ok(/## 2026-12-10\n- \[ \] 盘上写一条/.test(dailyText), '按日期分组落盘', JSON.stringify(dailyText));
  await plugin.addTodo('daily', '2026-12-10', '同一天第二条');
  eq(filesByPath.size, before30 + 1, '第二条不再建新文件');
  ok(/- \[ \] 盘上写一条\n- \[ \] 同一天第二条/.test(contents.get('待办/每日待办.md')), '同一天按顺序追加');
  await plugin.addTodo('weekly', TD.isoWeekKey(new Date()), '本周的事');
  ok(/## \d{4}-W\d{2}\n- \[ \] 本周的事/.test(contents.get('待办/每周待办.md')), '每周待办落到第二个文件，按周键分组');

  // 勾掉 / 删除：都要先按正文复核行号
  const s30 = await plugin.readTodoSections('daily');
  const one30 = TD.todoSectionFor(s30, '2026-12-10').items[0];
  ok(await plugin.setTodoDone('daily', one30.line, one30.text, true), '勾掉一条（写回文件）');
  ok(/- \[x\] 盘上写一条/.test(contents.get('待办/每日待办.md')), '文件里真的变成 [x]');
  ok(!(await plugin.setTodoDone('daily', one30.line, '这条根本不存在', true)), '正文对不上就不写（宁可不动，绝不改错行）');
  ok(/- \[x\] 盘上写一条/.test(contents.get('待办/每日待办.md')), '没写对正文时文件仍是原样（没被改坏）');
  const s30b = await plugin.readTodoSections('daily');
  const two30 = TD.todoSectionFor(s30b, '2026-12-10').items[1];
  ok(await plugin.removeTodo('daily', two30.line, two30.text), '删一条');
  ok(!/同一天第二条/.test(contents.get('待办/每日待办.md')), '那条真的从文件里没了');
  ok(/盘上写一条/.test(contents.get('待办/每日待办.md')), '只删了那一条（另一条还在）');

  // ⑥ 这两篇是插件自己的清单：不许再被全库任务扫到（否则和任务卡/到期日历重复）
  const tasks30 = await plugin.collectTasks();
  ok(!tasks30.some((t) => t.file && t.file.path === '待办/每日待办.md'), '每日待办的勾不进全库任务清单');
  ok(!tasks30.some((t3) => t3.file && t3.file.path === '待办/每周待办.md'), '每周待办也不进');
  ok(plugin.isTodoFile('待办/每日待办.md') && plugin.isTodoFile('待办/每周待办.md'), 'isTodoFile 认得这两个路径');
  ok(!plugin.isTodoFile('每日笔记/速记.md'), '别的文件不误判成待办文件');

  // ⑦ 一次渲染共用一份扫描（待办卡 + 月历红点），改完数据必须失效重读
  plugin._todosShared = null;
  const r30a = await plugin.todosForRender();
  const r30b = await plugin.todosForRender();
  ok(r30a === r30b, 'todosForRender 同一次渲染复用同一份（不重复读盘）');
  // 2026-12-10 在前面那几步里已经被勾掉/删掉了，红点要拿一条【新开】的待办来验
  await plugin.addTodo('daily', '2026-12-11', '红点看这条');
  const r30r = await plugin.todosForRender();
  ok(r30r.openDaily['2026-12-11'] === true, '有未完成待办的那天要标红点');
  ok(!r30r.openDaily['2026-12-10'], '全勾掉/删光的那天不标红点');
  const one30b = TD.todoSectionFor(r30r.daily, '2026-12-11').items[0];
  await plugin.setTodoDone('daily', one30b.line, one30b.text, true);
  const r30c = await plugin.todosForRender();
  ok(r30c !== r30r, '写完数据缓存失效，重读一份');
  ok(!r30c.openDaily['2026-12-11'], '勾掉最后一条后红点消失');
  const del30 = TD.todoSectionFor(r30c.daily, '2026-12-11').items[0];
  await plugin.removeTodo('daily', del30.line, del30.text);

  console.log('\n[31] 改了名字就不算日记了：rename 搬路径 + 日期前缀兜底 + 启动补映射（第三十五轮）');
  /* 用户真机：按日记模板建好之后把笔记改了名 ⇒ 月历那天的 ● 没了、「这天已建几篇」也空。
     根因：dailyNotes 记的是路径，改名后旧路径不存在，而插件从没监听 rename。 */
  plugin.coreConfig = { dailyFolder: '每日笔记', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' };
  const K31 = '2026-12-20', OLD31 = '每日笔记/' + K31 + '.md', NEW31 = '每日笔记/' + K31 + ' 随笔.md';
  const D31 = new Date(2026, 11, 20);
  mkFile(OLD31, '# ' + K31 + '\n\n正文\n');
  plugin.dailyNotes = {}; plugin.dailyNotes[K31] = [OLD31];
  plugin.pins = [OLD31, '无关/留着.md']; plugin.sticks = [OLD31];
  plugin.recentOpenedList = [{ path: OLD31, time: 111 }, { path: '无关/留着.md', time: 222 }];
  plugin._dailyIndex = null;
  eq(plugin.dailyNotesFor(D31).map((f) => f.path).join(','), OLD31, 'a) 改名前：这天认得那篇');
  // 真改名的夹具动作：旧路径消失、新路径出现（Obsidian 会连内容一起搬）
  const body31 = contents.get(OLD31);
  filesByPath.delete(OLD31); contents.delete(OLD31);
  mkFile(NEW31, body31);
  const moved31 = plugin.onVaultRename({ path: NEW31 }, OLD31);
  ok(moved31 === true, 'b) rename 处理器报告【改了】');
  eq(plugin._dailyIndex, null, 'b) 日期前缀索引当场失效（不失效就会读到旧名字）');
  eq(plugin.dailyNotes[K31].join(','), NEW31, 'b) 月历映射跟着搬到新路径', plugin.dailyNotes[K31]);
  eq(plugin.dailyNotesFor(D31).map((f) => f.path).join(','), NEW31, 'b) 改名后这天仍然算有日记（● 不丢）');
  eq(plugin.pins.join(','), NEW31 + ',无关/留着.md', 'c) 收藏里那条也搬了（同族：路径为键的都算）', plugin.pins);
  eq(plugin.sticks.join(','), NEW31, 'c) 置顶那条也搬了');
  eq(plugin.recentOpenedList.map((x) => x.path).join(','), NEW31 + ',无关/留着.md', 'c) 最近打开那条也搬了');
  eq(plugin.recentOpenedList[0].time, 111, 'c) 搬路径没把时间戳弄丢');
  const moved31b = plugin.onVaultRename({ path: NEW31 }, NEW31);
  ok(moved31b === false, 'd) 旧路径==新路径 ⇒ 什么都不动');
  ok(plugin.onVaultRename({ path: '每日笔记/别篇.md' }, '每日笔记/没在这儿的.md') === false, 'd) 没命中任何状态时返回 false');
  // 文件夹改名：里面的文件按前缀搬
  plugin.dailyNotes = { '2026-12-22': ['每日笔记/2026-12-22.md'] };
  plugin.pins = ['每日笔记/2026-12-22.md'];
  // 防呆先走一遍：np 带 .md 时不能当文件夹前缀用（真机那样会把路径拼两遍，测试抓到过）
  ok(plugin.onVaultRename({ path: '日记本/2026-12-22.md' }, '每日笔记') === false, 'e) 文件形状的新路径 + 文件夹旧路径 ⇒ 不动');
  eq(plugin.dailyNotes['2026-12-22'].join(','), '每日笔记/2026-12-22.md', 'e) 上一条确实什么都没改（没拼出双路径）');
  plugin.onVaultRename({ path: '日记本' }, '每日笔记');   // 真正的文件夹改名事件：file 是新文件夹
  eq(plugin.dailyNotes['2026-12-22'].join(','), '日记本/2026-12-22.md', 'e) 改的是文件夹 ⇒ 里面的路径按前缀一起搬', plugin.dailyNotes);
  eq(plugin.pins.join(','), '日记本/2026-12-22.md', 'e) 收藏也跟着搬');
  // 日期前缀索引：只认开头，只认日记夹
  plugin.coreConfig = { dailyFolder: '每日笔记', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' };
  plugin._dailyIndex = null;
  mkFile('每日笔记/2026-12-23 复盘.md', '# 复盘\n');
  mkFile('每日笔记/随笔 2026-12-24.md', '# 日期在中间\n');
  mkFile('别的目录/2026-12-25.md', '# 不在日记夹\n');
  const idx31 = plugin.dailyIndex();
  ok((idx31['2026-12-23'] || []).length === 1, 'f) 名字以日期开头的算这天', Object.keys(idx31));
  ok(!idx31['2026-12-24'], 'f) 日期在中间的不算（免得把引用了别天日期的笔记算进来）');
  ok(!idx31['2026-12-25'], 'f) 不在日记夹的不算');
  ok(!idx31['2026-12-20'] || idx31['2026-12-20'].every((f) => f.path === NEW31), 'f) 索引里那篇就是改名后的');
  // 兜底：映射指着不存在的路径（改名发生在插件没运行时），dailyNotesFor 仍认得
  plugin.dailyNotes = { '2026-12-23': ['每日笔记/2026-12-23.md'] };
  plugin._dailyIndex = null;
  const fb31 = plugin.dailyNotesFor(new Date(2026, 11, 23));
  eq(fb31.map((f) => f.path).join(','), '每日笔记/2026-12-23 复盘.md', 'g) 映射是坏的，但按日期前缀兜底仍然算这天有日记', fb31.map((f) => f.path));
  // 一次 render 里 42 个格子只建一份索引
  let gmCalls31 = 0;
  const origGm31 = plugin.app.vault.getMarkdownFiles.bind(plugin.app.vault);
  plugin.app.vault.getMarkdownFiles = () => { gmCalls31++; return origGm31(); };
  plugin._dailyIndex = null;
  for (let i = 1; i <= 42; i++) plugin.dailyNotesFor(new Date(2026, 11, Math.min(i, 28)) );
  plugin.app.vault.getMarkdownFiles = origGm31;
  ok(gmCalls31 <= 1, 'h) 42 次查询共用一份索引（不是一格扫一遍全库）', gmCalls31);
  // 启动补映射
  let persisted31 = 0;
  const origPersist31 = plugin.persist.bind(plugin);
  plugin.persist = async () => { persisted31++; return origPersist31(); };
  plugin.dailyNotes = { '2026-12-23': ['每日笔记/2026-12-23.md'], '2026-12-31': ['每日笔记/彻底没有这篇.md'] };
  plugin._dailyIndex = null;
  const rep31 = plugin.repairDailyNotes();
  plugin.persist = origPersist31;
  ok(rep31 === true, 'i) 补映射报告改了');
  eq(plugin.dailyNotes['2026-12-23'].join(','), '每日笔记/2026-12-23 复盘.md', 'i) 坏路径被补成真实存在的那篇', plugin.dailyNotes);
  ok(!plugin.dailyNotes['2026-12-31'], 'i) 补不到的那天丢掉键（不留指不到东西的死路径）');
  ok(persisted31 >= 1, 'i) 补过之后落盘一次');
  plugin.dailyNotes = {}; plugin.pins = []; plugin.sticks = []; plugin.recentOpenedList = [];
  plugin._dailyIndex = null; plugin.coreConfig = null;

  console.log('\n[32] 第三十七轮体检：todoOpenCounts 纯函数 + 重复 API 已收掉');
  const TD32 = require(PLUGIN);
  const txt32 = '# 每日待办\n\n## 2027-01-05\n- [ ] 甲\n- [x] 乙\n- [ ] 丙\n\n## 2027-01-06\n- [x] 全勾掉了\n';
  const sec32 = TD32.parseTodoSections(txt32);
  eq(TD32.todoOpenCounts(sec32)['2027-01-05'], 2, 'a) 未完成计数按天算（两条未完成）', TD32.todoOpenCounts(sec32));
  ok(!TD32.todoOpenCounts(sec32)['2027-01-06'], 'a) 全勾完的那天不进计数（也不该标红点）');
  eq(TD32.todoOpenCounts(null) && Object.keys(TD32.todoOpenCounts(null)).length, 0, 'b) 喂 null 不炸，返回空表');
  ok(Object.keys(TD32.todoOpenCounts(sec32)).join(',') === Object.keys(TD32.todoOpenKeys(sec32)).join(','),
    'c) 计数表与红点表覆盖同一批天（两者必须一致，否则 ● 与「待办 N 条」会互相打脸）');
  const pl32 = plugin;
  ok(typeof pl32.dailyPathFor === 'undefined', 'd) dailyPathFor 已删（和 dailyFormatPath 是同一个东西的两个名字）');
  eq(typeof pl32.dailyFormatPath, 'function', 'd) 命名只留一套：dailyFormatPath');
  ok(typeof pl32.moveModule === 'undefined' && typeof pl32.templateLabel === 'undefined', 'e) 两个零引用方法已删');

  console.log('\n----------------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
