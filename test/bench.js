'use strict';
/*
 * 性能体检（只读，不写任何文件）
 *   node test\bench.js
 *
 * 用真实笔记库跑插件自己的数据层代码，量它吃多少时间、读多少文件。
 *
 * 口径（别把这些数字当成 Obsidian 里的全部真相）：
 *  - vault.cachedRead 在 Obsidian 里命中内存；这里走磁盘 ⇒ I/O 是上限。
 *  - metadataCache 在 Obsidian 里是常驻且已解析好的；这里预先解析一遍再喂，
 *    所以"解析全库"那行不计入插件成本，只是准备数据。
 *  - DOM 布局/绘制成本在 Node 里量不出来（垫片没有排版引擎），本脚本不报，
 *    浏览器侧的机制性成本看 preview.html?drag=1 的 dragAB。
 */

const Module = require('module');
const fs = require('fs');
const path = require('path');

const VAULT = process.env.KBWB_VAULT || path.join(__dirname, '..', 'vault');
const PLUGIN_DIR = path.join(__dirname, '..');
const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

const stubPath = path.join(__dirname, 'obsidian-stub.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return stubPath;
  return origResolve.call(this, request, ...rest);
};
const stub = require(stubPath);
const dom = require('./dom-shim.js');

/* ---------- 全局：Obsidian 由 Electron 提供的那几样 ---------- */
global.window = { setInterval: () => 0, clearInterval: () => {}, setTimeout: (f) => f(), matchMedia: () => ({ matches: false }), innerWidth: 1200 };
global.document = {
  activeElement: null,
  createElement: (t) => new dom.El(t),
  _l: {},
  addEventListener(t, cb) { (this._l[t] = this._l[t] || []).push(cb); },
  removeEventListener(t, cb) { this._l[t] = (this._l[t] || []).filter((x) => x !== cb); },
};
global.requestAnimationFrame = (cb) => { cb(); return 0; };
const ViewProto = stub.ItemView.prototype;
Object.defineProperty(ViewProto, 'contentEl', {
  get() { return this.__contentEl || (this.__contentEl = dom.createRoot()); },
  set(v) { this.__contentEl = v; }, configurable: true,
});

/* ---------- 磁盘：把库读成 Obsidian 的 TFile 形状 ---------- */
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const t0 = hr();
const allPaths = walk(VAULT);
const mdPaths = allPaths.filter((p) => p.toLowerCase().endsWith('.md'));
const scanMs = ms(t0);

const filesByPath = new Map();
const content = new Map();
let totalBytes = 0, mdBytes = 0;

const t1 = hr();
for (const p of allPaths) {
  const rel = path.relative(VAULT, p).replace(/\\/g, '/');
  let st = null;
  try { st = fs.statSync(p); } catch (e) { continue; }
  totalBytes += st.size;
  const f = new stub.TFile(rel);
  f.stat = { ctime: st.birthtimeMs, mtime: st.mtimeMs, size: st.size };
  filesByPath.set(rel, f);
  if (f.extension === 'md') {
    mdBytes += st.size;
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) { text = ''; }
    content.set(rel, text);
  }
}
const warmMs = ms(t1);

/* ---------- 预解析 metadataCache（Obsidian 自己会做，这里只是喂数据） ---------- */
function buildCache(text) {
  const lines = text.split('\n');
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
const t2 = hr();
const cacheMap = new Map();
for (const [p, text] of content) cacheMap.set(p, buildCache(text));
const parseMs = ms(t2);

// resolvedLinks：扫 [[目标]] / ![[目标]]，尽力解析成库内路径（Obsidian 有完整解析器，这里够用即可）
const linkMap = {};
const byBase = new Map();
for (const f of filesByPath.values()) {
  if (f.extension !== 'md') continue;
  const k = f.basename.toLowerCase();
  if (!byBase.has(k)) byBase.set(k, f.path);
}
for (const [p, text] of content) {
  const out = {};
  const re = /!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const want = m[1].trim().toLowerCase();
    const target = byBase.get(want) || byBase.get(path.basename(want).toLowerCase());
    if (target && target !== p) out[target] = (out[target] || 0) + 1;
  }
  linkMap[p] = out;
}

/* ---------- 假 app ---------- */
let readCount = 0, readBytes = 0;
const vault = {
  configDir: '.obsidian',
  adapter: { exists: async () => true, read: async (p) => content.get(p) || '' },
  getFiles: () => Array.from(filesByPath.values()),
  getMarkdownFiles: () => Array.from(filesByPath.values()).filter((f) => f.extension === 'md'),
  getFileByPath: (p) => filesByPath.get(stub.normalizePath(p)) || null,
  getFolderByPath: () => null,
  getAbstractFileByPath: (p) => filesByPath.get(stub.normalizePath(p)) || null,
  cachedRead: async (f) => {
    const text = content.get(f.path) || '';
    readCount++; readBytes += text.length;
    return text;
  },
  process: async (f, fn) => { const out = fn(content.get(f.path)); content.set(f.path, out); return out; },
  create: async () => { throw new Error('bench 不写库'); },
  createFolder: async () => {},
  on: () => ({}),
};
const app = {
  vault,
  metadataCache: {
    getFileCache: (f) => cacheMap.get(f.path) || null,
    resolvedLinks: linkMap,
    on: () => ({}),
  },
  workspace: {
    on: () => ({}), onLayoutReady: (cb) => cb(), getLeavesOfType: () => [],
    getLeaf: () => ({ setViewState() {}, openFile: async () => {}, view: { setEphemeralState() {} } }),
    revealLeaf: async () => {}, detachLeavesOfType() {}, getActiveViewOfType: () => null,
    ensureSideLeaf: () => ({ setViewState() {}, openFile: async () => {}, view: { setEphemeralState() {} }, containerEl: { closest: () => ({}) } }),
  },
  plugins: { getPlugin: () => null },
  setting: { open() {}, openTabById() {} },
};

/* ---------- 插件实例：用用户真实的 data.json 设置 ---------- */
let realData = {};
try { realData = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'data.json'), 'utf8')); } catch (e) { realData = {}; }

let creator = null;
// KBWB_MAIN：交错 A/B 用的开关（同一个库里换一份 main.js 跑，别动真插件目录）
//   例：$env:KBWB_MAIN='D:\path\main-variant.js'; node test\bench.js
const MAIN = process.env.KBWB_MAIN || path.join(PLUGIN_DIR, 'main.js');
const KbWorkbenchPlugin = require(MAIN);
const plugin = new KbWorkbenchPlugin(app, { id: 'kb-workbench' });
plugin.loadData = async () => realData;
plugin.saveData = async () => {};
plugin.registerView = (type, c) => { creator = c; };
plugin.registerEvent = () => ({});
plugin.registerInterval = (id) => id;
plugin.addSettingTab = () => {};
plugin.addRibbonIcon = () => ({ addEventListener() {} });
plugin.addCommand = () => ({});

/* ---------- 计时工具 ---------- */
function hr() { return process.hrtime.bigint(); }
function ms(t) { return Math.round(Number(process.hrtime.bigint() - t) / 1e5) / 10; }
async function time(label, fn, note) {
  readCount = 0; readBytes = 0;
  const t = hr();
  const r = await fn();
  const d = ms(t);
  const kb = (readBytes / 1024 / 1024).toFixed(2);
  console.log('  ' + pad(label, 26) + pad(d + ' ms', 12) + pad('cachedRead ' + readCount, 18) + pad(kb + ' MB', 10) + (note ? '  ' + note : '') + (r && r.n ? '  → ' + r.n : ''));
  return d;
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

(async () => {
  await plugin.onload();
  const s = plugin.settings;
  console.log('\n================ kb-workbench 性能体检（真实库，只读） ================');
  console.log('库: ' + VAULT);
  console.log('文件 ' + allPaths.length + ' 个（md ' + mdPaths.length + '）｜总体积 ' +
    (totalBytes / 1024 / 1024).toFixed(1) + ' MB｜md ' + (mdBytes / 1024 / 1024).toFixed(1) + ' MB');
  console.log('相关设置: taskScope=' + JSON.stringify(s.taskScope) + ' taskExclude=' + JSON.stringify(s.taskExclude) +
    ' taskLimit=' + s.taskLimit + ' wordCountCap=' + s.wordCountCap + ' showWordCount=' + s.showWordCount +
    ' autoRefresh=' + s.autoRefresh + 's hoverFx=' + s.hoverFx);
  console.log('\n[准备阶段]（不是插件的成本，Obsidian 自己会做/已做好）');
  console.log('  目录遍历 ' + scanMs + ' ms｜读全库到内存 ' + warmMs + ' ms｜正则解析全库 ' + parseMs + ' ms');

  console.log('\n[插件数据层成本]');
  const tTasks = await time('collectTasks()', async () => {
    const list = await plugin.collectTasks();
    return { n: list.length + ' 条' };
  }, '每次刷新都重新扫全库');
  plugin.statsCache = null; plugin.hygieneCache = null;
  const tStats = await time('computeStats()', async () => {
    const st = await plugin.computeStats();
    return { n: (st && st.md) + ' 篇' };
  }, '含字数估算（上限 ' + s.wordCountCap + ' 篇）');
  const tHyg = await time('computeHygiene()', async () => {
    const h = plugin.computeHygiene();
    return { n: '空 ' + h.empty.length + ' / 无标签 ' + h.untagged.length + ' / 无入链 ' + h.orphan.length };
  }, '只用 stat + cache，不读正文');

  plugin.statsCache = null; plugin.hygieneCache = null;
  const tAll = await time('三件事连做（= 一次强制刷新）', async () => {
    await plugin.collectTasks();
    await plugin.computeStats();
    plugin.computeHygiene();
  });

  // 库没动的时候，第二次强制刷新应该走缓存（字数签名）
  plugin.statsCache = null; plugin.statsJob = null; plugin.hygieneCache = null;
  const tSecond = await time('再强制刷新一次（库未改动）', async () => {
    await plugin.collectTasks();
    await plugin.computeStats();
    plugin.computeHygiene();
  }, '字数走签名缓存 ⇒ 不重读正文');

  console.log('\n[布局层成本]（每次 render 都会反复走）');
  let calls = 0;
  const origLayoutList = plugin.layoutList.bind(plugin);
  plugin.layoutList = function () { calls++; return origLayoutList(); };
  const t = hr();
  for (let i = 0; i < 200; i++) plugin.layoutList();
  const perLayout = ms(t) / 200;
  console.log('  layoutList() 单次 ' + perLayout.toFixed(3) + ' ms（200 次 ' + ms(t) + ' ms）');

  console.log('\n[整版渲染]（DOM 用垫片，不含浏览器排版/绘制）');
  const view = creator({ app });
  view.app = app;
  view.__contentEl = dom.createRoot();
  view.containerEl = { addClass() {}, isConnected: true, empty() {}, style: { setProperty() {}, removeProperty() {} } };
  calls = 0;
  const tRender = await time('render() 首次（含扫描）', async () => { await view.render(); });
  calls = 0;
  const tRender2 = await time('render() 二次（缓存命中）', async () => { await view.render(); },
    'layoutList() 被调用 ' + calls + ' 次');
  console.log('  渲染出卡片数: ' + view.__contentEl.findAll('.kbwb-card').length);

  // KBWB_PROFILE=1：把一次整版渲染里【每个格子重复做的事】数出来并计时（冗余代码的量化入口）
  if (process.env.KBWB_PROFILE) {
    console.log('\n[渲染内剖析]（KBWB_PROFILE=1）');
    const proto = Object.getPrototypeOf(plugin);
    const names = ['dailyNotesFor', 'dailyIndex', 'todosForRender', 'collectTasks', 'computeStats', 'computeHygiene', 'layoutList', 'dailyFormatPath', 'dailyNameFor'];
    const stats = {};
    for (const n of names) {
      if (typeof plugin[n] !== 'function') continue;
      const orig = plugin[n].bind(plugin);
      stats[n] = { calls: 0, ms: 0 };
      plugin[n] = function (...a) { const t0 = hr(); try { return orig(...a); } finally { stats[n].ms += ms(t0); stats[n].calls++; } };
    }
    const ROUNDS = 20;
    const tP = hr();
    for (let i = 0; i < ROUNDS; i++) await view.render();
    const totalP = ms(tP);
    // 组扫描这类不在 plugin 上的热函数，用月历卡的格子数间接算
    const cells = view.__contentEl.findAll('.kbwb-cal-cell').length;
    for (const n of names) {
      if (!stats[n]) continue;
      console.log('  ' + pad(n, 18) + pad(stats[n].calls + ' 次', 10) + pad((stats[n].ms * 1000).toFixed(0) + ' µs', 12) +
        (stats[n].calls ? pad('均 ' + (stats[n].ms * 1000 / stats[n].calls).toFixed(1) + ' µs', 13) : '') +
        (stats[n].calls ? pad('每渲染 ' + (stats[n].ms * 1000 / ROUNDS).toFixed(0) + ' µs', 14) : '') +
        (n === 'dailyNotesFor' ? '← 月历格子 ' + cells + ' 个，每格一次' : ''));
    }
    console.log('  整版 render ×' + ROUNDS + ' = ' + totalP.toFixed(1) + ' ms（单次 ' + (totalP / ROUNDS).toFixed(2) + ' ms）');
    for (const n of names) { if (stats[n]) delete plugin[n]; }   // 还原，别污染后面的测量
  }
  console.log('\n[单卡重建]（第三十三轮改的就是这条：每次点日期/勾任务/增删待办都走它）');
  for (const id of ['calendar', 'todos', 'writing', 'tasks']) {
    readCount = 0; readBytes = 0;
    const t0 = hr();
    const N = Number(process.env.KBWB_REBUILD_N || 30);   // KBWB_REBUILD_N=0 可以整段跳过（隔离脚本自己的内存）
    for (let i = 0; i < N; i++) await view.refreshCard(id);   // refreshCard 自带串行链
    const per = ms(t0) / N;
    console.log('  ' + pad(id, 10) + pad(per.toFixed(2) + ' ms/次', 14) + pad('总 ' + ms(t0) + ' ms', 12) +
      pad('cachedRead ' + readCount, 18) + pad((readBytes / 1024 / 1024).toFixed(2) + ' MB', 10) +
      '网格内该卡数 ' + view.__contentEl.findAll('.kbwb-card').filter(function (c) { return c.dataset && c.dataset.mod === id; }).length);  // 垫片 findAll 不支持属性选择器，按 dataset 筛
  }
  // 「跳」的物质量法：整版重绘会换新全部卡的节点，单卡重建只换那一张
  const countNodes = (el) => { let n = 1; for (const c of (el.children || [])) n += countNodes(c); return n; };
  const allCards = view.__contentEl.findAll('.kbwb-card');
  const totalNodes = allCards.reduce((a, c) => a + countNodes(c), 0);
  const calNodes = countNodes(allCards.find((c) => c.dataset && c.dataset.mod === 'calendar') || { children: [] });
  console.log('  节点量级：' + allCards.length + ' 张卡共 ' + totalNodes + ' 个元素，其中月历卡 ' + calNodes + ' 个');
  console.log('  ⇒ 翻月一次：整版重绘要换新 ' + totalNodes + ' 个；只重建月历卡换 ' + calNodes + ' 个（-' + Math.round((1 - calNodes / totalNodes) * 100) + '%）');
  console.log('  注：refreshCard 每次都会清 _tasksShared/_todosShared（用户刚改过数据必须重扫），');
  console.log('     所以这里的读盘数 = 真实点击一次的成本，不是缓存命中的最好情况。');

  console.log('\n[换算成日常开销]');
  console.log('  自动刷新间隔 ' + s.autoRefresh + 's ⇒ 每小时 ' + Math.round(3600 / s.autoRefresh) +
    ' 次强制刷新 ≈ ' + (tAll * 3600 / s.autoRefresh / 1000).toFixed(1) + ' s CPU/小时（全在扫描上）');
  console.log('  单次强制刷新 ' + tAll + ' ms｜collectTasks ' + tTasks + ' ms｜computeStats ' + tStats + ' ms');
  const mem = process.memoryUsage();
  console.log('  进程 RSS ' + (mem.rss / 1024 / 1024).toFixed(1) + ' MB（含本脚本自己缓存的全库正文 ' +
    (mdBytes / 1024 / 1024).toFixed(1) + ' MB）');
  console.log('\n说明：dragAB（preview.html?drag=1）量的是浏览器侧的机制成本；' +
    '本脚本量的是 JS/IO。DOM 绘制不在这里。');
})().catch((e) => { console.error('BENCH ERROR:', e && e.stack ? e.stack : e); process.exit(2); });
