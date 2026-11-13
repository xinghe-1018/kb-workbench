/*
 * 知识库工作台 (kb-workbench)
 *
 * 单文件 CommonJS 插件，没有构建步骤：直接改这个 main.js，
 * 在 Obsidian「设置 → 第三方插件」里关掉再开启（或重启 Obsidian）即可生效。
 *
 * 模块：搜索 / 快捷新建 / 收藏 / 最近编辑·打开 / 任务 / 知识库结构 / 库统计 / 笔记体检
 *       / 到期日历 / 速记本 / 标签总览 / 月历 / 写作量（第二十轮新增后五张）
 * API 依据：obsidian@latest obsidian.d.ts（Vault.process、cachedRead、
 * MetadataCache.getFileCache + listItems、Leaf.openFile(eState) 等）。
 */

'use strict';

const obsidian = require('obsidian');
const {
  Plugin, ItemView, Modal, SuggestModal, Setting, PluginSettingTab,
  TFile, Notice, normalizePath, debounce, setIcon, getAllTags, moment, MarkdownView,
} = obsidian;

const VIEW_TYPE = 'kb-workbench-view';
const PLUGIN_ID = 'kb-workbench';

/* ================================================================ 设置 */

const DEFAULT_SETTINGS = {
  recentCount: 8,
  openedCount: 6,
  taskScope: '',
  taskExclude: 'raw/, upstream/', // 这些前缀目录里的任务不算待办（导入的原始资料）
  taskDedupe: true,              // 同文去重：多份复制资料的重复任务只留一条
  taskLimit: 60,
  taskFilter: 'open',
  markDoneDate: true,
  showWordCount: true,
  wordCountCap: 4000,
  autoRefresh: 60,
  newNoteFolder: '',
  quickButtons: [],
  hoverFx: true,           // 悬停光斑/强调等特效开关（发糊时可关）
  uiFont: 'MiSans',        // 界面字体预设，空 = 跟随 Obsidian（MiSans 族名经 Chromium 实测命中）
  numFont: 'Consolas',     // 数字/等宽字体预设
  layout: [],              // 自由网格：[{id, col, row, w, h, on, collapsed}]（48 栏制）
  layoutScale: 48,         // 坐标刻度。旧数据是 12/24 栏制，loadAll 里一次性换算成 48
  openWhere: 'left',       // 工作台停靠位置：left | right | main
  minPaneWidth: 300,       // 面板最小宽度（px）：侧栏被拖到更窄时不再继续缩；0 = 不限制
  minPaneHeight: 220,      // 面板最小高度（px）：同上
  minPaneTarget: 'auto',   // 把 min-* 施加在哪一层：auto/split(默认推断)、tabs、leaf、self、dock
  scratchPath: '每日笔记/速记.md', // 速记本：一行一条，回车即追加，带日期时间戳
  scratchLimit: 12,        // 速记卡显示最近几条（新的在上）
  writingKeep: 120,        // 写作量快照保留天数（超出裁剪，别让 data.json 无限长）
  dailyCreateTemplate: '模板/每日任务模板.md',  // 月历建当天笔记用的模板（带 KBWB 标记会填当天任务）；留空 = 用「日记」核心的模板
  templateDir: '',         // 「选模板 / 新增模板」用的目录；留空 = 自动取模板夹（Templater 优先），再退到「模板」
  dailyTasksLimit: 30,     // 每个任务分组最多列几条
  scanRoot: '',            // 全盘扫描的目录（库内相对路径，留空 = 整库）
  scanCap: 3000,           // 全盘扫描最多读多少篇（超了就报「被截断」）
  /* 第三十二轮：待办清单。插件自己维护，落库里两篇 markdown（照 appendScratch 的先例）：
     每日按 ## 2026-11-05 分节、每周按 ## 2026-W45（ISO 周，周一起算）分节。
     与全库带 📅 的任务是两条独立的路：这两篇文件【不】进任务卡/到期日历的扫描（见 isTodoFile）。 */
  todoDailyPath: '待办/每日待办.md',
  todoWeeklyPath: '待办/每周待办.md',
  todoLimit: 20,           // 待办卡与月历「当日待办」一屏最多显示几条
};

/* ---------------------------------------------------------- 模块与字体表 */

/* 自由网格画板：48 列 × 8px 行单元，每张卡有 col/row/w/h，可拖可缩。
   列数演进 12 → 24 → 48，都是因为"左右拖一次改太多"（面板越宽，1/12 越离谱：
   1200px 面板下 100px 一跳；48 列后 25px 一跳，窄侧栏 380px 下约 8px）。
   旧 data.json 的坐标在 loadAll 里按 layoutScale 一次性换算。 */
const GRID_COLS = 48;
const ROW_UNIT = 8;      // px，卡片高度 = h × 8 − 10（含 margin）
const MIN_W = 8;         // = 旧的 2/12，视觉下限不变
const MIN_H = 12;        // 96px 起

const MODULES = [
  { id: 'search', title: '搜索笔记', icon: 'search', dw: 48, dh: 27 },
  { id: 'quick', title: '快捷新建', icon: 'zap', dw: 32, dh: 15 },
  { id: 'pinned', title: '收藏', icon: 'star', dw: 16, dh: 20 },
  { id: 'recent', title: '最近', icon: 'history', dw: 16, dh: 24 },
  { id: 'tasks', title: '任务', icon: 'circle-check-big', dw: 32, dh: 30 },
  { id: 'nav', title: '知识库', icon: 'folder-tree', dw: 16, dh: 32 },
  { id: 'stats', title: '库统计', icon: 'bar-chart-3', dw: 32, dh: 46 },
  { id: 'hygiene', title: '笔记体检', icon: 'stethoscope', dw: 48, dh: 34 },   // 28→34：新开的布局一屏能看到扫描按钮（老库坐标不变，自己拉高）
  /* 第二十轮新增 5 张卡（dw/dh 用 48 栏制：满宽 48、⅔ 32、⅓ 16）。
     老库的 data.json 里没有这些 id 的坐标 —— layoutList() 会给它们补位，
     并且不重排用户已经摆好的那些（见 layoutList 里的 anchors）。 */
  { id: 'due', title: '到期日历', icon: 'calendar-clock', dw: 16, dh: 26 },
  { id: 'scratch', title: '速记本', icon: 'pencil', dw: 32, dh: 20 },
  { id: 'tags', title: '标签总览', icon: 'tags', dw: 16, dh: 30 },
  /* 月历 26 → 34 行：底下多了「当日待办」面板 + 新建笔记按钮。
     老库的坐标不会被自动改（layoutList 只给新 id 补位），要更大自己拉或 ⋯ → 恢复默认。 */
  { id: 'calendar', title: '月历', icon: 'calendar-days', dw: 16, dh: 58 },
  { id: 'writing', title: '写作量', icon: 'trending-up', dw: 32, dh: 24 },
  { id: 'todos', title: '待办', icon: 'list-checks', dw: 16, dh: 30 },   // 第三十二轮：每日 / 每周两页签
];

/**
 * 货架式第一-fit 装箱：给没有坐标的模块排出一个不重叠的初始布局。
 * pins = 不许动的盒子（拖动落位后消解重叠时，用户刚放下的那张必须原地不动）。
 */
function autoPack(items, cols, pins) {
  const W = cols || GRID_COLS;
  const keep = new Set(pins || []);
  const placed = (pins || []).map((p) => ({ col: p.col, row: p.row, w: p.w, h: p.h }));
  const fits = (c, r, w, h) => {
    if (c + w > W + 1) return false;
    return !placed.some((o) => c < o.col + o.w && o.col < c + w && r < o.row + o.h && o.row < r + h);
  };
  for (const it of items) {
    if (keep.has(it)) continue;
    let ok2 = false;
    for (let r = 1; r <= 600 && !ok2; r++) {
      for (let c = 1; c + it.w <= W + 1; c++) {
        if (fits(c, r, it.w, it.h)) {
          it.col = c; it.row = r;
          placed.push({ col: c, row: r, w: it.w, h: it.h });
          ok2 = true;
          break;
        }
      }
    }
    if (!ok2) { it.col = 1; it.row = 601; }
  }
  return items;
}

/** 两个盒子是否重叠（网格坐标：col/row 从 1 起，w/h 是跨度数） */
function boxesHit(a, b) {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

/** 从 fromRow 起往下找第一个能放下这块框的行（col 固定）；600 行内找不到返回 0 */
function firstFreeRow(boxes, col, w, h, fromRow) {
  for (let r = Math.max(1, fromRow); r <= 600; r++) {
    if (!boxes.some((o) => boxesHit({ col, row: r, w, h }, o))) return r;
  }
  return 0;
}

/**
 * 碰撞消解（就地改 l）：以 movedId 为锚不动，其它卡依次让位。
 * 让位顺序 = 用户要的"被压住的那张自动缩小 / 让位"：
 *   ① 同一水平带、它压在我右边 → 我缩窄到它左边
 *   ② 它压在我正下方 → 我压矮到它上面
 *   ③ 缩不动 → 一次整块挪开（横向能挪就横向，否则下移到它之下）
 * 旧写法是 box.row += 1 一行一行蹭，蹭满保护次数就退化成整体 autoPack，
 * 把用户刚放好的位置一起重排掉。
 *
 * 第二十七轮再收两条（用户："只需要被影响到的移走，其他的不要动"）：
 *   · **没被压到的卡一律原地不动**：让位时优先挑"不会撞上还没让位的卡"的落点，
 *     否则 B 挪过去压住 C、C 就被卷进来了（级联）。
 *   · **兜底不再整版重排**：消解不动就只把这一张往下找空位放；
 *     真放不下（600 行内）才退回 autoPack —— 那条路径会把所有卡跳一遍。
 */
function resolveOverlapsIn(l, movedId) {
  const vis = l.filter((s) => s.on);
  const moved = vis.find((s) => s.id === movedId);
  if (!moved) return;
  const boxOf = (s) => ({ col: s.col, row: s.row, w: s.w, h: s.h });
  const placed = [boxOf(moved)];
  const rest = vis.filter((s) => s !== moved).sort((a, b) => (a.row - b.row) || (a.col - b.col));
  const settled = new Set();

  for (const s of rest) {
    const box = boxOf(s);
    let done = false;
    for (let guard = 0; guard < 60 && !done; guard++) {
      const blocker = placed.find((p) => boxesHit(box, p));
      if (!blocker) { done = true; break; }
      // 还没轮到让位的卡保持原位 —— 它们的位置也算"别去撞"
      const others = rest.filter((o) => o !== s && !settled.has(o.id)).map(boxOf);
      const cands = [];
      const band = box.row < blocker.row + blocker.h && blocker.row < box.row + box.h;
      if (band && blocker.col > box.col && blocker.col < box.col + box.w) {
        const avail = blocker.col - box.col;
        if (avail >= MIN_W) cands.push({ col: box.col, row: box.row, w: avail, h: box.h });
      }
      if (blocker.row > box.row && blocker.row < box.row + box.h) {
        const availH = blocker.row - box.row;
        if (availH >= MIN_H) cands.push({ col: box.col, row: box.row, w: box.w, h: availH });
      }
      const pushRight = blocker.col + blocker.w - box.col;
      const pushDown = blocker.row + blocker.h - box.row;
      if (pushRight >= 1 && box.col + pushRight + box.w <= GRID_COLS + 1) {
        cands.push({ col: box.col + pushRight, row: box.row, w: box.w, h: box.h });
      }
      cands.push({ col: box.col, row: box.row + Math.max(1, pushDown), w: box.w, h: box.h });

      const pick = cands.find((c) => !others.some((o) => boxesHit(c, o))) || cands[0];
      box.col = pick.col; box.row = pick.row; box.w = pick.w; box.h = pick.h;
    }
    if (!done) {
      // 兜底只挪这一张：先保持它这一列往下找空位；那一列放不下，再退回第 1 列找
      const others = rest.filter((o) => o !== s && !settled.has(o.id)).map(boxOf);
      const blocked = placed.concat(others);
      let free = firstFreeRow(blocked, box.col, box.w, box.h, box.row);
      if (free) {
        box.row = free;
      } else {
        free = firstFreeRow(blocked, 1, box.w, box.h, 1);
        if (free) { box.col = 1; box.row = free; }
        else { autoPack(vis, GRID_COLS, [moved]); return; }   // 600 行内真放不下，才宁可整版重排
      }
    }
    s.col = box.col; s.row = box.row; s.w = box.w; s.h = box.h;
    placed.push(box);
    settled.add(s.id);
  }
}

/**
 * 落位预演（纯函数，不写盘）：把 movedId 挪到 box（或改成 box 的尺寸）后，
 * 哪些卡会被压小/让位，变成什么框。
 * 拖动途中每换一次落点算一次，缩放途中每吸附一档算一次 —— 两条路共用同一个函数，
 * 于是"预演框"和"松手后的真实结果"必然一致（拖动就是这么保证的，别再分叉）。
 */
function resolveCopyPreview(layout, movedId, box) {
  const copy = layout.map((s) => ({
    id: s.id, col: s.col, row: s.row, w: s.w, h: s.h, on: s.on, collapsed: s.collapsed,
  }));
  const moved = copy.find((s) => s.id === movedId);
  if (!moved) return [];
  moved.col = box.col; moved.row = box.row;
  if (box.w !== undefined) moved.w = box.w;
  if (box.h !== undefined) moved.h = box.h;
  // 变宽后可能顶出右边界：和 setBox/commitResize 同一个夹法
  moved.col = Math.max(1, Math.min(moved.col, GRID_COLS - moved.w + 1));
  resolveOverlapsIn(copy, movedId);
  const before = new Map(layout.map((s) => [s.id, s]));
  return copy.filter((s) => {
    const b = before.get(s.id);
    return s.on && b && s.id !== movedId &&
      (b.col !== s.col || b.row !== s.row || b.w !== s.w || b.h !== s.h);
  }).map((s) => ({ id: s.id, col: s.col, row: s.row, w: s.w, h: s.h }));
}

const BUILDERS = {
  search: 'buildSearchCard', quick: 'buildQuickCard', pinned: 'buildPinnedCard',
  recent: 'buildRecentCard', tasks: 'buildTaskCard', nav: 'buildNavCard',
  stats: 'buildStatsCard', hygiene: 'buildHygieneCard',
  due: 'buildDueCard', scratch: 'buildScratchCard', tags: 'buildTagsCard',
  calendar: 'buildCalendarCard', writing: 'buildWritingCard',
  todos: 'buildTodosCard',
};

/* 宽度单位 = 1/48 栏（48 栏网格）；高度单位 = 8px 行 */
const SIZE_PRESETS = [
  { label: '小', w: 16, h: 22 },     // 1/3 宽
  { label: '中', w: 24, h: 32 },     // 1/2 宽
  { label: '大', w: 32, h: 44 },     // 2/3 宽
  { label: '满宽', w: 48, h: 34 },
];

/* 族名全部经 preview 的 fontProbe 在 Chromium 里实测命中（HIT）；
   MiSans-Regular / Noto Sans SC / JetBrains Mono 命中失败，故不列入。 */
const FONT_UI = {
  '': '',
  MiSans: "'MiSans', 'Microsoft YaHei UI', sans-serif",
  'Noto Sans': "'Noto Sans', 'Microsoft YaHei UI', sans-serif",
  Segoe: "'Segoe UI Variable Text', 'Microsoft YaHei UI', sans-serif",
  DengXian: "'DengXian', 'Microsoft YaHei UI', sans-serif",
  YaHei: "'Microsoft YaHei UI', sans-serif",
  Rubik: "'Rubik', 'Microsoft YaHei UI', sans-serif",
  SimHei: "'SimHei', sans-serif",
};

const FONT_NUM = {
  '': '',
  Consolas: "'Consolas', monospace",
  Cascadia: "'Cascadia Mono', 'Consolas', monospace",
  DejaVu: "'DejaVu Sans Mono', monospace",
  Liberation: "'Liberation Mono', monospace",
};

const FONT_UI_LABEL = {
  MiSans: 'MiSans（小米，现代几何）',
  'Noto Sans': 'Noto Sans（思源系）',
  Segoe: 'Segoe UI Variable（Win11 系统）',
  DengXian: '等线 DengXian',
  YaHei: '微软雅黑 UI',
  Rubik: 'Rubik 拉丁 + 雅黑中文',
  SimHei: '黑体 SimHei（硬朗）',
};

const FONT_NUM_LABEL = {
  Consolas: 'Consolas（Windows 经典）',
  Cascadia: 'Cascadia Mono（终端系）',
  DejaVu: 'DejaVu Sans Mono（宽）',
  Liberation: 'Liberation Mono（Courier 系）',
};

/* ================================================================ 小工具 */

function pad(n) { return n < 10 ? '0' + n : String(n); }

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Date → 'YYYY-MM-DD'（与 todayStr 同一口径，只是不固定在"今天"） */
function ymd(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 'YYYY-MM-DD' → 本地 Date；不合法返回今天（界面拿它算星期几，不能让它是 undefined） */
function ymdToDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 'YYYY-MM-DD' 加减 n 天；格式不对就原样返回（调用方按字符串比较，宁可退化成不分组） */
function shiftDayStr(s, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** HH:mm，给速记行的时间戳用 */
function clockStr(d) {
  const x = d || new Date();
  return pad(x.getHours()) + ':' + pad(x.getMinutes());
}

const YMD_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** 去掉围栏代码块（``` / ~~~）：里面的 #标签、[[链接]] 不算数。全盘扫描自己解析正文时用 */
function stripFences(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(l)) { inFence = !inFence; out.push(""); continue; }
    out.push(inFence ? "" : l);
  }
  return out.join("\n");
}

/** 自己解析一遍标签：YAML 的 tags:（数组或逗号串）+ 正文里的 #标签。用来和 Obsidian 的缓存对账 */
function ownTagsOf(text) {
  const raw = String(text || "");
  const lines = raw.split("\n");
  const set = new Set();
  let bodyFrom = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      bodyFrom = end + 1;
      for (let i = 1; i < end; i++) {
        const m = /^tags?\s*:\s*(.*)$/i.exec(lines[i]);
        if (!m) continue;
        let v = m[1].trim();
        if (/^\[.*\]$/.test(v)) v = v.replace(/^\[|\]$/g, "");
        if (!v || /^[>|&]/.test(v)) continue;
        v.split(",").map((s) => s.trim().replace(/^#/, "").replace(/^["']|["']$/g, "")).filter(Boolean)
          .forEach((t) => set.add(t));
      }
    }
  }
  const clean = stripFences(lines.slice(bodyFrom).join("\n"));
  const re = /(^|[\s(（])#([^\s#|\]{}<>"'^.,;:!?，。；：！？]{1,40})/g;
  let m2;
  while ((m2 = re.exec(clean)) !== null) {
    if (/^\d/.test(m2[2])) continue;        // #2024 这类数字串不是标签
    set.add(m2[2]);
  }
  return Array.from(set);
}

/** 自己解析一遍出站链接：[[目标]] / [[目标|别名]] / [[目标#小节]] / [文字](相对.md) */
function ownLinksOf(text) {
  const clean = stripFences(text);
  const out = [];
  let m;
  const wl = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  while ((m = wl.exec(clean)) !== null) out.push(m[1].trim());
  const ml = /!?\[[^\]]*\]\(([^)\s]+\.md)(?:#[^)]*)?\)/gi;
  while ((m = ml.exec(clean)) !== null) out.push(m[1].trim());
  return out.filter(Boolean);
}

/** 链接目标 → 磁盘清单里的哪一个（Obsidian 按名字解析，这里同样按 basename 对齐） */
function linkTargetPath(target, pathByBase) {
  const t = String(target || "").replace(/\.(md|canvas)$/i, "").replace(/^\.\//, "");
  const base = t.indexOf("/") >= 0 ? t.slice(t.lastIndexOf("/") + 1) : t;
  return pathByBase.get(base) || pathByBase.get(t) || null;
}

function fmtStamp(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
  return fmtStamp(ts);
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function folderOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function dirName(path) {
  const parts = String(path || '').split('/');
  return parts[parts.length - 1] || String(path || '');
}

/** 粗略字数：中日韩按字计，拉丁按词计。 */
function countWords(text) {
  const cjk = text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g);
  const latin = text.match(/[A-Za-z0-9][A-Za-z0-9'\-_]*/g);
  return (cjk ? cjk.length : 0) + (latin ? latin.length : 0);
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 目录/路径类设置的规范化：留空、只有斜杠、前后斜杠 ⇒ 返回 ''（= 未指定 / 整库 / 自动推断）。
 *
 * 为什么不能直接拿 normalizePath 的结果判空 —— 真实 Obsidian 的实现（第二十七轮从
 * resources/obsidian.asar 里抠出来的原文）是：
 *     function uu(e){ return ""===(e=e.replace(/([\\/])+/g,"/").replace(/(^\/+|\/+$)/g,"")) && (e="/"), e }
 *     function cu(e){ return trim(uu(e)).normalize("NFC") }        // 导出名 normalizePath
 * 注意最后那个 `&&(e="/")`：**空串进去、"/" 出来**。
 * 于是 `if (normalizePath(setting))` 在"留空"时也成立，"留空 = 自动取模板夹 / 整库"
 * 这条 fallback 在真机上永远走不到 —— 模板列表恒空（用户截图「模板（/）」）、
 * 全盘扫描扫到 0 篇、新增模板落到库根。测试桩以前返回 ''，所以两套测试全绿也没抓到。
 */
function normDir(v) {
  const s = String(v === undefined || v === null ? '' : v)
    .replace(/[\\/]+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  return s === '/' ? '' : s;
}

/* ---------- 当日任务模板（第二十四轮） ---------- */

/** 模板里"把这里换成当天任务"的标记；生成的笔记带这个标记 ⇒ collectTasks 跳过它（副本不算任务） */
const KBWB_TASKS_MARK = '<!--KBWB:TASKS:';
/**
 * 生成物上的常驻指纹。不能用 KBWB:TASKS 本身 —— 标记会被任务填掉，填完就没了（实测）。
 * buildDailyContent 保证成品里一定有这一行，collectTasks 靠它认出"这是副本，别再算一遍"。
 */
const KBWB_GENERATED_MARK = '<!--KBWB:GENERATED-->';
/**
 * 内置兜底模板。和库里那份 `模板/每日任务模板.md` 是两份副本 ⇒ 必须同构，
 * 只在前面的模板链一份都没用到时才露面（用户③）。
 * [24] 拿真实库里那份对结构（四段 KBWB:TASKS 标记 + 二级标题序列 + 常驻指纹），不同就红。
 */
const KBWB_DEFAULT_DAILY_TASKS = [
  '---',
  'title: "{{date:YYYY-MM-DD}} 当日任务"',
  'created: "{{date:YYYY-MM-DD}}"',
  'type: daily-tasks',
  'tags:',
  '  - 每日笔记',
  '  - 任务',
  '---',
  '',
  '# {{date:YYYY-MM-DD}} {{weekday}} · 当日任务',
  '',
  '> 这页由「知识库工作台」按月历生成：点月历上的空白日期 → 确认标题 → 建。',
  '> 这里的勾只是**这一页自己的**进度，源笔记里的任务没被改动；行末 `—— [[出处]]` 点得回去。',
  '> 想让某条真正完成，去源笔记里勾。',
  '',
  '## 今天到期 📅',
  '',
  KBWB_TASKS_MARK + 'due-->',
  '',
  '## 已逾期（挑一条今天做掉）',
  '',
  KBWB_TASKS_MARK + 'overdue-->',
  '',
  '## 今天已经勾掉的',
  '',
  KBWB_TASKS_MARK + 'done-->',
  '',
  '## 没写 📅 的未完成任务（挑几条）',
  '',
  KBWB_TASKS_MARK + 'undated-->',
  '',
  '## 接下来',
  '',
  '- [ ] ',
  '',
  '## 备注',
  '',
  '- ',
  '',
  KBWB_GENERATED_MARK,
  '',
].join('\n');

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 「新增模板」建的空白模板长这样（占位符由 substituteTemplateTokens 在建档时换掉） */
const DEFAULT_TEMPLATE_SKELETON = [
  '---',
  'title: "{{title}}"',
  'created: "{{date:YYYY-MM-DD}}"',
  'tags: []',
  '---',
  '',
  '# {{title}}',
  '',
  '## 要点',
  '',
  '- ',
  '',
].join('\n');

/**
 * 当日任务模板的"结构"：四段 KBWB:TASKS 标记名 + 二级标题序列 + 有没有常驻指纹。
 * 内置那份（上面的 KBWB_DEFAULT_DAILY_TASKS）和库里 `模板/每日任务模板.md` 是两份副本，
 * 会各自被改；这个纯函数把"结构一致"变成可断言的东西（测试 [24] 直接读真实库那份来比）。
 * 故意不比正文措辞 —— 那部分用户爱怎么改就怎么改。
 */
function dailyTasksTemplateShape(text) {
  const s = String(text || '');
  const marks = [];
  const re = /<!--KBWB:TASKS:([A-Za-z]+)-->/g;
  let m;
  while ((m = re.exec(s))) marks.push(m[1]);
  const heads = s.split('\n')
    .filter((l) => /^##(?!#)\s*\S/.test(l))
    .map((l) => l.replace(/^\s*##\s*/, '').trim());
  return {
    marks: marks,
    heads: heads,
    generated: s.indexOf(KBWB_GENERATED_MARK) >= 0,
    tokens: (s.match(/\{\{[^}]*\}\}/g) || []).map((x) => x.replace(/\s+/g, '')).sort().join(','),
  };
}

/** 极简日期格式：只认 YYYY / MM / DD / HH / mm（够模板用了，不引 moment 的整套解析） */
function fmtDate(d, fmt) {
  return String(fmt || 'YYYY-MM-DD')
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()));
}

/**
 * 替换核心「模板」那几个占位符（{{date}} / {{date:FORMAT}} / {{title}} / {{time}}）。
 * 为什么插件要自己替：笔记是【我们】建的，核心 Templates 不会插手 ——
 * 不替的话建出来的笔记里写着字面的 "{{date:YYYY-MM-DD}}"（真机实测踩过）。
 */
function substituteTemplateTokens(text, ctx) {
  const d = (ctx && ctx.date) || new Date();
  const title = (ctx && ctx.title) || fmtDate(d, 'YYYY-MM-DD');
  let out = String(text || '');
  out = out.replace(/\{\{date:([^}]*)\}\}/g, (m, f) => fmtDate(d, String(f).trim() || 'YYYY-MM-DD'));
  out = out.replace(/\{\{date\}\}/g, fmtDate(d, 'YYYY-MM-DD'));
  out = out.replace(/\{\{time\}\}/g, fmtDate(d, 'HH:mm'));
  out = out.replace(/\{\{weekday\}\}/g, WEEKDAY_CN[d.getDay()]);
  out = out.replace(/\{\{title\}\}/g, title);
  return out;
}

/** 一条任务 → 模板里的一行（保留原正文与标记，末尾挂出处链接） */
function taskLineForTemplate(t) {
  const body = String((t && t.text) || '').trim() || '（空任务）';
  const box = t && t.done ? '- [x]' : '- [ ]';
  const src = (t && t.file && t.file.basename) || '';
  return box + ' ' + body + (src ? ' —— [[' + src + ']]' : '');
}

/**
 * 把 <!--KBWB:TASKS:xxx--> 换成当天那组任务。纯函数，测试直接喂假任务。
 *   due=今天到期 · overdue=逾期 · done=今天勾掉的 · undated=没写 📅 的未完成 · all=未完成全部
 * 空组给一行"- （没有）"，不留光秃秃的标题；模板里没标记就原样返回。
 */
function fillTaskMarkers(text, tasks, dateStr, limit) {
  const list = tasks || [];
  const cap = limit > 0 ? limit : 30;
  const groups = {
    due: list.filter((t) => !t.done && t.markers && t.markers.due === dateStr),
    overdue: list.filter((t) => !t.done && t.markers && t.markers.due && t.markers.due < dateStr),
    done: list.filter((t) => t.done && t.markers && (t.markers.done === dateStr || t.doneToday)),
    undated: list.filter((t) => !t.done && !(t.markers && t.markers.due)),
    all: list.filter((t) => !t.done),
  };
  return String(text || '').replace(/<!--KBWB:TASKS:(due|overdue|done|undated|all)-->/g, (m, key) => {
    const g = groups[key] || [];
    if (!g.length) return '- （没有）';
    const lines = g.slice(0, cap).map((t) => taskLineForTemplate(t));
    if (g.length > cap) lines.push('- …另有 ' + (g.length - cap) + ' 条没列进来（设置里可调「每组建任务上限」）');
    return lines.join('\n');
  });
}

/** 图标 + 文字兜底：万一该图标名不在当前版本的 Lucide 集里，按钮不会变成隐形空块 */
function setIconOr(el, icon, fallbackText) {
  setIcon(el, icon);
  if (!el.querySelector('svg')) {
    el.setText(fallbackText);
    el.addClass('is-text-icon');
  }
}

/** 稳定哈希：让「每日回顾」每天固定打散、当天刷新不变 */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function snippetOf(text, idx, len) {
  const from = Math.max(0, idx - 40);
  const to = Math.min(text.length, idx + len + 60);
  let s = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (from > 0) s = '…' + s;
  if (to < text.length) s = s + '…';
  return s;
}

/** 行首列表符号 + [ ] / [x]；不是任务行返回 null。 */
function parseTaskLine(line) {
  const m = line.match(/^(\s*)([-*+])[ \t]\[( |x|X|-)\][ \t]?(.*)$/);
  if (!m) return null;
  return { indent: m[1], bullet: m[2], state: m[3], body: m[4] };
}

const MARKERS = [
  { key: 'due', re: /📅[ \t]*(\d{4}-\d{2}-\d{2})/ },
  { key: 'scheduled', re: /⏳[ \t]*(\d{4}-\d{2}-\d{2})/ },
  { key: 'start', re: /🛫[ \t]*(\d{4}-\d{2}-\d{2})/ },
  { key: 'done', re: /✅[ \t]*(\d{4}-\d{2}-\d{2})/ },
  { key: 'created', re: /➕[ \t]*(\d{4}-\d{2}-\d{2})/ },
];

function parseMarkers(body) {
  const out = {};
  for (const m of MARKERS) {
    const hit = body.match(m.re);
    if (hit) out[m.key] = hit[1];
  }
  return out;
}

/** 展示用：剥掉日期标记，另给出小标签。 */
function prettyTask(body) {
  let text = body;
  const chips = [];
  for (const m of MARKERS) {
    const hit = text.match(m.re);
    if (hit) {
      text = text.replace(m.re, '');
      if (m.key === 'due') chips.push({ label: '截止 ' + hit[1], cls: 'due' });
      else if (m.key === 'done') chips.push({ label: '完成 ' + hit[1], cls: 'done' });
      else if (m.key === 'scheduled') chips.push({ label: '计划 ' + hit[1], cls: 'due' });
    }
  }
  text = text.replace(/\s{2,}/g, ' ').trim();
  return { text, chips };
}

/* ---------- 第三十二轮：待办清单（插件自维护，落两篇 markdown） ---------- */

/** ISO 周（周一起算）：'YYYY-Www'。用「本周四属于哪一年」定 ISO 年，跨年那一周不会串到隔壁年。 */
function isoWeekOf(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dow = (d.getUTCDay() + 6) % 7;          // 周一 = 0
  d.setUTCDate(d.getUTCDate() - dow + 3);       // 推到本周四
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jdow = (jan4.getUTCDay() + 6) % 7;
  const thu1 = Date.UTC(isoYear, 0, 4 - jdow + 3);   // 第一周的周四
  const week = Math.round((d.getTime() - thu1) / 604800000) + 1;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - dow);
  return { year: isoYear, week, key: isoYear + '-W' + pad(week), monday };
}

/** 'YYYY-Www' 的键（渲染层与测试都直接用它，别各处自己拼） */
function isoWeekKey(date) { return isoWeekOf(date).key; }

/** 周键加减 n 周；键不合法返回 '' */
function shiftWeekKey(key, n) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key || '').trim());
  if (!m) return '';
  const y = Number(m[1]);
  const w = Number(m[2]);
  if (!(w >= 1 && w <= 53)) return '';
  const jan4 = new Date(y, 0, 4);
  const monday = new Date(y, 0, 4 - ((jan4.getDay() + 6) % 7));
  monday.setDate(monday.getDate() + (w - 1 + Number(n || 0)) * 7);
  return isoWeekKey(monday);
}

/** 'YYYY-Www' → 'M月D日 ~ M月D日'（周日起算的界面说法是错的，这里固定周一 ~ 周日） */
function weekSpanText(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key || '').trim());
  if (!m) return '';
  const y = Number(m[1]);
  const jan4 = new Date(y, 0, 4);
  const mon = new Date(y, 0, 4 - ((jan4.getDay() + 6) % 7));
  mon.setDate(mon.getDate() + (Number(m[2]) - 1) * 7);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return (mon.getMonth() + 1) + '月' + mon.getDate() + '日 ~ ' + (sun.getMonth() + 1) + '月' + sun.getDate() + '日';
}

/** 待办的分组标题：'## 2026-11-05' / '## 2026-W45'（后面允许跟说明文字） */
const TODO_HEAD_RE = /^##\s+(\d{4}-\d{2}-\d{2}|\d{4}-W\d{2})\b/;

/**
 * 把一篇 markdown 切成 [{ key, headLine, items: [{ text, done, line }] }]。
 * 一个组从它的 '## 键' 开始，到下一个任何标题行（# / ## / ###）为止；
 * 组里只认 '- [ ]' / '- [x]' 这两种行，别的正文（说明、链接、空行）原样留着不管 ——
 * 用户可以在这两篇里随便写东西，插件只动它认得的那几行。
 */
function parseTodoSections(text) {
  const lines = String(text || '').split('\n');
  const sections = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const hm = /^(#{1,6})\s/.exec(lines[i]);
    if (hm) {
      const level = hm[1].length;
      if (level >= 3) continue;             // 三级以下的小标题不开新组、也不关组（组里的分组说明很常见）
      const m = level === 2 ? TODO_HEAD_RE.exec(lines[i]) : null;
      if (!m) { cur = null; continue; }     // 一级标题、或不是日期/周键的二级标题 → 这一段不再算待办
      cur = sections.find((s) => s.key === m[1]) || null;
      if (!cur) { cur = { key: m[1], headLine: i, items: [] }; sections.push(cur); }
      continue;
    }
    if (!cur) continue;
    const t = parseTaskLine(lines[i]);
    if (!t) continue;
    const body = String(t.body || '').trim();
    if (!body) continue;                    // 只有勾选框、没有正文的空行不算一条待办
    cur.items.push({ text: body, done: t.state !== ' ', line: i });
  }
  return sections;
}

function todoSectionFor(sections, key) {
  return (sections || []).find((s) => s.key === String(key || '')) || null;
}

/** 哪些天有【未完成】的待办（月历红点就靠这个；已完成的不标） */
function todoOpenKeys(sections) {
  const out = {};
  for (const s of (sections || [])) if (s.items.some((it) => !it.done)) out[s.key] = true;
  return out;
}

/** 每天有【几条】未完成待办（月历格子的 title 提示用；红点只看 todoOpenKeys 的布尔） */
function todoOpenCounts(sections) {
  const out = {};
  for (const s of (sections || [])) {
    let n = 0;
    for (const it of s.items) if (!it.done) n++;
    if (n) out[s.key] = n;
  }
  return out;
}

/** 往某个组里加一条：组不存在就建（排在最后一个组之后），存在就插到该组最后一条之后 */
function addTodoInSection(text, key, body) {
  const clean = String(body || '').replace(/\s+/g, ' ').trim();
  if (!clean || !key) return null;
  const base = String(text === undefined || text === null ? '' : text);
  const lines = base.split('\n');
  const sections = parseTodoSections(base);
  const sec = todoSectionFor(sections, key);
  const line = '- [ ] ' + clean;
  if (sec) {
    const at = sec.items.length ? sec.items[sec.items.length - 1].line : sec.headLine;
    lines.splice(at + 1, 0, line);
  } else {
    let insertAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^#{1,6}\s/.test(lines[i]) || /^\S/.test(lines[i])) { insertAt = i + 1; break; }
    }
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, '', '## ' + key, line);
  }
  return lines.join('\n');
}

/** 按行号翻勾选 / 删行：行号是 parseTodoSections 给的，写回时同一篇正文里再核一遍 */
function setTodoDoneAt(text, line, done) {
  const lines = String(text || '').split('\n');
  if (!(line >= 0 && line < lines.length)) return null;
  const parsed = parseTaskLine(lines[line]);
  if (!parsed) return null;
  lines[line] = parsed.indent + parsed.bullet + ' [' + (done ? 'x' : ' ') + '] ' + parsed.body;
  return lines.join('\n');
}

function dropTodoLine(text, line) {
  const lines = String(text || '').split('\n');
  if (!(line >= 0 && line < lines.length)) return null;
  if (!parseTaskLine(lines[line])) return null;
  lines.splice(line, 1);
  return lines.join('\n');
}

/**
 * 行号会漂：用户在 Obsidian 里手改这两篇（加一行、删一行、挪顺序）之后，
 * 卡上记着的 line 就不再指向那条待办。所以写回前先按「期望正文」复核一遍：
 *   ① 原行号上正好是那条 → 用它；
 *   ② 找不到就在全篇里找同文的待办，取离原行号最近的那一条；
 *   ③ 还没有 → 返回 -1，调用方什么都不改（宁可不动，绝不改错行）。
 */
function findTodoLine(text, line, expectText) {
  const want = String(expectText || '').replace(/\s+/g, ' ').trim();
  if (!want) return -1;
  const lines = String(text || '').split('\n');
  const same = (i) => {
    const t = parseTaskLine(lines[i]);
    return !!t && String(t.body || '').replace(/\s+/g, ' ').trim() === want;
  };
  if (line >= 0 && line < lines.length && same(line)) return line;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (!same(i)) continue;
    const d = Math.abs(i - Number(line || 0));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/* ================================================================ 视图 */

class WorkbenchView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.searchSeq = 0;
    this.searchText = '';
    this.taskFilter = plugin.settings.taskFilter || 'open';
    this.expanded = new Set();
    this.rendering = false;
    this.pendingRender = false;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '知识库工作台'; }
  getIcon() { return 'layout-dashboard'; }

  async onOpen() {
    this.containerEl.addClass('kbwb');
    this.contentEl.empty();
    // 光斑跟随：只改一张卡的两个 CSS 变量，rAF 节流
    this.registerDomEvent(this.contentEl, 'pointermove', (ev) => this.spotMove(ev));
    this.registerDomEvent(this.contentEl, 'pointerleave', () => this.spotLeave());
    this.applyMinSize();
    await this.render();
  }

  spotLeave() {
    if (this.spotCard && this.spotCard.isConnected) this.spotCard.removeClass('is-spot');
    this.spotCard = null;
  }

  /* ---------- 面板最小尺寸 ----------
     侧栏分割线可以一路拖到很窄，整个工作台被挤到不可用（卡片挤成一坨、标题截断）。
     用 min-width / min-height 兜底：min-* 优先于 Obsidian 分割器写的内联 width，
     所以拖到地板就拖不动了，不需要监听分割线。
     宽度目标：在侧栏里 = 那一条侧栏（.workspace-split.mod-left/right-split），
               在主区域 = 自己这片叶子（.workspace-leaf，flex 子项认 min-width）。
     高度目标：始终是这片叶子（上下分屏时才有效）。 */

  /**
   * containerEl 往上若干层的祖先链（给人看的），用来判断"到底哪一层才是分割器在改的元素"。
   * 以前只把 min-* 加在我们猜的那一层，猜错就静默无效，还得让用户去翻 DevTools —— 不该这样。
   */
  paneChainInfo(maxUp) {
    const out = [];
    let n = this.containerEl;
    let i = 0;
    const lim = maxUp || 7;
    while (n && i < lim) {
      const cls = (typeof n.className === 'string' ? n.className : '')
        .split(/\s+/).filter(Boolean).filter((c) => c.indexOf('mod-') === 0 || c.indexOf('workspace') === 0 || c.indexOf('view') === 0).slice(0, 3);
      let r = null;
      try { r = typeof n.getBoundingClientRect === 'function' ? n.getBoundingClientRect() : null; } catch (e) { r = null; }
      out.push({
        depth: i,
        label: (n.tagName || '?').toLowerCase() + (cls.length ? '.' + cls.join('.') : ''),
        w: r ? Math.round(r.width) : 0,
        h: r ? Math.round(r.height) : 0,
      });
      n = n.parentElement;
      i++;
    }
    return out;
  }

  /**
   * 限制目标（可能不止一层）。
   *
   * 高度方向真机压不住（用户 2026-11-04：「主区域的上下没有一个最小限制」）。
   * 之前是【猜一层】：第十八轮先猜 .workspace-leaf，再猜 .workspace-split 的直接子元素。
   * 猜错就静默无效 —— 改成把链上【只属于这个面板】的几层一起压上，不再靠猜：
   *   高度：split 的直接子元素（分割器真正在改的那个）+ .workspace-tabs + .workspace-leaf
   *   宽度：整条侧栏 + 同上
   * 硬边界：绝不压 .workspace-split 本身 —— 那会把同一分屏里的另一个面板一起卡住；
   * 所以"直接子元素"如果本身就是个 split（嵌套分屏），跳过它。
   */
  minTargetsFor(axis) {
    const c = this.containerEl;
    if (!c || typeof c.closest !== 'function') return [];
    const isSplit = (el) => !!el && typeof el.className === 'string' &&
      /(^|\s)workspace-split(\s|$)/.test(el.className);
    const pick = this.plugin.settings.minPaneTarget || 'auto';
    const one = {
      self: () => c,
      leaf: () => c.closest('.workspace-leaf'),
      tabs: () => c.closest('.workspace-tabs'),
      dock: () => c.closest('.workspace-split.mod-left-split, .workspace-split.mod-right-split'),
      split: () => c.closest('.workspace-split'),
    };
    if (one[pick]) { const e = one[pick](); return e ? [e] : []; }

    const dock = c.closest('.workspace-split.mod-left-split, .workspace-split.mod-right-split');
    const leaf = c.closest('.workspace-leaf');
    const tabs = c.closest('.workspace-tabs');
    const split = c.closest('.workspace-split');
    let child = null;
    if (split) {
      let n = c;
      let guard = 0;
      while (n && n.parentElement && n.parentElement !== split && guard++ < 12) n = n.parentElement;
      if (n && n.parentElement === split && !isSplit(n)) child = n;
    }
    const out = [];
    const push = (e) => { if (e && out.indexOf(e) < 0 && !isSplit(e)) out.push(e); };
    if (axis === 'height') { push(child); push(tabs); push(leaf); if (!out.length) push(c); }
    else { push(dock); push(child); push(tabs); push(leaf); if (!out.length) push(c); }
    return out;
  }

  /** 兼容旧调用点：返回链上的第一层 */
  minTargetFor(axis) {
    const l = this.minTargetsFor(axis);
    return l.length ? l[0] : null;
  }

  paneMinTargets() {
    const w = this.minTargetsFor('width');
    const h = this.minTargetsFor('height');
    return { w: w[0] || null, h: h[0] || null, wList: w, hList: h };
  }

  /** 给链上每一层都写上 min-*；设 0 是移除属性而不是塞 0px */
  applyMinSize() {
    const t = this.paneMinTargets();
    const w = clampInt(this.plugin.settings.minPaneWidth, 0, 2000, 300);
    const h = clampInt(this.plugin.settings.minPaneHeight, 0, 2000, 220);
    this._minWEls = [];
    this._minHEls = [];
    for (const el of (t.wList || [])) {
      if (!el || !el.style || typeof el.style.setProperty !== 'function') continue;
      if (w > 0) { el.style.setProperty('min-width', w + 'px'); this._minWEls.push(el); }
      else el.style.removeProperty('min-width');
    }
    for (const el of (t.hList || [])) {
      if (!el || !el.style || typeof el.style.setProperty !== 'function') continue;
      if (h > 0) { el.style.setProperty('min-height', h + 'px'); this._minHEls.push(el); }
      else el.style.removeProperty('min-height');
    }
    this._minWEl = this._minWEls[0] || null;
    this._minHEl = this._minHEls[0] || null;
    this.watchPaneMin();
  }

  /**
   * 第二层保险（真机反馈：主区域上下方向 CSS 的 min-* 压不住）。
   * 实测尺寸低于地板时，直接把内联 height/width 钉回地板。
   * 钉的是"我们已经在管的那几层"，不新增目标，免得又猜错元素。
   */
  enforcePaneMin() {
    const h = clampInt(this.plugin.settings.minPaneHeight, 0, 2000, 220);
    const w = clampInt(this.plugin.settings.minPaneWidth, 0, 2000, 300);
    const els = [];
    for (const el of [].concat(this._minWEls || [], this._minHEls || [])) {
      if (el && els.indexOf(el) < 0) els.push(el);
    }
    if (!this._pinned) this._pinned = [];
    const want = [];
    for (const el of els) {
      if (!el || !el.style || typeof el.getBoundingClientRect !== 'function') continue;
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
      if (!r) continue;
      if (h > 0 && r.height > 0 && r.height < h - 1) want.push({ el, prop: 'height', px: h + 'px' });
      if (w > 0 && r.width > 0 && r.width < w - 1) want.push({ el, prop: 'width', px: w + 'px' });
    }
    // 已经高于地板的那些：松开，把我们钉的内联尺寸还原成接手前的值
    // —— 否则用户后来把面板拉大了，我们那一次"救场"的 height 会永远赖在人家身上。
    for (const p of this._pinned.slice()) {
      if (want.some((x) => x.el === p.el && x.prop === p.prop)) continue;
      if (p.prev) p.el.style.setProperty(p.prop, p.prev);
      else if (typeof p.el.style.removeProperty === 'function') p.el.style.removeProperty(p.prop);
      this._pinned.splice(this._pinned.indexOf(p), 1);
    }
    for (const x of want) {
      const cur = typeof x.el.style.getPropertyValue === 'function' ? x.el.style.getPropertyValue(x.prop) : '';
      if (cur === x.px) continue;                                   // 已经钉着，别重复写
      const rec = this._pinned.find((p) => p.el === x.el && p.prop === x.prop);
      if (rec) rec.value = x.px;                                    // prev 保持最初那一份
      else this._pinned.push({ el: x.el, prop: x.prop, prev: cur, value: x.px });
      x.el.style.setProperty(x.prop, x.px);
    }
    return this._pinned.length;
  }

  /** 尺寸一变就复查地板（分割器拖拽会连续触发）；没有 ResizeObserver 就只查一次 */
  watchPaneMin() {
    if (this._minRo) {
      try { this._minRo.disconnect(); } catch (e) { /* 忽略 */ }
      this._minRo = null;
    }
    if (typeof ResizeObserver !== 'function') { this.enforcePaneMin(); return; }
    const els = [];
    for (const el of [].concat(this._minWEls || [], this._minHEls || [])) {
      if (el && els.indexOf(el) < 0 && typeof el.nodeType !== 'undefined') els.push(el);
    }
    if (!els.length) { this.enforcePaneMin(); return; }
    const queue = () => {
      if (this._minRaf) return;                     // 一帧最多查一次
      this._minRaf = requestAnimationFrame(() => { this._minRaf = 0; this.enforcePaneMin(); });
    };
    try {
      const ro = new ResizeObserver(queue);
      for (const el of els) ro.observe(el);
      this._minRo = ro;
    } catch (e) { this._minRo = null; }
    this.enforcePaneMin();
  }

  /** 关掉工作台就把写过的 min-* 与被钉住的宽高全撤掉，别把侧栏/分屏永久卡在某尺寸上 */
  clearMinSize() {
    if (this._minRo) {
      try { this._minRo.disconnect(); } catch (e) { /* 忽略 */ }
      this._minRo = null;
    }
    // 先还原被我们钉住过的内联尺寸（Obsidian 的分割器也在写这两个属性）
    for (const p of (this._pinned || [])) {
      if (!p || !p.el || !p.el.style) continue;
      if (p.prev) p.el.style.setProperty(p.prop, p.prev);
      else if (typeof p.el.style.removeProperty === 'function') p.el.style.removeProperty(p.prop);
    }
    this._pinned = [];
    const all = [];
    for (const el of [].concat(this._minWEls || [], this._minHEls || [], [this._minWEl, this._minHEl])) {
      if (el && all.indexOf(el) < 0) all.push(el);
    }
    for (const el of all) {
      if (!el || !el.style || typeof el.style.removeProperty !== 'function') continue;
      el.style.removeProperty('min-width');
      el.style.removeProperty('min-height');
    }
    this._minWEls = [];
    this._minHEls = [];
    this._minWEl = null;
    this._minHEl = null;
  }

  spotMove(ev) {
    if (!this.plugin.settings.hoverFx) return;
    // 手势期间必须停：这个回调每帧读一次 getBoundingClientRect（强制同步布局），
    // 正拖着卡时它就是把帧率拖下去的那笔额外开销
    if (this.gesture || this.spotRaf) return;
    const t = ev.target;
    const card = t && t.closest ? t.closest('.kbwb-card') : null;
    if (!card) return;
    const x = ev.clientX, y = ev.clientY;
    this.spotRaf = requestAnimationFrame(() => {
      this.spotRaf = 0;
      if (!card.isConnected) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (x - r.left) + 'px');
      card.style.setProperty('--my', (y - r.top) + 'px');
      if (this.spotCard !== card) {
        if (this.spotCard && this.spotCard.isConnected) this.spotCard.removeClass('is-spot');
        card.addClass('is-spot');
        this.spotCard = card;
      }
    });
  }

  onClose() {
    // 关标签时若有未完成手势，把 document / 手柄上的监听摘干净，避免泄漏
    if (this.gesture) {
      this.detachGesture();
      this.gesture = null;
      if (this.ghost && this.ghost.parentNode) this.ghost.parentNode.removeChild(this.ghost);
      this.ghost = null;
    }
    this.clearNudges();
    this.clearMinSize();          // 别把侧栏永久卡在某个 min-width 上
    this.contentEl.empty();
    return Promise.resolve();
  }

  /* ---------------------------------------------- 渲染主流程 */

  async render() {
    if (this.rendering) { this.pendingRender = true; return; }
    // 拖动/缩放进行中不重建 DOM：否则正在拖的元素会被换掉，松手时写回旧坐标（"回到原位"的成因）
    if (this.gesture) { this.pendingRender = true; return; }
    this.rendering = true;
    const keepFocus = !!this.inputEl && document.activeElement === this.inputEl;
    const host = this.contentEl;
    const scrollTop = host.scrollTop;

    try {
      do {
        this.pendingRender = false;
        // 手势可能在上一轮构建的 await 期间开始：此时不能换掉容器内容，
        // 否则正在拖的节点被销毁，松手就"回到原位"
        if (this.gesture) { this.pendingRender = true; break; }
        // 设置里改了最小宽/高，或视图被搬到别处（onOpen 之外也要跟一次）：幂等，很便宜
        this.applyMinSize();
        // 入场动效只在第一次渲染播放，之后的自动刷新不再闪
        if (this.hasRendered) host.removeClass('kbwb-animate');
        else { host.addClass('kbwb-animate'); this.hasRendered = true; }
        host.toggleClass('kbwb-no-fx', !this.plugin.settings.hoverFx);
        this.cardIndex = 0;
        this.inputEl = null;
        // 侧栏窄到一定程度时，横向自由摆放没有意义：显示层退化成单列
        const paneW = (this.contentEl.clientWidth || (window.innerWidth || 900));
        this.narrowPane = paneW < 420;
        this.stackRow = 1;
        this.plugin.applyFonts(this.containerEl);
        // 关键：先建到游离容器里，最后一次同步换入。
        // 直接 host.empty() 会让滚动高度瞬间塌成 0 → 浏览器把 scrollTop 夹到顶，
        // 构建又要 await 若干次读盘 → 用户看到"闪一下回到最上面"
        // （点收藏/置顶、勾任务、60s 自动刷新全中招）。
        const stage = document.createElement('div');
        // 记下每张卡自己的滚动位置，换入后原样还回去。
        // 只还原面板 scrollTop 不够：长列表（任务/搜索/目录）滚在卡体自己身上，
        // 整版重建会把它们全部归零 —— 用户看到的"勾完任务跳回列表最上面"就是这个。
        const keepCardScroll = this.cardScrollMap();
        this._tasksShared = null;   // 本轮渲染重新扫，任务卡与到期日历共用这一份结果
        this.plugin._todosShared = null;   // 待办同理：月历红点与待办卡共用一份
        this.buildHeader(stage);
        const grid = stage.createDiv({ cls: 'kbwb-grid' });
        let layout = this.plugin.layoutList();
        // 窄栏是"按 DOM 顺序堆叠"的：把用户摆的行号翻译成 DOM 顺序，
        // 否则在左侧栏里拖动换序完全看不出来（看起来像"拖了没反应"）
        if (this.narrowPane) {
          layout = layout.slice().sort((a, b) => (a.row - b.row) || (a.col - b.col));
        }
        for (const slot of layout) {
          if (!slot.on) continue;
          if (slot.collapsed) { this.buildCollapsedCard(grid, slot); continue; }
          const fn = BUILDERS[slot.id];
          if (!fn || typeof this[fn] !== 'function') continue;
          await this[fn](grid);
        }
        this.buildHiddenBar(grid);
        // —— 换入：同一个同步块内摘旧插新，中间不触发绘制，滚动位置不动 ——
        host.empty();
        for (const k of Array.prototype.slice.call(stage.children || [])) host.appendChild(k);
        this.restoreCardScroll(keepCardScroll);
      } while (this.pendingRender);
    } catch (err) {
      console.error('[kb-workbench] 渲染失败', err);
      host.createDiv({ cls: 'kbwb-error', text: '工作台渲染失败：' + (err && err.message ? err.message : err) });
    } finally {
      this.rendering = false;
    }

    if (this.inputEl) {
      this.inputEl.value = this.searchText;
      if (keepFocus) {
        this.inputEl.focus();
        const n = this.inputEl.value.length;
        try { this.inputEl.setSelectionRange(n, n); } catch (e) { /* ignore */ }
      }
    }

    if (this.jumpToSearch) {
      // 点标签转搜索时不要还原滚动，否则看起来像"跳过去又弹回来"
      this.jumpToSearch = false;
      if (this.searchCardEl && typeof this.searchCardEl.scrollIntoView === 'function') {
        try { this.searchCardEl.scrollIntoView({ block: 'start', behavior: 'auto' }); }
        catch (e) { host.scrollTop = 0; }
      } else {
        host.scrollTop = 0;
      }
      if (this.inputEl) {
        this.inputEl.focus();
        const n = this.inputEl.value.length;
        try { this.inputEl.setSelectionRange(n, n); } catch (e) { /* ignore */ }
      }
    } else if (scrollTop) {
      host.scrollTop = scrollTop;
    }
  }

  /* ---------------------------------------------- 顶部条 */

  buildHeader(host) {
    const bar = host.createDiv({ cls: 'kbwb-bar' });
    const id = bar.createDiv({ cls: 'kbwb-bar-id' });
    id.createSpan({ cls: 'kbwb-bar-dot' });
    const textWrap = id.createDiv({ cls: 'kbwb-bar-text' });
    textWrap.createDiv({ cls: 'kbwb-bar-kicker', text: 'KNOWLEDGE · WORKBENCH' });
    textWrap.createDiv({ cls: 'kbwb-bar-title', text: '知识库工作台' });
    let weekday = '';
    try { weekday = ' ' + moment().format('dddd'); } catch (e) { weekday = ''; }
    const meta = textWrap.createDiv({ cls: 'kbwb-bar-date' });
    meta.createSpan({ text: moment().format('YYYY年MM月DD日') + weekday });
    const st = this.plugin.statsCache;
    if (st) {
      meta.createSpan({ cls: 'kbwb-bar-sep', text: '/' });
      meta.createSpan({ cls: 'kbwb-bar-num', text: String(st.md) + ' 篇' });
      meta.createSpan({ cls: 'kbwb-bar-sep', text: '/' });
      this.barTodoEl = meta.createSpan({ cls: 'kbwb-bar-num', text: String(this.plugin.lastTaskCount || 0) + ' 待办' });
    }
    const right = bar.createDiv({ cls: 'kbwb-bar-right' });

    const mk = (icon, title, fn) => {
      const b = right.createEl('button', { cls: 'kbwb-iconbtn', attr: { title: title } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
      return b;
    };
    mk('refresh-cw', '重新扫描并刷新', (ev) => {
      const btn = ev && ev.currentTarget;
      if (btn) {
        btn.addClass('is-busy');
        window.setTimeout(() => { if (btn.isConnected) btn.removeClass('is-busy'); }, 850);
      }
      this.plugin.refreshViews(true);
    });
    mk('sliders-horizontal', '插件设置', () => this.plugin.openSettings());
    mk('layout-grid', '自动排列（消除重叠，保留各自尺寸）', () => {
      const narrow = (this.contentEl.clientWidth || window.innerWidth || 900) < 420;
      this.plugin.tidyLayout(narrow);
      this.plugin.refreshViews(false);
    });
    mk('x', '关闭工作台', () => this.app.workspace.detachLeavesOfType(VIEW_TYPE));
  }

  /* ---------------------------------------------- 卡片壳 */

  card(grid, modId, chipText) {
    const mod = MODULES.find((m) => m.id === modId) || { id: modId, title: modId, icon: 'square', dw: 16, dh: 30 };
    const slot = this.plugin.slotOf(modId);
    const el = grid.createDiv({ cls: 'kbwb-card' });
    el.dataset.mod = modId;
    if (this.narrowPane) {
      // 侧栏太窄时 12 列没意义：按顺序单列堆叠（只影响显示，不改用户存的坐标）
      el.style.gridColumn = '1 / span ' + GRID_COLS;
      el.style.gridRow = this.stackRow + ' / span ' + slot.h;
      this.stackRow += slot.h + 2;
    } else {
      el.style.gridColumn = slot.col + ' / span ' + slot.w;
      el.style.gridRow = slot.row + ' / span ' + slot.h;
    }
    this.cardIndex = (this.cardIndex || 0) + 1;
    el.style.setProperty('--i', String(this.cardIndex));
    if (modId === 'search') this.searchCardEl = el;
    const head = el.createDiv({ cls: 'kbwb-card-head' });
    const titleEl = head.createDiv({ cls: 'kbwb-card-title' });
    const ico = titleEl.createSpan({ cls: 'kbwb-card-icon' });
    setIcon(ico, mod.icon);
    titleEl.createSpan({ cls: 'kbwb-card-name', text: mod.title });
    const chip = titleEl.createSpan({ cls: 'kbwb-chip', text: chipText || '' });
    if (!chipText) chip.hide();
    const actions = head.createDiv({ cls: 'kbwb-card-actions' });
    const ctrl = head.createDiv({ cls: 'kbwb-card-ctrl' });
    const moreBtn = ctrl.createSpan({ cls: 'kbwb-ctrl-btn', attr: { title: '尺寸 / 折叠 / 隐藏' } });
    setIconOr(moreBtn, 'more-horizontal', '⋯');
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openCardMenu(moreBtn, modId);
    });
    const body = el.createDiv({ cls: 'kbwb-card-body' });
    this.buildCardControls(el, modId, slot);   // 顶部抓手 + 三条缩放手柄
    return {
      el, head, titleEl, actions, body, chip, modId, slot,
      setChip: (t) => { if (t) { chip.setText(t); chip.show(); } else { chip.hide(); } },
    };
  }

  /* ---------------------------------------------- 卡片控制：顶部抓手 / 边缘缩放 / ⋯ 菜单 */

  buildCardControls(el, modId, slot) {
    // 【第二十一轮：居中小抓手整个去掉了】用户："不需要小抓手"。
    // 它本来就是"怕用户不知道能拖"而加的显式把手，实测反而一路在压字：
    // 窄栏压页签（第九轮）、w=780 压 4 字标题（第二十轮）、w=1200 压长 chip。
    // 整条卡片头都能拖（下面 head 那条绑定），这才是用户本来就会做的动作。
    const head = el.find ? el.find('.kbwb-card-head') : null;
    if (head) this.beginBind(head, 'move', el, modId, slot, undefined, true);

    // 三条边 + 一个角：右=宽，下=高，右下角=同时
    const rx = el.createDiv({ cls: 'kbwb-edge kbwb-edge-r', attr: { title: '左右拖：改宽度' } });
    this.beginBind(rx, 'resize', el, modId, slot, 'x');
    const ry = el.createDiv({ cls: 'kbwb-edge kbwb-edge-b', attr: { title: '上下拖：改高度' } });
    this.beginBind(ry, 'resize', el, modId, slot, 'y');
    const rc = el.createDiv({ cls: 'kbwb-edge kbwb-edge-corner', attr: { title: '拖角：同时改宽高' } });
    this.beginBind(rc, 'resize', el, modId, slot, 'xy');
  }

  beginBind(handle, kind, el, modId, slot, dir, skipInteractive) {
    handle.addEventListener('pointerdown', (ev) => {
      // 拖标题栏时别把页签 / ⋯ 菜单 / 按钮 / 输入框的点击吃掉
      if (skipInteractive) {
        const t = ev.target;
        if (t && typeof t.closest === 'function' &&
          t.closest('.kbwb-tab, .kbwb-ctrl-btn, .kbwb-card-actions, .kbwb-restore, .kbwb-input, button')) return;
      }
      this.beginGesture(kind, ev, el, modId, slot, dir, handle);
    });
  }

  /* ---------- 统一手势 ----------
     move：整场只写 transform（卡片 + 落点虚影），网格坐标一个字节都不碰 → 零重排；
     resize：只改被拖那张的跨度，且只在吸附到下一档时写一次；
     两者都按 rAF 批处理 —— 鼠标 125–1000Hz，逐事件写样式本身就是卡顿来源。 */

  beginGesture(kind, ev, el, modId, slot, dir, handle) {
    if (this.gesture) return;                    // 一次只允许一个手势
    if (ev.button !== undefined && ev.button !== 0) return;
    const grid = el.parentNode;
    if (!grid) return;
    ev.preventDefault();
    ev.stopPropagation();

    const gr = grid.getBoundingClientRect();
    // 起点坐标一律现读，不用 beginBind 闭包里那份 slot：
    // 那是上一次渲染时的坐标。松手后若只写回 DOM 不重建（不闪的必要条件），
    // 闭包值就停留在旧位置，下一次拖动会从旧位置起算 —— 用户看到的"回到原位"。
    const cur = this.plugin.slotOf(modId) || slot;
    const sc = this.scrollerEl();
    const g = {
      kind, dir: dir || 'xy', el, modId, grid, handle: handle || null, pointerId: ev.pointerId,
      startX: ev.clientX, startY: ev.clientY, lastX: ev.clientX, lastY: ev.clientY,
      // 滚动补偿：卡片是"内容坐标"里的东西，指针是"视口坐标"里的东西。
      // 拖动途中滚轮一滚，只按指针算位移的话卡片会跟着内容滚走、离开光标，
      // 落点行号也会算错 —— 所以位移要加上手势期间产生的滚动量。
      scrollEl: sc,
      scroll0: sc.scrollTop || 0, scroll1: sc.scrollTop || 0,
      scrollL0: sc.scrollLeft || 0, scrollL1: sc.scrollLeft || 0,
      col: cur.col, row: cur.row, w: cur.w, h: cur.h,
      colW: Math.max(10, (gr.width || 1) / GRID_COLS),
      tCol: cur.col, tRow: cur.row, curW: cur.w, curH: cur.h,
      changed: false, frame: null,
    };
    this.gesture = g;
    // 光斑跟随每帧要读一次 getBoundingClientRect（强制同步布局），手势期间先撤掉
    if (this.spotRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.spotRaf);
    this.spotRaf = 0;
    if (this.spotCard && this.spotCard.isConnected) this.spotCard.removeClass('is-spot');
    this.spotCard = null;

    el.addClass(kind === 'move' ? 'is-dragging' : 'is-resizing');
    this.contentEl.addClass('kbwb-grabbing');
    this.contentEl.addClass('kbwb-grabbing-' + (kind === 'move' ? 'move' : (dir || 'xy')));
    if (kind === 'move' && !this.narrowPane) {
      // 虚影是网格的绝对定位子项（不进网格流）：换落点时不重排任何卡
      this.ghost = grid.createDiv({ cls: 'kbwb-ghost' });
      this.sizeGhost();
      this.placeGhost();
    }
    // 指针捕获：松手时指针哪怕已经滑出窗口/滑到别的元素上，pointerup 也一定回到这里。
    // 少了它，一次"在窗口外松手"就会让手势永远不结束，之后每次拖动都像回到原位。
    if (handle && typeof handle.setPointerCapture === 'function' && ev.pointerId !== undefined) {
      try { handle.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
    }
    this._ptrMove = (e2) => this.onGestureMove(e2);
    this._ptrUp = () => this.onGestureEnd();
    this._ptrLost = () => this.onGestureEnd();
    // 滚动只记账，不读 rect：滚轮事件里读布局会把这次拖动重新拖回"每帧强制同步布局"
    this._scrollH = () => {
      const gg = this.gesture;
      if (!gg || !gg.scrollEl) return;
      gg.scroll1 = gg.scrollEl.scrollTop || 0;
      gg.scrollL1 = gg.scrollEl.scrollLeft || 0;
      this.scheduleGestureFrame();
    };
    document.addEventListener('pointermove', this._ptrMove);
    document.addEventListener('pointerup', this._ptrUp);
    document.addEventListener('pointercancel', this._ptrUp);
    if (typeof sc.addEventListener === 'function') sc.addEventListener('scroll', this._scrollH, { passive: true });
    if (handle && typeof handle.addEventListener === 'function') {
      handle.addEventListener('lostpointercapture', this._ptrLost);
    }
  }

  /**
   * 真正的滚动容器：contentEl 滚不动就往上找。
   * Obsidian 的主题/侧栏有时把 overflow 放在祖先上，只盯 contentEl 会
   * 让滚动补偿静默失效（滚了但卡片不动 —— 就是用户报的那个现象）。
   */
  scrollerEl() {
    const cands = [this.contentEl];
    let el = this.contentEl;
    while (el && el.parentElement) { el = el.parentElement; cands.push(el); }
    for (const c of cands) {
      if (c && c.scrollHeight > c.clientHeight + 1) return c;
    }
    return this.contentEl;
  }

  scheduleGestureFrame() {
    const g = this.gesture;
    if (!g || g.frame) return;                     // 已经排进本帧，坐标稍后统一取最新
    g.frame = { on: true };
    const run = () => {
      if (!g.frame) return;
      g.frame = null;
      this.applyGestureFrame();
    };
    if (typeof requestAnimationFrame === 'function') g.rafId = requestAnimationFrame(run);
    else run();
  }

  onGestureMove(ev) {
    const g = this.gesture;
    if (!g) return;
    if (typeof ev.clientX === 'number') { g.lastX = ev.clientX; g.lastY = ev.clientY; }
    this.scheduleGestureFrame();
  }

  /** 按 data-mod 找回当前挂在网格里的同名卡（整页重建后节点是新的） */
  dragElFor(modId) {
    const grid = this.contentEl.find ? this.contentEl.find('.kbwb-grid') : null;
    if (!grid) return null;
    for (const c of Array.prototype.slice.call(grid.children || [])) {
      if (c.dataset && c.dataset.mod === modId) return c;
    }
    return null;
  }

  applyGestureFrame() {
    const g = this.gesture;
    if (!g) return;
    if (!g.el.isConnected) {
      // 拖动中途整页重建（库事件 / 60s 自动刷新）：正在拖的节点被换掉了。
      // 不重新认领，这次拖动就悄悄什么都没发生 —— 用户看到的正是"回到原位"。
      const next = this.dragElFor(g.modId);
      if (!next) return;
      g.el = next;
      g.grid = next.parentNode || g.grid;
      next.addClass(g.kind === 'move' ? 'is-dragging' : 'is-resizing');
      if (g.kind === 'move' && !this.narrowPane && !this.ghost) {
        this.ghost = g.grid.createDiv({ cls: 'kbwb-ghost' });
        this.sizeGhost();
      }
      if (this.ghost) this.placeGhost();
    }
    const dx = (g.lastX - g.startX) + (g.scrollL1 - g.scrollL0);
    const dy = (g.lastY - g.startY) + (g.scroll1 - g.scroll0);

    if (g.kind === 'move') {
      // 关键：过程只动 transform（整数 px），不碰 grid-column/grid-row → 不触发重排
      g.el.style.transform = 'translate(' + Math.round(dx) + 'px, ' + Math.round(dy) + 'px)';
      const c = Math.max(1, Math.min(GRID_COLS - g.w + 1, g.col + Math.round(dx / g.colW)));
      const r = Math.max(1, g.row + Math.round(dy / ROW_UNIT));
      if (c !== g.tCol || r !== g.tRow) {
        g.tCol = c; g.tRow = r; g.changed = true;
        this.placeGhost();
        this.updateNudges();          // 落点变了才重算让位预演（纯数学 + 几个绝对定位框）
      }
      return;
    }

    let w = g.curW, h = g.curH;
    if (g.dir === 'x' || g.dir === 'xy') {
      w = Math.max(MIN_W, Math.min(GRID_COLS - g.col + 1, g.w + Math.round(dx / g.colW)));
    }
    if (g.dir === 'y' || g.dir === 'xy') {
      h = Math.max(MIN_H, g.h + Math.round(dy / ROW_UNIT));
    }
    if (w === g.curW && h === g.curH) return;
    g.curW = w; g.curH = h; g.changed = true;
    // 缩放要看到真实尺寸，只能改跨度；每吸附一档才写一次，卡片自身有 inline-size 隔离
    g.el.style.gridColumn = g.col + ' / span ' + w;
    g.el.style.gridRow = g.row + ' / span ' + h;
    this.updateNudges();              // 尺寸变一档 → 谁会被压小，当场画出来
  }

  /** 虚影大小整场不变（拖动不改尺寸），所以只写一次 */
  sizeGhost() {
    const g = this.gesture;
    if (!this.ghost) return;
    this.ghost.style.width = Math.max(8, Math.round(g.w * g.colW - 10)) + 'px';
    this.ghost.style.height = Math.max(8, Math.round(g.h * ROW_UNIT - 10)) + 'px';
  }

  /** 落点虚影：绝对定位 + transform，不进网格流 → 换落点不引起任何重排 */
  placeGhost() {
    const g = this.gesture;
    if (!g || !this.ghost) return;
    const x = (g.tCol - 1) * g.colW + 5;
    const y = (g.tRow - 1) * ROW_UNIT + 5;
    this.ghost.style.transform = 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)';
  }

  /**
   * 手势途中的"让位预演"：会压住谁、谁会被压成多大，实时用虚线框画出来。
   * 框是网格的绝对定位子项（和落点虚影一样），只写 transform/宽高 → 零重排。
   * 拖动算新落点，缩放算新尺寸（位置不动）—— 用户报的"缩放时别人不让位"，
   * 先得让他看见谁会让位。
   */
  updateNudges() {
    const g = this.gesture;
    if (!g || this.narrowPane) return;
    if (g.kind !== 'move' && g.kind !== 'resize') return;
    const grid = g.el.parentNode || g.grid;
    if (!grid) return;
    if (!this.nudgeEls) this.nudgeEls = [];
    const box = g.kind === 'move'
      ? { col: g.tCol, row: g.tRow }
      : { col: g.col, row: g.row, w: g.curW, h: g.curH };
    const preview = resolveCopyPreview(this.plugin.layoutList(), g.modId, box);
    const pool = this.nudgeEls;
    for (let i = 0; i < preview.length; i++) {
      let el = pool[i];
      if (!el) { el = grid.createDiv({ cls: 'kbwb-nudge' }); pool[i] = el; }
      const p = preview[i];
      el.dataset.for = p.id;
      el.style.width = Math.max(8, Math.round(p.w * g.colW - 10)) + 'px';
      el.style.height = Math.max(8, Math.round(p.h * ROW_UNIT - 10)) + 'px';
      el.style.transform = 'translate(' + Math.round((p.col - 1) * g.colW + 5) + 'px, ' +
        Math.round((p.row - 1) * ROW_UNIT + 5) + 'px)';
    }
    for (let i = preview.length; i < pool.length; i++) {
      if (pool[i].parentNode) pool[i].parentNode.removeChild(pool[i]);
    }
    pool.length = preview.length;
    g.preview = preview;
  }

  clearNudges() {
    const pool = this.nudgeEls || [];
    for (const el of pool) { if (el.parentNode) el.parentNode.removeChild(el); }
    this.nudgeEls = [];
  }

  detachGesture() {
    const g = this.gesture;
    if (this._ptrMove) document.removeEventListener('pointermove', this._ptrMove);
    if (this._ptrUp) {
      document.removeEventListener('pointerup', this._ptrUp);
      document.removeEventListener('pointercancel', this._ptrUp);
    }
    if (this._scrollH) {
      const sc = (g && g.scrollEl) || this.contentEl;
      if (sc && typeof sc.removeEventListener === 'function') sc.removeEventListener('scroll', this._scrollH);
      this._scrollH = null;
    }
    if (g && g.handle) {
      if (typeof g.handle.releasePointerCapture === 'function' && g.pointerId !== undefined) {
        try { g.handle.releasePointerCapture(g.pointerId); } catch (e) { /* 忽略 */ }
      }
      if (this._ptrLost && typeof g.handle.removeEventListener === 'function') {
        g.handle.removeEventListener('lostpointercapture', this._ptrLost);
      }
    }
    this._ptrMove = this._ptrUp = this._ptrLost = null;
  }

  async onGestureEnd() {
    const g = this.gesture;
    if (!g) return;
    if (g.frame && typeof cancelAnimationFrame === 'function' && g.rafId) cancelAnimationFrame(g.rafId);
    g.frame = null;
    this.detachGesture();
    this.gesture = null;
    this.contentEl.removeClass('kbwb-grabbing');
    this.contentEl.removeClass('kbwb-grabbing-move', 'kbwb-grabbing-x', 'kbwb-grabbing-y', 'kbwb-grabbing-xy');
    if (this.ghost && this.ghost.parentNode) this.ghost.parentNode.removeChild(this.ghost);
    this.ghost = null;
    this.clearNudges();
    if (g.el.isConnected) g.el.removeClass('is-dragging', 'is-resizing');

    if (!g.changed) {
      if (g.el.isConnected) g.el.style.transform = '';
      if (this.pendingRender) this.render();
      return;
    }

    const move = g.kind === 'move';
    if (g.el.isConnected) g.el.style.transform = '';
    if (move) {
      // 一次落盘：写坐标 + 消解重叠（分两次写会先落进"压住别人"的中间态）
      // 被让位的卡不再弹 Notice / 不再高亮（用户：被压住的时候不用提醒）
      await this.plugin.commitDrop(g.modId, { col: g.tCol, row: g.tRow });
    } else {
      // 缩放同样要"写尺寸 + 消解重叠"一次落盘：只 setBox 的话，放大那张会直接压在邻居身上
      await this.plugin.commitResize(g.modId, { w: g.curW, h: g.curH });
    }
    // 松手只把新坐标写回现有 DOM：不 empty()、不重扫，
    // 所以不会出现"闪回原位再跳过去"（那就是用户看到的"回到原位"）
    if (this.narrowPane) {
      if (move) await this.plugin.sortLayoutByPosition();
      this.render();
    } else if (!this.syncBoxes()) {
      this.render();
    }
    if (this.pendingRender) this.render();
  }

  /** 只把 layout 里的坐标写回已存在的卡片 DOM。结构对不上（刚隐藏/恢复）返回 false */
  syncBoxes() {
    if (this.narrowPane) return false;
    const grid = this.contentEl.find ? this.contentEl.find('.kbwb-grid') : null;
    if (!grid) return false;
    const kids = Array.prototype.slice.call(grid.children || []);
    const byId = new Map();
    for (const k of kids) {
      if (k.dataset && k.dataset.mod) byId.set(k.dataset.mod, k);
    }
    const vis = this.plugin.layoutList().filter((s) => s.on);
    if (byId.size !== vis.length) return false;
    let changed = 0;
    for (const s of vis) {
      const el = byId.get(s.id);
      if (!el) return false;
      const col = s.col + ' / span ' + s.w;
      const row = s.row + ' / span ' + s.h;
      // 只写真的变了的那几张：8 张全写一遍 = 落位瞬间一次整版重排
      if (el.style.gridColumn !== col) { el.style.gridColumn = col; changed++; }
      if (el.style.gridRow !== row) { el.style.gridRow = row; changed++; }
    }
    const bar = grid.find ? grid.find('.kbwb-hidden') : null;
    if (bar) {
      const bottom = vis.reduce((m, s) => Math.max(m, s.row + s.h), 1);
      const barRow = (bottom + 1) + ' / span 5';
      if (bar.style.gridRow !== barRow) bar.style.gridRow = barRow;
    }
    return true;
  }

  /** 手势进行中拒绝重绘，否则库事件会重建 DOM、把正在拖的卡换掉 → 松手回到原位 */
  isBusy() { return !!this.gesture; }

  openCardMenu(anchor, modId) {
    this.closeCardMenu();
    const slot = this.plugin.slotOf(modId);
    const menu = this.contentEl.createDiv({ cls: 'kbwb-menu' });
    menu.createDiv({ cls: 'kbwb-menu-title', text: '尺寸' });
    const row = menu.createDiv({ cls: 'kbwb-menu-row' });
    for (const p of SIZE_PRESETS) {
      const b = row.createEl('button', {
        cls: 'kbwb-menu-opt' + (slot.w === p.w && slot.h === p.h ? ' is-on' : ''),
        text: p.label,
      });
      b.setAttr('title', p.w + '×' + p.h + '（' + Math.round(p.w / GRID_COLS * 100) + '% 宽 · ' + (p.h * ROW_UNIT - 10) + 'px 高）');
      b.addEventListener('click', () => {
        // 尺寸预设也是"放大"：同样要让邻居让位（和拖边/拖角一条路）
        this.plugin.commitResize(modId, { w: p.w, h: p.h });
        this.closeCardMenu();
        this.plugin.refreshViews(false);
      });
    }
    menu.createDiv({ cls: 'kbwb-menu-title', text: '模块' });
    const row2 = menu.createDiv({ cls: 'kbwb-menu-row' });
    const fold = row2.createEl('button', { cls: 'kbwb-menu-opt', text: slot.collapsed ? '展开' : '折叠（不再扫描）' });
    fold.addEventListener('click', () => {
      this.plugin.setCollapsed(modId, !slot.collapsed);
      this.closeCardMenu();
      this.plugin.refreshViews(false);
    });
    const hide = row2.createEl('button', { cls: 'kbwb-menu-opt', text: '隐藏此模块' });
    hide.addEventListener('click', () => {
      this.plugin.setModuleOn(modId, false);
      this.closeCardMenu();
      this.plugin.refreshViews(false);
    });
    const tidyBtn = row2.createEl('button', { cls: 'kbwb-menu-opt', text: '自动排列' });
    tidyBtn.addEventListener('click', () => {
      const narrow = (this.contentEl.clientWidth || window.innerWidth || 900) < 420;
      this.plugin.tidyLayout(narrow);
      this.closeCardMenu();
      this.plugin.refreshViews(false);
    });
    const all = row2.createEl('button', { cls: 'kbwb-menu-opt', text: '恢复默认布局' });
    all.addEventListener('click', () => {
      this.plugin.resetLayout();
      this.closeCardMenu();
      this.plugin.refreshViews(false);
    });

    const ar = anchor.getBoundingClientRect();
    const hr = this.contentEl.getBoundingClientRect();
    menu.style.top = (ar.bottom - hr.top + this.contentEl.scrollTop + 6) + 'px';
    menu.style.left = Math.max(6, Math.min(ar.left - hr.left, Math.max(6, hr.width - 250))) + 'px';
    this.menuEl = menu;
    this.menuOutside = () => this.closeCardMenu();
    window.setTimeout(() => {
      if (this.menuOutside) document.addEventListener('click', this.menuOutside, { once: true });
    }, 0);
  }

  closeCardMenu() {
    if (this.menuEl && this.menuEl.parentNode) this.menuEl.parentNode.removeChild(this.menuEl);
    this.menuEl = null;
    if (this.menuOutside) {
      try { document.removeEventListener('click', this.menuOutside); } catch (e) { /* ignore */ }
      this.menuOutside = null;
    }
  }

  /** 折叠态：只留一条头，不做任何扫描（省性能） */
  buildCollapsedCard(grid, slot) {
    const c = this.card(grid, slot.id, '已折叠');
    c.body.createDiv({ cls: 'kbwb-collapsed-body', text: '内容已折叠 · 点头部 ▸ 展开' });
    const btn = c.head.createSpan({ cls: 'kbwb-restore', text: '展开' });
    btn.addEventListener('click', () => {
      this.plugin.setCollapsed(slot.id, false);
      this.plugin.refreshViews(false);
    });
    return c;
  }

  /** 被隐藏的模块：一行恢复入口，不让用户"丢了找不回" */
  buildHiddenBar(grid) {
    const hidden = this.plugin.hiddenModules();
    if (!hidden.length) return;
    const bar = grid.createDiv({ cls: 'kbwb-hidden' });
    // 卡片都是显式摆放的，回收条必须自己排到最下面，否则会盖住卡
    const all = this.plugin.layoutList().filter((s) => s.on);
    const bottom = this.narrowPane
      ? this.stackRow
      : all.reduce((m, s) => Math.max(m, s.row + s.h), 1);
    bar.style.gridColumn = '1 / -1';
    bar.style.gridRow = (bottom + 1) + ' / span 5';
    bar.createSpan({ text: '已隐藏 ' + hidden.length + ' 个模块：' });
    for (const s of hidden) {
      const mod = MODULES.find((m) => m.id === s.id);
      const chip = bar.createSpan({ cls: 'kbwb-hidden-chip', text: (mod ? mod.title : s.id) + ' +' });
      chip.setAttr('title', '恢复显示');
      chip.addEventListener('click', () => {
        this.plugin.setModuleOn(s.id, true);
        this.plugin.refreshViews(false);
      });
    }
    const reset = bar.createSpan({ cls: 'kbwb-hidden-chip is-ghost', text: '恢复默认布局' });
    reset.addEventListener('click', () => {
      this.plugin.resetLayout();
      this.plugin.refreshViews(false);
    });
  }

  /** 数字增长动画（480ms，只改文本；降级环境或减少动效时跳过） */
  countUp(el, text) {
    if (typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined') return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const m = String(text).match(/^([^\d]*)(\d+(?:\.\d+)?)(.*)$/);
    if (!m) return;
    const target = parseFloat(m[2]);
    if (!isFinite(target) || target <= 0) return;
    const dec = (m[2].split('.')[1] || '').length;
    const dur = 480;
    const t0 = performance.now();
    const tick = (t) => {
      if (!el.isConnected) return;
      const k = Math.min(1, (t - t0) / dur);
      if (k < 1) {
        const ease = 1 - Math.pow(1 - k, 3);
        el.setText(m[1] + (target * ease).toFixed(dec) + m[3]);
        requestAnimationFrame(tick);
      } else {
        el.setText(text);
      }
    };
    requestAnimationFrame(tick);
  }

  empty(body, text, icon) {
    const wrap = body.createDiv({ cls: 'kbwb-empty' });
    if (icon) setIcon(wrap.createSpan({ cls: 'kbwb-empty-icon' }), icon);
    wrap.createSpan({ text: text });
    return wrap;
  }

  /** 加载骨架：按行数铺 shimmer 条 */
  skeleton(body, rows) {
    const n = rows || 3;
    for (let i = 0; i < n; i++) {
      body.createDiv({ cls: 'kbwb-skeleton ' + (i % 3 === 0 ? 'is-wide' : i % 3 === 1 ? 'is-mid' : 'is-short') });
    }
  }

  /* ---------------------------------------------- 搜索 */

  buildSearchCard(grid) {
    const c = this.card(grid, 'search', null);
    c.setChip(this.searchText ? '搜索中…' : null);
    this.searchChip = c.setChip;

    const box = c.body.createDiv({ cls: 'kbwb-search' });
    setIcon(box.createSpan({ cls: 'kbwb-search-icon' }), 'search');
    const input = box.createEl('input', {
      cls: 'kbwb-input', type: 'text', placeholder: '搜索整个知识库：标题、小标题、标签、正文…',
    });
    const kbd = box.createDiv({ cls: 'kbwb-kbd' });
    kbd.createSpan({ text: 'Enter' });
    kbd.createSpan({ text: 'Esc' });
    this.inputEl = input;
    input.value = this.searchText;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.searchText = ''; input.value = ''; this.clearResults(); }
      if (e.key === 'Enter') { const first = this.resultsEl.querySelector('.kbwb-res'); if (first) first.click(); }
    });
    const run = debounce(() => this.runSearch(), 220, true);
    input.addEventListener('input', () => { this.searchText = input.value; run(); });

    this.resultsEl = c.body.createDiv({ cls: 'kbwb-results' });
    if (this.searchText) this.runSearch();
    else this.clearResults();
  }

  clearResults() {
    if (!this.resultsEl) return;
    this.resultsEl.empty();
    this.empty(this.resultsEl, '输入关键词即时搜索；命中标题时排在最前，其次是小标题与标签，最后才扫正文。', 'search');
    if (this.searchChip) this.searchChip(null);
  }

  async runSearch() {
    const out = this.resultsEl;
    if (!out) return;
    const seq = ++this.searchSeq;
    out.empty();
    const query = (this.searchText || '').trim().toLowerCase();
    if (!query) { this.clearResults(); return; }

    const files = this.app.vault.getMarkdownFiles();
    const hits = [];
    const seen = new Set();

    for (const f of files) {
      let score = 0, why = '';
      const name = f.basename.toLowerCase();
      if (name === query) { score = 120; why = '标题相同'; }
      else if (name.indexOf(query) >= 0) { score += 45; why = '标题含'; }
      if (folderOf(f.path).toLowerCase().indexOf(query) >= 0) score += 6;
      const cache = this.app.metadataCache.getFileCache(f);
      if (cache) {
        for (const h of cache.headings || []) {
          if ((h.heading || '').toLowerCase().indexOf(query) >= 0) { score += Math.max(4, 20 - h.level * 2); why = why || '小标题含'; break; }
        }
        for (const t of (getAllTags(cache) || [])) {
          if (t.toLowerCase().indexOf(query) >= 0) { score += 12; why = why || '标签'; break; }
        }
        if (cache.frontmatter && score === 0) {
          try {
            if (JSON.stringify(cache.frontmatter).toLowerCase().indexOf(query) >= 0) { score += 8; why = why || '属性'; }
          } catch (e) { /* ignore */ }
        }
      }
      if (score > 0) { hits.push({ file: f, score, why, snippet: null }); seen.add(f.path); }
    }

    if (hits.length < 12 && query.length >= 2) {
      const rest = files.filter((f) => !seen.has(f.path))
        .sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 1500);
      for (const f of rest) {
        if (seq !== this.searchSeq) return;
        let text;
        try { text = await this.app.vault.cachedRead(f); } catch (e) { continue; }
        const i = text.toLowerCase().indexOf(query);
        if (i >= 0) hits.push({ file: f, score: 22, why: '正文', snippet: snippetOf(text, i, query.length) });
        if (hits.length >= 40) break;
      }
    }

    if (seq !== this.searchSeq) return;
    hits.sort((a, b) => b.score - a.score || b.file.stat.mtime - a.file.stat.mtime);
    const top = hits.slice(0, 25);
    if (!top.length) { this.empty(out, '没有命中「' + this.searchText.trim() + '」。'); if (this.searchChip) this.searchChip('0 命中'); return; }
    if (this.searchChip) this.searchChip(top.length + (hits.length > top.length ? ' / ' + hits.length : '') + ' 命中');
    for (const h of top) {
      const note = h.why + (h.snippet ? '：' + h.snippet : '');
      this.fileRow(out, h.file, note, 'kbwb-res');
    }
  }

  /* ---------------------------------------------- 快捷新建 */

  buildQuickCard(grid) {
    const c = this.card(grid, 'quick', null);
    const tplCount = this.plugin.listTemplates().length;
    c.setChip(tplCount ? '模板 ' + tplCount + ' 个' : '未设模板目录');
    const row = c.body.createDiv({ cls: 'kbwb-btns' });

    const mk = (icon, label, fn, title) => {
      const b = row.createEl('button', { cls: 'kbwb-btn', attr: title ? { title: title } : {} });
      setIcon(b.createSpan({ cls: 'kbwb-btn-icon' }), icon);
      b.createSpan({ cls: 'kbwb-btn-text', text: label });
      b.addEventListener('click', () => { fn(); });
      return b;
    };

    mk('calendar-days', '今日笔记', () => this.plugin.createDailyNote(), '按「日记」核心插件的文件夹与格式创建或打开今日笔记');
    mk('calendar-minus', '昨日笔记', () => this.plugin.openDailyOffset(-1), '直接打开昨天的日记（不存在则提示）');
    mk('file-plus', '新建笔记', () => this.newNoteWithTemplates(), '填标题 + 从模板目录里选一个模板（也可以当场新增模板）');
    mk('layout-template', '从模板新建', () => this.plugin.pickTemplateFlow(), '输入式挑模板（边打字边过滤），选中即建');
    mk('file-plus', '新增模板', () => this.newTemplateFlow(), '在同一个模板目录下新建一个模板文件');

    for (const b of (this.plugin.settings.quickButtons || [])) {
      if (!b || !b.label) continue;
      mk('plus', b.label, () => this.plugin.createNoteFlow({
        folder: b.folder || this.plugin.settings.newNoteFolder,
        template: b.template,
        suggest: b.prefix ? moment().format('YYYYMMDD-HHmm') : '',
      }), (b.template ? '模板：' + b.template : '空白笔记') + (b.folder ? ' ｜ 位置：' + b.folder : ''));
    }

    const add = row.createEl('button', { cls: 'kbwb-btn kbwb-btn-ghost', attr: { title: '在插件设置里增删按钮' } });
    setIcon(add.createSpan({ cls: 'kbwb-btn-icon' }), 'settings-2');
    add.createSpan({ cls: 'kbwb-btn-text', text: '自定义按钮' });
    add.addEventListener('click', () => this.plugin.openSettings());
  }

  /** 新建笔记：标题 + 模板列表（列表里就能当场新增模板），确认后按所选模板建 */
  async newNoteWithTemplates() {
    const res = await this.plugin.promptNewNote({
      initial: '',
      hint: '位置：' + (this.plugin.settings.newNoteFolder || '库根') + ' ｜ 选一个模板，或在这里新增一个模板',
      withTemplates: true,
    });
    if (!res || !res.name) return;
    await this.plugin.createNoteFlow({
      folder: this.plugin.settings.newNoteFolder,
      template: res.template || '',
      forcedName: res.name,
    });
  }

  /** 只建模板、不建笔记：同一个确认框的"模板名"模式 */
  async newTemplateFlow() {
    const res = await this.plugin.promptNewNote({
      initial: '',
      hint: '模板文件会建在「' + this.plugin.templateDir() + '」里，之后新建笔记时能选到它',
      asTemplate: true,
    });
    if (!res || !res.name) return;
    await this.plugin.createTemplate(res.name, '');
  }

  /* ---------------------------------------------- 收藏 */

  buildPinnedCard(grid) {
    const pins = this.plugin.pinnedPaths();
    const sticks = this.plugin.stuckPaths().filter((p) => pins.indexOf(p) >= 0);
    const rest = pins.filter((p) => sticks.indexOf(p) < 0);
    // chip 要短：抓手常驻卡顶正中，chip 太长会钻到它底下（实测 "置顶 2 · 共 2 篇" 会压 25×8px）
    const c = this.card(grid, 'pinned', pins.length
      ? (sticks.length ? '置顶 ' + sticks.length : pins.length + ' 篇')
      : null);
    if (!pins.length) {
      this.empty(c.body, '任意笔记行右侧点 ★ 收藏到这里；收藏后点 📌 置顶 —— 置顶的钉在卡片顶上，滚动也不会被推走。', 'star');
      return;
    }
    if (sticks.length) {
      const strip = c.body.createDiv({ cls: 'kbwb-sticky' });
      for (const path of sticks) this.pinRow(strip, path, true);
    }
    if (rest.length) {
      const list = c.body.createDiv({ cls: 'kbwb-pinlist' });
      for (const path of rest) this.pinRow(list, path, false);
    }
  }

  /** 收藏卡里的一行：★ 取消收藏 + 📌 置顶开关 */
  pinRow(host, path, stuck) {
    const f = this.app.vault.getFileByPath(normalizePath(path));
    if (!f) {
      const row = host.createDiv({ cls: 'kbwb-item is-stale' });
      row.createDiv({ cls: 'kbwb-item-main' }).createSpan({ cls: 'kbwb-item-name', text: path + '（已不存在）' });
      const btn = row.createDiv({ cls: 'kbwb-star is-on', attr: { title: '移除失效收藏' } });
      setIcon(btn, 'trash-2');
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.removePin(path); this.afterPinsChanged(); });
      return;
    }
    const row = this.fileRow(host, f, relTime(f.stat.mtime), 'kbwb-item');
    if (stuck) row.addClass('is-stuck');
    const star = row.querySelector('.kbwb-star');
    if (star) { star.addClass('is-on'); star.setAttr('title', '取消收藏'); }
    const pin = row.createDiv({ cls: 'kbwb-pin' + (stuck ? ' is-on' : ''), attr: { title: stuck ? '取消置顶' : '置顶（钉在收藏卡顶部）' } });
    setIconOr(pin, 'pin', '📌');
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      this.plugin.toggleStick(path);
      this.afterPinsChanged();   // 只重建收藏卡，不整版重绘
    });
  }

  /* ---------------------------------------------- 最近编辑 / 打开 */

  buildRecentCard(grid) {
    const c = this.card(grid, 'recent', null);
    let mode = this.plugin.recentMode || 'edited';
    const tabs = c.actions.createDiv({ cls: 'kbwb-tabs' });
    const fill = (id) => {
      c.body.empty();
      const list = id === 'opened' ? this.plugin.recentOpened()
        : id === 'review' ? this.plugin.reviewPicks()
          : this.plugin.recentEdited();
      c.setChip(list.length + ' 篇');
      tabs.findAll('.kbwb-tab').forEach((x) => x.toggleClass('is-active', x.dataset.m === id));
      if (!list.length) {
        this.empty(c.body, id === 'opened' ? '还没有打开记录：打开几篇笔记后这里就有内容了。'
          : id === 'review' ? '库里还没有 14 天以上的旧笔记。'
            : '这个库还没有 Markdown 笔记。', 'history');
        return;
      }
      for (const item of list) {
        const f = item.file || this.app.vault.getFileByPath(normalizePath(item.path));
        if (!f) continue;
        const note = id === 'review' ? '已 ' + Math.floor((Date.now() - f.stat.mtime) / 86400000) + ' 天未动' : relTime(item.time);
        this.fileRow(c.body, f, note, 'kbwb-item');
      }
    };
    for (const [id, label] of [['edited', '编辑'], ['opened', '打开'], ['review', '回顾']]) {
      const b = tabs.createEl('button', { cls: 'kbwb-tab', text: label });
      b.dataset.m = id;
      b.addEventListener('click', () => { mode = id; this.plugin.recentMode = id; fill(id); });
    }
    fill(mode);
  }

  /* ---------------------------------------------- 任务 */

  /** 一次 render 里两张卡（任务 + 到期日历）要的是同一批任务：合并成一次扫描。
      单卡重建前会把 _tasksShared 清掉，所以勾完任务不会读到旧数据。 */
  async tasksForRender() {
    if (this._tasksShared) return this._tasksShared;
    const t = await this.plugin.collectTasks();
    this._tasksShared = t;
    return t;
  }

  async buildTaskCard(grid) {
    const c = this.card(grid, 'tasks', '扫描中…');
    const body = c.body;
    this.skeleton(body, 4);

    const all = await this.tasksForRender();
    if (!this.containerEl.isConnected) return;
    body.empty(); // 骨架条必须清掉，否则会一直闪在卡片最上面（实测 bug）
    const today = todayStr();
    const t0 = startOfToday();
    const counts = {
      open: all.filter((t) => !t.done).length,
      today: all.filter((t) => !t.done && isTodayTask(t, today, t0)).length,
      overdue: all.filter((t) => !t.done && t.isOverdue).length,
      done: all.filter((t) => t.doneToday).length,
    };

    const tabs = c.actions.createDiv({ cls: 'kbwb-tabs' });
    const defs = [['open', '未完成'], ['today', '今天'], ['overdue', '逾期'], ['done', '今天完成']];

    // 今日进度：今天勾掉的 / (今天勾掉的 + 今天待办)
    const todayOpen = counts.today;
    const todayAll = counts.done + todayOpen;
    const progress = c.body.createDiv({ cls: 'kbwb-progress' });
    const pHead = progress.createDiv({ cls: 'kbwb-progress-head' });
    pHead.createSpan({ cls: 'kbwb-progress-label', text: '今日进度' });
    pHead.createSpan({ cls: 'kbwb-progress-val', text: counts.done + ' / ' + todayAll });
    const track = progress.createDiv({ cls: 'kbwb-progress-track' });
    const fillEl = track.createDiv({ cls: 'kbwb-progress-fill' });
    fillEl.style.width = todayAll ? Math.max(2, Math.round(counts.done / todayAll * 100)) + '%' : '0%';

    const listWrap = body.createDiv({ cls: 'kbwb-task-list' });

    const st = this.plugin.lastTaskStats || { empty: 0, template: 0, dup: 0 };
    const ignoredBits = [];
    if (st.template) ignoredBits.push('模板 ' + st.template);
    if (st.empty) ignoredBits.push('空 ' + st.empty);
    if (st.dup) ignoredBits.push('重复 ' + st.dup);
    if (ignoredBits.length) {
      const hint = body.createDiv({ cls: 'kbwb-count kbwb-hint' });
      hint.createSpan({ text: '已忽略 ' + (st.template + st.empty + st.dup) + ' 条（' + ignoredBits.join(' · ') + '）' });
      const excl = (this.plugin.settings.taskExclude || '').trim();
      if (excl) hint.createSpan({ cls: 'kbwb-hint-dim', text: ' ｜ 排除目录：' + excl });
    }

    const paint = (id) => {
      listWrap.empty();
      tabs.findAll('.kbwb-tab').forEach((x) => x.toggleClass('is-active', x.dataset.f === id));
      c.setChip('共 ' + all.length + ' 条');
      const list = all.filter((t) => {
        if (id === 'open') return !t.done;
        if (id === 'today') return !t.done && isTodayTask(t, today, t0);
        if (id === 'overdue') return !t.done && t.isOverdue;
        return t.doneToday;
      });
      if (!list.length) {
        this.empty(listWrap, id === 'open' ? '没有未完成任务，很清爽。'
          : id === 'today' ? '今天没有到期任务。判定口径：📅 到期日或 ⏳ 计划日 = 今天、带 #today、正文含 ' + today + '、或文件名/路径含 ' + today + '。'
          : id === 'overdue' ? '没有逾期任务（按 📅 到期日判断）。'
          : '今天还没有勾掉的任务。',
          id === 'overdue' ? 'clock' : 'circle-check-big');
        return;
      }
      let shown = 0, currentFile = null;
      for (const t of list) {
        if (shown >= this.plugin.settings.taskLimit) break;
        if (t.file.path !== currentFile) {
          currentFile = t.file.path;
          const h = listWrap.createDiv({ cls: 'kbwb-task-file' });
          const link = h.createSpan({ cls: 'kbwb-task-file-name', text: dirName(t.file.path) });
          link.addEventListener('click', () => this.plugin.openFile(t.file));
          h.createSpan({ cls: 'kbwb-task-file-path', text: folderOf(t.file.path) });
          h.createSpan({ cls: 'kbwb-time', text: relTime(t.file.stat.mtime) });
        }
        this.taskRow(listWrap, t);
        shown++;
      }
      if (list.length > shown) {
        listWrap.createDiv({ cls: 'kbwb-count', text: '另有 ' + (list.length - shown) + ' 条未显示（设置里可调大上限）' });
      }
    };

    for (const [id, label] of defs) {
      const b = tabs.createEl('button', { cls: 'kbwb-tab', text: label + ' ' + counts[id] });
      b.dataset.f = id;
      b.addEventListener('click', () => {
        this.taskFilter = id;
        this.plugin.settings.taskFilter = id;
        this.plugin.saveSettings();
        paint(id);
      });
    }
    paint(this.taskFilter);
  }

  taskRow(body, t) {
    const row = body.createDiv({
      cls: 'kbwb-task' + (t.done ? ' is-done' : '') + (!t.done && t.isOverdue ? ' is-overdue' : ''),
    });
    row.style.marginLeft = Math.min(24, t.indent * 4) + 'px';

    const box = row.createEl('input', { cls: 'kbwb-checkbox', type: 'checkbox' });
    box.checked = t.done;
    box.setAttr('title', t.done ? '标记为未完成' : '标记为完成');
    box.addEventListener('click', async (e) => {
      e.preventDefault();
      box.disabled = true;
      await this.plugin.toggleTask(t);
      this.afterTaskToggle();      // 只重建任务卡：整版重绘会"卡一下 + 跳回列表最上面"
    });

    const text = row.createDiv({ cls: 'kbwb-task-text' });
    text.createSpan({ cls: 'kbwb-task-body', text: t.text || '（空任务）' });
    for (const chip of (t.chips || [])) {
      text.createSpan({ cls: 'kbwb-mini kbwb-mini-' + chip.cls, text: chip.label });
    }
    if (t.dup > 1) text.createSpan({ cls: 'kbwb-mini kbwb-mini-dup', text: '×' + t.dup });
    text.setAttr('title', t.file.path + ' :' + (t.line + 1));
    text.addEventListener('click', () => this.plugin.openFile(t.file, t.line));
  }

  /* ---------------------------------------------- 知识库结构 */

  buildNavCard(grid) {
    const tree = this.plugin.folderTree();
    const c = this.card(grid, 'nav', tree.length ? tree.length + ' 个分区' : null);
    if (!tree.length) { this.empty(c.body, '库里还没有笔记。', 'folder-tree'); return; }

    const renderLevel = (host, nodes, depth) => {
      for (const node of nodes) {
        const row = host.createDiv({ cls: 'kbwb-folder' });
        const twisty = row.createDiv({ cls: 'kbwb-twisty' });
        if (node.children.length || node.files.length) {
          setIcon(twisty, 'chevron-right');
          if (this.expanded.has(node.path)) twisty.addClass('is-open');
        } else {
          twisty.addClass('is-leaf');
        }
        const glyph = row.createSpan({ cls: 'kbwb-folder-glyph' });
        setIcon(glyph, depth === 0 ? 'library' : 'folder');
        const name = row.createSpan({ cls: 'kbwb-folder-name', text: node.name });
        name.setAttr('title', '打开该文件夹里最新的一篇');
        row.createSpan({ cls: 'kbwb-chip kbwb-chip-soft', text: String(node.count) });
        name.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.openFolderFirst(node); });

        row.addEventListener('click', () => {
          // 有子目录或有笔记：点行即展开；空目录才去打开
          if (!node.children.length && !node.files.length) { this.plugin.openFolderFirst(node); return; }
          if (this.expanded.has(node.path)) this.expanded.delete(node.path);
          else this.expanded.add(node.path);
          c.body.empty();
          renderLevel(c.body, tree, 0);
        });

        if (this.expanded.has(node.path)) {
          const sub = host.createDiv({ cls: 'kbwb-sub' });
          if (node.children.length) renderLevel(sub, node.children, depth + 1);
          for (const f of node.files.slice(0, 5)) {
            const fr = sub.createDiv({ cls: 'kbwb-fileleaf' });
            fr.createSpan({ cls: 'kbwb-fileleaf-name', text: f.basename });
            fr.createSpan({ cls: 'kbwb-time', text: relTime(f.stat.mtime) });
            fr.addEventListener('click', () => this.plugin.openFile(f));
          }
        }
      }
    };
    renderLevel(c.body, tree, 0);
  }

  /* ---------------------------------------------- 笔记体检 */

  buildHygieneCard(grid) {
    const h = this.plugin.computeHygiene();
    const total = h.empty.length + h.untagged.length + h.orphan.length;
    const c = this.card(grid, 'hygiene', total ? total + ' 项待整理' : '干净');
    const body = c.body;

    /* ---- 第二十二轮：全盘扫描 —— 拿磁盘（文件系统）和体检卡（缓存）对账 ---- */
    const scan = body.createDiv({ cls: 'kbwb-scan' });
    const row = scan.createDiv({ cls: 'kbwb-scan-row' });
    const dirInput = row.createEl('input', { cls: 'kbwb-input kbwb-scan-dir', type: 'text', attr: { placeholder: '目录（留空 = 整库）' } });
    dirInput.value = this.plugin.settings.scanRoot || '';
    const runBtn = row.createEl('button', { cls: 'kbwb-btn kbwb-scan-run', text: '全盘扫描' });
    const stopBtn = row.createEl('button', { cls: 'kbwb-btn kbwb-scan-stop', text: '停止' });
    stopBtn.hide();
    const status = scan.createDiv({ cls: 'kbwb-scan-status' });
    const outEl = scan.createDiv({ cls: 'kbwb-scan-out' });

    const groups = [
      { key: 'empty', icon: 'file-x', label: '近空笔记', hint: '≤ 320 字节，基本只有骨架', list: h.empty },
      { key: 'untagged', icon: 'tag', label: '无标签', hint: '没有 YAML tags 也没有 #标签', list: h.untagged },
      { key: 'orphan', icon: 'unlink', label: '无入链', hint: '没有任何笔记链到它', list: h.orphan },
    ];

    const wrap = body.createDiv({ cls: 'kbwb-hygiene' });
    for (const g of groups) {
      const col = wrap.createDiv({ cls: 'kbwb-hy-col' });
      const head = col.createDiv({ cls: 'kbwb-hy-head' });
      const ico = head.createSpan({ cls: 'kbwb-hy-icon' });
      setIcon(ico, g.icon);
      head.createSpan({ cls: 'kbwb-hy-label', text: g.label });
      head.createSpan({ cls: 'kbwb-hy-count' + (g.list.length ? '' : ' is-zero'), text: String(g.list.length) });
      col.createDiv({ cls: 'kbwb-hy-hint', text: g.hint });

      if (!g.list.length) {
        col.createDiv({ cls: 'kbwb-hy-ok', text: '没有' });
        continue;
      }
      const listEl = col.createDiv({ cls: 'kbwb-hy-list' });
      const render = (limit) => {
        listEl.empty();
        for (const f of g.list.slice(0, limit)) {
          const row = listEl.createDiv({ cls: 'kbwb-hy-row' });
          row.createSpan({ cls: 'kbwb-hy-name', text: f.basename });
          row.createSpan({ cls: 'kbwb-time', text: folderOf(f.path) || '根目录' });
          row.setAttr('title', f.path);
          row.addEventListener('click', () => this.plugin.openFile(f));
        }
        if (g.list.length > limit) {
          const more = listEl.createDiv({ cls: 'kbwb-hy-more', text: '展开全部 ' + g.list.length + ' 篇' });
          more.addEventListener('click', () => render(g.list.length));
        }
      };
      render(4);
    }

    /* 全盘扫描的控件在卡片最上面（下面紧跟三份缓存清单）——
       按钮如果放在清单底下，卡体一滚动就看不见它了，等于没有。 */
    const normRoot = () => String(dirInput.value || '').trim().replace(/^\/+|\/+$/g, '');
    const GROUPS = [
      ['notIndexed', '磁盘上有、Obsidian 没索引', '在隐藏目录 / 以 . 开头 / 被「已排除的文件」挡掉 ⇒ 体检卡永远看不见它'],
      ['noCache', '索引里有、metadata 缓存没上', '这篇的标签与链接在体检里等于不存在（刚写入或库还没解析完）'],
      ['tagMissed', '缓存说没标签，正文里其实有', '常见于标签被代码块包住、或写法不被 Obsidian 认'],
      ['tagExtra', '缓存说有标签，自己解析没找到', '两边口径不一致，报出来供核对'],
      ['orphanDiff', '缓存说没人链它，正文里其实链了', '入链只在扫描范围内统计（扫子目录时这里会偏多）'],
    ];

    const paintResult = () => {
      outEl.empty();
      const r = this.plugin.lastScan;
      if (!r) { status.hide(); return; }
      status.show();
      const bits = ['磁盘 ' + r.disk + ' 篇 · 已看 ' + r.scanned + ' 篇 · ' + r.seconds + 's'];
      if (r.dirs) bits.push('走过 ' + r.dirs + ' 个目录');
      if (r.root && r.root !== '（整库）') bits.push('范围 ' + r.root);
      if (r.capped) bits.push('超上限被截断');
      if (r.stopped) bits.push('已手动停止');
      // 磁盘比索引少 = 磁盘列表没列全（正常情况下磁盘 ⊇ 索引：隐藏/被排除的文件只在磁盘上）。
      // 真机那次"磁盘 1 篇"就是这个形状 —— 写出来，别再靠人猜是扫描坏了还是库真的空了。
      if (r.lessThanIndex) bits.push('注意：比索引少 ' + r.lessThanIndex + ' 篇，磁盘列表可能没列全');
      if (r.error) bits.push(r.error);
      status.setText(bits.join(' ｜ '));
      if (r.error) return;
      const total = GROUPS.reduce((n, g) => n + r[g[0]].length, 0);
      if (!total) {
        this.empty(outEl, '没发现漏掉的：磁盘上的 .md 都被索引了，标签与入链两边一致。', 'scan-line');
      } else {
        for (const [key, label, hint] of GROUPS) {
          const list = r[key];
          if (!list.length) continue;
          const col = outEl.createDiv({ cls: 'kbwb-scan-group' });
          const head = col.createDiv({ cls: 'kbwb-scan-head' });
          head.createSpan({ cls: 'kbwb-scan-label', text: label });
          head.createSpan({ cls: 'kbwb-scan-count', text: String(list.length) });
          col.createDiv({ cls: 'kbwb-scan-hint', text: hint });
          const inner = col.createDiv({ cls: 'kbwb-scan-list' });
          const render2 = (limit) => {
            inner.empty();
            for (const it of list.slice(0, limit)) {
              const line = inner.createDiv({ cls: 'kbwb-scan-line' + (it.file ? ' is-openable' : '') });
              const base = it.path.slice(it.path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
              line.createSpan({ cls: 'kbwb-scan-name', text: it.file ? it.file.basename : base });
              line.createSpan({ cls: 'kbwb-time', text: folderOf(it.path) || '根目录' });
              line.setAttr('title', it.path + (it.file ? '' : '（Obsidian 没索引它，点开无效）'));
              if (it.file) line.addEventListener('click', () => this.plugin.openFile(it.file));
            }
            if (list.length > limit) {
              const more = inner.createDiv({ cls: 'kbwb-hy-more', text: '展开全部 ' + list.length + ' 条' });
              more.addEventListener('click', () => render2(list.length));
            }
          };
          render2(5);
        }
      }
      const clr = outEl.createEl('button', { cls: 'kbwb-btn kbwb-scan-clear', text: '清除结果' });
      clr.addEventListener('click', () => { this.plugin.clearScan(); paintResult(); });
    };

    dirInput.addEventListener('input', () => { this.plugin.settings.scanRoot = normRoot(); this.plugin.saveSettings(); });

    runBtn.addEventListener('click', async () => {
      if (this.plugin.scanRunning) return;
      this.plugin.scanRunning = true;
      this.plugin.settings.scanRoot = normRoot();
      this.plugin.saveSettings();
      runBtn.disabled = true;
      runBtn.setText('扫描中…');
      stopBtn.show();
      status.show();
      status.setText('扫描中…');
      const r = await this.plugin.fullScan(
        (n, total) => { status.setText('已看 ' + n + ' / ' + total + ' 篇…'); },
        () => !this.plugin.scanRunning
      );
      this.plugin.scanRunning = false;
      if (!this.containerEl.isConnected) return;
      runBtn.disabled = false;
      runBtn.setText('全盘扫描');
      stopBtn.hide();
      paintResult();
      if (!r.error) {
        new Notice('全盘扫描：磁盘 ' + r.disk + ' 篇，发现 ' +
          (r.notIndexed.length + r.noCache.length + r.tagMissed.length + r.tagExtra.length + r.orphanDiff.length) + ' 处不一致');
      }
    });
    stopBtn.addEventListener('click', () => { this.plugin.scanRunning = false; });

    paintResult();
  }

  /* ---------------------------------------------- 库统计 */

  async buildStatsCard(grid) {
    const c = this.card(grid, 'stats', null);
    const body = c.body;
    const paint = (s) => {
      if (!this.containerEl.isConnected) return;
      body.empty();
      c.setChip(String(s.md) + ' 篇');
      const wrap = body.createDiv({ cls: 'kbwb-stats' });
      const animate = !this.statsAnimated;
      const cell = (label, value, note) => {
        const d = wrap.createDiv({ cls: 'kbwb-stat' });
        const v = d.createDiv({ cls: 'kbwb-stat-v' });
        // 数字与单位拆开：等宽字体下整串 "18.4 MB" 太宽，会把格子挤爆
        const m = String(value).match(/^([\d.,]+)(\s+\S.*)$/);
        const num = v.createSpan({ cls: 'kbwb-stat-num', text: m ? m[1] : String(value) });
        if (m) v.createSpan({ cls: 'kbwb-stat-unit', text: m[2].trim() });
        if (animate) this.countUp(num, num.textContent);
        d.createDiv({ cls: 'kbwb-stat-l', text: label });
        if (note) d.createDiv({ cls: 'kbwb-stat-n', text: note });
      };
      cell('笔记', String(s.md), s.nonMd ? '附件/其他 ' + s.nonMd : '全库 ' + s.total + ' 个文件');
      cell('今日新增', String(s.todayNew));
      cell('今日修改', String(s.todayEdit));
      cell('7 天活跃', String(s.week), '日均 ' + (s.week / 7).toFixed(1) + ' 篇');
      cell('标签', String(s.tagCount), s.topTags.length ? '最热 #' + s.topTags[0][0] + ' × ' + s.topTags[0][1] : '暂无标签');
      cell('分区', String(s.folders.length), s.folders.length ? '最大 ' + s.folders[0].name : '平铺在根目录');
      cell('容量', fmtSize(s.bytes));
      if (this.plugin.settings.showWordCount) {
        cell('字数', s.words === null ? '—' : (s.words >= 10000 ? (s.words / 10000).toFixed(1) + ' 万' : String(s.words)), '估算');
      }
      this.statsAnimated = true;

      // 近 7 天火花条
      if (s.hist7 && s.hist7.length) {
        const spark = body.createDiv({ cls: 'kbwb-spark' });
        spark.createDiv({ cls: 'kbwb-spark-label', text: '近 7 天' });
        const bars = spark.createDiv({ cls: 'kbwb-spark-bars' });
        const max = Math.max.apply(null, s.hist7.concat([1]));
        s.hist7.forEach((v, i) => {
          const b = bars.createDiv({ cls: 'kbwb-spark-bar' + (i === s.hist7.length - 1 ? ' is-today' : '') });
          b.style.height = Math.max(8, Math.round(v / max * 100)) + '%';
          b.setAttr('title', (s.hist7Labels[i] || '') + '：' + v + ' 篇');
          if (v === max) b.addClass('is-peak');
        });
        spark.createDiv({ cls: 'kbwb-spark-val', text: '峰值 ' + max });
      }

      if (s.topTags.length) {
        const tags = body.createDiv({ cls: 'kbwb-tags' });
        tags.createDiv({ cls: 'kbwb-subtitle', text: '标签 Top ' + Math.min(12, s.topTags.length) + '（点击转成搜索）' });
        s.topTags.slice(0, 12).forEach(([name, n]) => {
          const t = tags.createSpan({ cls: 'kbwb-tag', text: name + ' · ' + n });
          t.addEventListener('click', () => {
            this.searchText = name;
            this.jumpToSearch = true; // 别还原滚动，要跳到搜索卡
            this.render();
          });
        });
      }

      if (s.folders.length) {
        const bars = body.createDiv({ cls: 'kbwb-bars' });
        bars.createDiv({ cls: 'kbwb-subtitle', text: '各分区笔记数' });
        const max = s.folders[0].count || 1;
        for (const f of s.folders.slice(0, 8)) {
          const r = bars.createDiv({ cls: 'kbwb-bar-row' });
          r.createSpan({ cls: 'kbwb-bar-name', text: f.name });
          const track = r.createDiv({ cls: 'kbwb-bar-track' });
          const fill = track.createDiv({ cls: 'kbwb-bar-fill' });
          fill.style.width = Math.max(3, Math.round(f.count / max * 100)) + '%';
          r.createSpan({ cls: 'kbwb-bar-val', text: String(f.count) });
        }
      }
    };

    if (this.plugin.statsCache) paint(this.plugin.statsCache);
    else this.skeleton(body, 2);
    paint(await this.plugin.computeStats());
  }

  /* ---------------------------------------------- 第二十轮：到期日历 */

  /** 按 📅 到期日分组（只算未完成任务）。纯函数，渲染层与测试都直接用它。
      undated = 没写 📅 的未完成任务数，用来在卡尾给一句提示，不让它们凭空消失。 */
  groupByDue(tasks, today) {
    const list = tasks || [];
    const in14 = shiftDayStr(today, 14);
    const open = list.filter((t) => !t.done);
    const dated = open.filter((t) => t.markers && t.markers.due);
    return {
      overdue: dated.filter((t) => t.markers.due < today),
      today: dated.filter((t) => t.markers.due === today),
      soon: dated.filter((t) => t.markers.due > today && t.markers.due <= in14),
      later: dated.filter((t) => t.markers.due > in14),
      undated: open.length - dated.length,
    };
  }

  async buildDueCard(grid) {
    const c = this.card(grid, 'due', null);
    const body = c.body;
    this.skeleton(body, 3);
    const all = await this.tasksForRender();
    if (!this.containerEl.isConnected) return;
    body.empty();
    const today = todayStr();
    const g = this.groupByDue(all, today);
    const dated = g.overdue.length + g.today.length + g.soon.length + g.later.length;
    if (!dated) {
      this.empty(body, '没有带 📅 的未完成任务。写成「- [ ] 事项 📅 ' + today + '」就会出现在这里。', 'calendar-clock');
      return;
    }
    // chip 用短文案：'逾期 2 条' 这种长法会钻到卡片顶部居中的抓手底下（audit 的 chrome 行当场抓到 9x8px 重叠）
    c.setChip(g.overdue.length ? '逾期 ' + g.overdue.length : dated + ' 条');
    const defs = [
      ['overdue', '已逾期', 'clock'],
      ['today', '今天到期', 'calendar-check'],
      ['soon', '未来 14 天', 'calendar-days'],
      ['later', '14 天以后', 'calendar'],
    ];
    const limit = clampInt(this.plugin.settings.taskLimit, 1, 500, 60);
    for (const [key, label, icon] of defs) {
      const list = g[key];
      if (!list.length) continue;
      const grp = body.createDiv({ cls: 'kbwb-due-group' + (key === 'overdue' ? ' is-overdue' : '') });
      const head = grp.createDiv({ cls: 'kbwb-due-head' });
      setIconOr(head.createSpan({ cls: 'kbwb-due-ico' }), icon, '·');
      head.createSpan({ cls: 'kbwb-due-label', text: label });
      head.createSpan({ cls: 'kbwb-due-count', text: String(list.length) });
      const inner = grp.createDiv({ cls: 'kbwb-due-list' });
      for (const t of list.slice(0, limit)) this.taskRow(inner, t);
      if (list.length > limit) {
        inner.createDiv({ cls: 'kbwb-count', text: '另有 ' + (list.length - limit) + ' 条未显示（设置里可调大上限）' });
      }
    }
    if (g.undated > 0) {
      body.createDiv({ cls: 'kbwb-count kbwb-hint', text: '另有 ' + g.undated + ' 条未完成任务没写 📅 到期日' });
    }
  }

  /* ---------------------------------------------- 第二十轮：速记本 */

  async buildScratchCard(grid) {
    const c = this.card(grid, 'scratch', null);
    const body = c.body;
    const p = String(this.plugin.settings.scratchPath || '每日笔记/速记.md');

    const form = body.createDiv({ cls: 'kbwb-scratch-form' });
    const input = form.createEl('input', {
      cls: 'kbwb-input kbwb-scratch-input', type: 'text',
      attr: { placeholder: '记一句，回车就存到 ' + p },
    });
    input.value = '';
    const btn = form.createEl('button', { cls: 'kbwb-btn kbwb-scratch-go', text: '追加' });
    const submit = async () => {
      const text = String(input.value || '').trim();
      if (!text) return;
      btn.disabled = true;                       // 防连点写两遍
      const done = await this.plugin.appendScratch(text);
      btn.disabled = false;
      if (!done) return;
      input.value = '';
      await this.refreshCard('scratch');         // 只重建这张卡，别整版重绘（滚动会跳）
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') submit(); });

    const listEl = body.createDiv({ cls: 'kbwb-scratch-list' });
    this.skeleton(listEl, 2);
    const lines = await this.plugin.readScratchLines();
    if (!this.containerEl.isConnected) return;
    listEl.empty();
    if (!lines.length) {
      this.empty(listEl, '速记本还是空的 —— 或者还没有这个文件。写一句回车就会自动创建：' + p, 'pencil');
      return;
    }
    const show = clampInt(this.plugin.settings.scratchLimit, 1, 200, 12);
    c.setChip(lines.length > show ? show + ' / ' + lines.length + ' 条' : lines.length + ' 条');
    for (const ln of lines.slice(0, show)) {
      const row = listEl.createDiv({ cls: 'kbwb-scratch-line' });
      row.createSpan({ cls: 'kbwb-scratch-time', text: ln.stamp });
      row.createSpan({ cls: 'kbwb-scratch-text', text: ln.text });
      row.setAttr('title', ln.raw);
    }
    if (lines.length > show) {
      listEl.createDiv({ cls: 'kbwb-count', text: '更早 ' + (lines.length - show) + ' 条在文件里（点标题栏 ⋯ 可把卡放大）' });
    }
  }

  /* ---------------------------------------------- 第二十/二十一轮：标签总览（含框选多选） */

  /** 框选命中判定（纯函数，坐标系 = 列表的内容坐标）：rows/rect 都是 {top,bottom,left,right} */
  marqueeHits(rows, rect) {
    const out = [];
    for (const r of (rows || [])) {
      if (!r || !r.name) continue;
      if (r.right < rect.left || r.left > rect.right) continue;
      if (r.bottom < rect.top || r.top > rect.bottom) continue;
      out.push(r.name);
    }
    return out;
  }

  /** 选中标签 → 笔记。mode='all' 交集（同时带这些标签），'any' 并集；按修改时间新的在前 */
  pickTagNotes(tagFiles, sel, mode) {
    const list = (sel || []).filter(Boolean);
    if (!list.length || !tagFiles || typeof tagFiles.get !== 'function') return [];
    const sets = list.map((n) => tagFiles.get(n) || []);
    let out;
    if (mode === 'all') {
      const base = sets.slice().sort((a, b) => a.length - b.length)[0] || [];
      out = base.filter((f) => sets.every((s) => s.some((x) => x.path === f.path)));
    } else {
      const seen = new Set();
      out = [];
      for (const s of sets) for (const f of s) { if (!seen.has(f.path)) { seen.add(f.path); out.push(f); } }
    }
    return out.slice().sort((a, b) => ((b.stat && b.stat.mtime) || 0) - ((a.stat && a.stat.mtime) || 0));
  }

  /** 框选起手：在标签列表上按住拖。绑在 document 上（与卡片手势同一套路），
      移动逻辑抽成 moveTagMarquee / endTagMarquee，测试可以直接调，不必伪造 document 事件。 */
  startTagMarquee(ev, c, listEl) {
    if (ev.button !== undefined && ev.button !== 0) return;
    const t = ev.target;
    if (t && typeof t.closest === 'function' && t.closest('input, button, .kbwb-tagrow-name')) return;
    const body = c.body;
    let rect0 = { top: 0, left: 0 };
    try { rect0 = listEl.getBoundingClientRect(); } catch (e) { rect0 = { top: 0, left: 0 }; }
    const m = {
      listEl, body, x0: ev.clientX, y0: ev.clientY,
      top0: rect0.top, left0: rect0.left, raf: 0, moved: false, rect: null,
      additive: !!(ev.ctrlKey || ev.metaKey || ev.shiftKey),
    };
    m.box = listEl.createDiv({ cls: 'kbwb-marquee' });
    m.box.style.display = 'none';
    listEl.addClass('is-marquee');
    this._mq = m;
    if (typeof listEl.setPointerCapture === 'function' && ev.pointerId !== undefined) {
      try { listEl.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
    }
    this._mqMove = (e2) => this.moveTagMarquee(e2);
    this._mqUp = () => this.endTagMarquee();
    // 滚动时只刷新"列表在视口里的起点"，不逐帧读 rect（滚轮比 pointermove 稀得多）
    this._mqScroll = () => {
      if (!this._mq) return;
      try { const r = this._mq.listEl.getBoundingClientRect(); this._mq.top0 = r.top; this._mq.left0 = r.left; } catch (e) { /* 忽略 */ }
    };
    document.addEventListener('pointermove', this._mqMove);
    document.addEventListener('pointerup', this._mqUp);
    document.addEventListener('pointercancel', this._mqUp);
    if (typeof body.addEventListener === 'function') body.addEventListener('scroll', this._mqScroll);
  }

  /** 内容坐标：列表内某点对应的 y = 视口 y − 列表视口顶 + 列表滚动量 */
  mqPoint(ev, m) {
    return { x: ev.clientX - m.left0, y: ev.clientY - m.top0 + (m.body.scrollTop || 0) };
  }

  moveTagMarquee(ev) {
    const m = this._mq;
    if (!m) return;
    const dx = ev.clientX - m.x0, dy = ev.clientY - m.y0;
    if (!m.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;   // 4px 以内算"点一下"，不进入框选
    m.moved = true;
    if (m.raf) return;                     // 一帧最多写一次样式
    m.raf = requestAnimationFrame(() => {
      m.raf = 0;
      if (!this._mq) return;
      const a = this.mqPoint({ clientX: m.x0, clientY: m.y0 }, m);
      const b = this.mqPoint(ev, m);
      const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
      const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
      m.rect = { left, right, top, bottom };
      m.box.style.display = '';
      m.box.style.left = left + 'px';
      m.box.style.top = top + 'px';
      m.box.style.width = (right - left) + 'px';
      m.box.style.height = (bottom - top) + 'px';
    });
  }

  endTagMarquee() {
    const m = this._mq;
    if (!m) return;
    document.removeEventListener('pointermove', this._mqMove);
    document.removeEventListener('pointerup', this._mqUp);
    document.removeEventListener('pointercancel', this._mqUp);
    if (typeof m.body.removeEventListener === 'function') m.body.removeEventListener('scroll', this._mqScroll);
    m.listEl.removeClass('is-marquee');
    if (m.box && m.box.parentNode && typeof m.box.parentNode.removeChild === 'function') m.box.parentNode.removeChild(m.box);
    this._mq = null;
    if (!m.moved || !m.rect) return;
    this._mqEndedAt = Date.now();          // 紧随其后的那一下 click 是框选的副产物，不当点选
    const st = m.body.scrollTop || 0;
    const rows = [];
    for (const r of (m.listEl.findAll ? m.listEl.findAll('.kbwb-tagrow') : [])) {
      let rr = null;
      try { rr = r.getBoundingClientRect(); } catch (e) { rr = null; }
      if (!rr) continue;
      rows.push({
        name: (r.dataset && r.dataset.tag) || '',
        top: rr.top - m.top0 + st, bottom: rr.bottom - m.top0 + st,
        left: rr.left - m.left0, right: rr.right - m.left0,
      });
    }
    const hits = this.marqueeHits(rows, m.rect);
    if (m.additive) {
      if (!this.tagSel) this.tagSel = [];
      for (const n of hits) if (this.tagSel.indexOf(n) < 0) this.tagSel.push(n);
    } else {
      this.tagSel = hits;
    }
    this.refreshCard('tags');
  }

  async buildTagsCard(grid) {
    const c = this.card(grid, 'tags', null);
    const body = c.body;
    this.skeleton(body, 3);
    const s = await this.plugin.computeStats();
    if (!this.containerEl.isConnected) return;
    body.empty();
    const all = (s && s.topTags) || [];   // 全量排序标签（统计卡自己只切前 12，这里不切）
    if (!this.tagSel) this.tagSel = [];
    // 标签被删了就从选择里丢掉，别留悬空（与收藏/置顶同一套做法）
    const alive = {};
    for (const x of all) alive[x[0]] = true;
    this.tagSel = this.tagSel.filter((n) => alive[n]);
    if (!all.length) {
      this.empty(body, '库里还没有标签。在笔记里写 #标签 就会被收到这里。', 'tags');
      return;
    }
    c.setChip(this.tagSel.length ? '已选 ' + this.tagSel.length : all.length + ' 个');

    const box = body.createDiv({ cls: 'kbwb-tagfilter' });
    setIconOr(box.createSpan({ cls: 'kbwb-tagfilter-ico' }), 'search', '·');
    const input = box.createEl('input', { cls: 'kbwb-input kbwb-tagfilter-input', type: 'text', attr: { placeholder: '过滤标签…' } });
    input.value = this.tagQuery || '';

    const listEl = body.createDiv({ cls: 'kbwb-taglist' });
    const selBar = body.createDiv({ cls: 'kbwb-tagselbar' });
    const resEl = body.createDiv({ cls: 'kbwb-tagres' });
    const max = all[0][1] || 1;

    /** 选中标签的笔记列表（都含 / 任一） */
    const paintNotes = () => {
      resEl.empty();
      if (!this.tagSel.length || !this.tagMode) return;
      const files = this.pickTagNotes(s.tagFiles, this.tagSel, this.tagMode);
      resEl.createDiv({
        cls: 'kbwb-subtitle',
        text: (this.tagMode === 'all' ? '同时带这 ' : '带其中任一个的 ') + this.tagSel.length + ' 个标签 · ' + files.length + ' 篇',
      });
      if (!files.length) { this.empty(resEl, '没有同时满足的笔记。', 'tags'); return; }
      const cap = 40;
      files.slice(0, cap).forEach((f) => this.fileRow(resEl, f, null, 'kbwb-item'));
      if (files.length > cap) resEl.createDiv({ cls: 'kbwb-count', text: '另有 ' + (files.length - cap) + ' 篇未显示' });
    };

    const paintBar = () => {
      selBar.empty();
      // chip 跟着选择走（原来只在建卡时设一次，选完标签 chip 还停在「N 个」）
      c.setChip(this.tagSel.length ? '已选 ' + this.tagSel.length : all.length + ' 个');
      if (!this.tagSel.length) { selBar.hide(); return; }
      selBar.show();
      selBar.createSpan({
        cls: 'kbwb-tagsel-count',
        text: '已选 ' + this.tagSel.length + '：' + this.tagSel.slice(0, 4).join('、') + (this.tagSel.length > 4 ? '…' : ''),
      });
      const mk = (label, fn) => {
        const b = selBar.createEl('button', { cls: 'kbwb-btn kbwb-tagsel-btn' + (label === '清空' ? ' is-ghost' : ''), text: label });
        b.addEventListener('click', fn);
        return b;
      };
      mk('都含', () => { this.tagMode = 'all'; paintNotes(); });
      mk('任一', () => { this.tagMode = 'any'; paintNotes(); });
      mk('清空', () => { this.tagSel = []; this.tagMode = null; paint(); });
    };

    const paint = () => {
      const q = String(this.tagQuery || '').trim().toLowerCase();
      listEl.empty();
      const list = q ? all.filter((x) => String(x[0]).toLowerCase().indexOf(q) >= 0) : all;
      if (!list.length) { this.empty(listEl, '没有匹配的标签：' + q, 'tags'); paintBar(); return; }
      for (const [name, n] of list) {
        const sel = this.tagSel.indexOf(name) >= 0;
        const row = listEl.createDiv({ cls: 'kbwb-tagrow' + (sel ? ' is-sel' : '') });
        row.dataset.tag = name;
        row.createSpan({ cls: 'kbwb-tagrow-name', text: name });
        const track = row.createDiv({ cls: 'kbwb-tagrow-track' });
        const fill = track.createDiv({ cls: 'kbwb-tagrow-fill' });
        fill.style.width = Math.max(3, Math.round(n / max * 100)) + '%';
        row.createSpan({ cls: 'kbwb-tagrow-count', text: String(n) });
        row.setAttr('title', (sel ? '再点一下取消选择' : '点一下转搜索；Ctrl/⌘ 点或按住拖 = 多选') + ' #' + name);
        row.addEventListener('click', (ev) => {
          if (Date.now() - (this._mqEndedAt || 0) < 250) return;   // 框选刚结束的那一下 click
          const additive = !!(ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey));
          if (additive || this.tagSel.length) {
            const j = this.tagSel.indexOf(name);
            if (j >= 0) this.tagSel.splice(j, 1); else this.tagSel.push(name);
            paint();
            return;
          }
          this.searchText = name;
          this.jumpToSearch = true;   // 与统计卡标签云同一条路径（顶栏遮挡已由 scroll-margin-top 解决）
          this.render();
        });
      }
      listEl.createDiv({ cls: 'kbwb-count kbwb-hint', text: '共 ' + list.length + ' 个 · 点一下转搜索 · Ctrl/⌘ 点或按住拖 = 框选多选' });
      paintBar();
      paintNotes();
    };

    input.addEventListener('input', () => { this.tagQuery = input.value || ''; paint(); });
    listEl.addEventListener('pointerdown', (ev) => this.startTagMarquee(ev, c, listEl));
    paint();
  }

  /* ---------------------------------------------- 第二十轮：月历 */

  /** 月历格子：周一起算，null = 该格不属于本月（纯函数，测试直接断偏移与总长） */
  monthCells(y, m) {
    const offset = (new Date(y, m, 1).getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7) cells.push(null);
    return cells;
  }

  /**
   * 一条待办的行（待办卡与月历「当日待办」共用一套 DOM）。
   * 与 taskRow 的区别：这一条来自插件自己的两篇 markdown，不是全库扫描出来的任务，
   * 所以勾/删直接改那两个文件，并只重建用到的这两张卡。
   */
  todoRow(body, which, item, afterChange) {
    const row = body.createDiv({ cls: 'kbwb-todo-row' + (item.done ? ' is-done' : '') });
    const box = row.createEl('input', { cls: 'kbwb-checkbox', type: 'checkbox' });
    box.checked = item.done;
    box.setAttr('title', item.done ? '标记为未完成' : '标记为完成');
    box.addEventListener('click', async (e) => {
      e.preventDefault();
      box.disabled = true;
      await this.plugin.setTodoDone(which, item.line, item.text, !item.done);
      if (typeof afterChange === 'function') await afterChange();
      else await this.refreshCard('todos');
    });
    const text = row.createDiv({ cls: 'kbwb-todo-text' });
    text.createSpan({ cls: 'kbwb-todo-body', text: item.text });
    text.setAttr('title', this.plugin.todoFilePath(which) + ' :' + (item.line + 1));
    const del = row.createEl('button', { cls: 'kbwb-todo-del', text: '×', attr: { title: '删掉这一条' } });
    del.addEventListener('click', async () => {
      del.disabled = true;
      await this.plugin.removeTodo(which, item.line, item.text);
      if (typeof afterChange === 'function') await afterChange();
      else await this.refreshCard('todos');
    });
    return row;
  }

  /** 月历与待办卡是一对联动视图（共用 calSelected + 同一份待办数据）：
      任何一侧增/删/勾/换选中日，两张卡都要重建，否则会出现"一边动了另一边停在旧数据"的不对称。
      （待办卡可能被隐藏 ⇒ refreshCard 返回 false，不影响。） */
  async refreshTodoLinked() {
    await this.refreshCard('calendar');
    await this.refreshCard('todos');
  }

  /** 添加待办的输入行（待办卡两个页签 + 月历当日区共用） */
  todoForm(host, which, key, placeholder, afterAdd) {
    const form = host.createDiv({ cls: 'kbwb-todo-form' });
    const input = form.createEl('input', { cls: 'kbwb-input kbwb-todo-input', type: 'text', attr: { placeholder: placeholder } });
    input.value = '';
    const btn = form.createEl('button', { cls: 'kbwb-btn kbwb-todo-go', text: '加' });
    const submit = async () => {
      const text = String(input.value || '').trim();
      if (!text) return;
      btn.disabled = true;
      const done = await this.plugin.addTodo(which, key, text);
      btn.disabled = false;
      if (done === null) return;
      input.value = '';
      if (typeof afterAdd === 'function') await afterAdd();
      else await this.refreshCard('todos');
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') submit(); });
    return { input, submit };
  }

  async buildCalendarCard(grid) {
    const c = this.card(grid, 'calendar', null);
    const body = c.body;
    if (!this.plugin.coreConfig) await this.plugin.loadConfigs();
    const cfg = this.plugin.coreConfig || {};
    const now = new Date();
    if (!this.calCursor) this.calCursor = { y: now.getFullYear(), m: now.getMonth() };
    const cur = this.calCursor;
    const todayYmd = todayStr();
    // 选中日：月历点某一天 = 看那天的待办（第三十二轮换了交互）。没点过就是今天。
    // 故意放在 view 上而不是 data.json：这是浏览状态，不该因为换设备而"记住"。
    if (!this.calSelected) this.calSelected = todayYmd;

    c.setChip(cur.y + '·' + (cur.m + 1));
    const nav = c.actions.createDiv({ cls: 'kbwb-cal-nav' });
    const mkNav = (label, step, title) => {
      const b = nav.createEl('button', { cls: 'kbwb-cal-navbtn', text: label, attr: { title: title } });
      // 翻月只改 this.calCursor，而 calCursor 全文件只有这张卡读（2878-2879）⇒ 只重建这一张卡。
      // 这里原来写的是 this.render()：整版重绘 14 张卡（JS 约 6-7ms，且所有节点换新），
      // 用户真机反馈「在月份间切换的时候还是会有重载的问题，还是会跳」就是它 —— 别的卡被换掉，
      // 各自滚动位置靠还原表兜，新内容高度一旦不同就被夹，看着就是「跳一下」。
      // （统计卡标签云 / 标签总览那两处仍走整版 render()：它们要消费 jumpToSearch，是故意的。）
      b.addEventListener('click', () => { step(); this.refreshCard('calendar'); });
    };
    mkNav('‹', () => { cur.m -= 1; if (cur.m < 0) { cur.m = 11; cur.y -= 1; } }, '上一月');
    mkNav('本月', () => { cur.y = now.getFullYear(); cur.m = now.getMonth(); }, '回到本月');
    mkNav('›', () => { cur.m += 1; if (cur.m > 11) { cur.m = 0; cur.y += 1; } }, '下一月');

    // 一次渲染共用一份待办扫描（todosForRender 里缓存）：红点与当日清单要的是同一批数据
    const todos = await this.plugin.todosForRender();
    if (!this.containerEl.isConnected) return;
    const openDaily = todos.openDaily || {};

    // 选中日先算出来：格子的 is-sel 与底下那块清单要用同一个日期。
    // 跨月翻日历时按"这个月的第几天"跟着走，并夹到该月的天数内（2 月没有 30 号）。
    const selDay = clampInt(Number(String(this.calSelected).slice(8, 10)), 1,
      new Date(cur.y, cur.m + 1, 0).getDate(), now.getDate());
    const selDate = new Date(cur.y, cur.m, selDay);
    const selYmd = ymd(selDate);

    const head = body.createDiv({ cls: 'kbwb-cal-head' });
    for (const w of ['一', '二', '三', '四', '五', '六', '日']) head.createSpan({ cls: 'kbwb-cal-wd', text: w });

    const gridEl = body.createDiv({ cls: 'kbwb-cal-grid' });
    for (const d of this.monthCells(cur.y, cur.m)) {
      const cell = gridEl.createDiv({ cls: 'kbwb-cal-cell' + (d ? '' : ' is-blank') });
      if (!d) { cell.createSpan({ cls: 'kbwb-cal-num', text: '' }); continue; }
      const date = new Date(cur.y, cur.m, d);
      const ymds = ymd(date);
      cell.createSpan({ cls: 'kbwb-cal-num', text: String(d) });
      const notes = this.plugin.dailyNotesFor(date);
      const exists = notes.length > 0;
      const todoCount = todos.openCountDaily[ymds] || 0;   // 计数在 todosForRender 里一次算好（原来每格扫一遍组 + filter 一遍 items）
      if (ymds === todayYmd) cell.addClass('is-today');
      if (exists) cell.addClass('is-has');
      // 两个标记各占各的元素：● = 有日记（强调色），红点 = 有未完成待办
      cell.createSpan({ cls: 'kbwb-cal-mark', text: exists ? '●' : '' });
      if (openDaily[ymds]) {
        cell.addClass('is-todo');
        cell.createSpan({ cls: 'kbwb-cal-dot', text: '' });
      }
      if (d === selDay && ymds === selYmd) cell.addClass('is-sel');
      const bits = [];
      if (exists) bits.push('日记 ' + notes.length + ' 篇');
      if (todoCount) bits.push('待办 ' + todoCount + ' 条');
      cell.setAttr('title', ymds + '：点一下看当日待办' + (bits.length ? '（' + bits.join('｜') + '）' : '（还没有东西）'));
      cell.addEventListener('click', () => {
        this.calSelected = ymds;
        // 待办卡的「每日」用的就是 calSelected ⇒ 只刷月历的话，待办卡会停在原来那天
        //（等下一次整版重绘才跟上 = 看着像点了没反应）。两张一起刷，不碰库。
        this.refreshTodoLinked();
      });
    }

    /* 当日待办：点日期看到的就是这一块（不再弹新建笔记的框） */
    const dayWrap = body.createDiv({ cls: 'kbwb-cal-day' });
    dayWrap.dataset.date = selYmd;
    const dayHead = dayWrap.createDiv({ cls: 'kbwb-cal-day-head' });
    dayHead.createSpan({ cls: 'kbwb-cal-day-date', text: selYmd + ' ' + WEEKDAY_CN[selDate.getDay()] });
    const dayTodos = todoSectionFor(todos.daily, selYmd);
    const dayOpen = dayTodos ? dayTodos.items.filter((x) => !x.done).length : 0;
    dayHead.createSpan({ cls: 'kbwb-cal-day-count', text: dayOpen ? '待办 ' + dayOpen : '无待办' });
    const refreshCal = async () => { await this.refreshTodoLinked(); };
    this.todoForm(dayWrap, 'daily', selYmd, '加一条到 ' + selYmd.slice(5) + '…', refreshCal);
    const dayList = dayWrap.createDiv({ cls: 'kbwb-cal-day-list' });
    if (!dayTodos || !dayTodos.items.length) {
      dayList.createDiv({ cls: 'kbwb-count kbwb-hint', text: '这天还没有待办。' });
    } else {
      // 当日区只摊开前几条（窄卡高度有限，全清单在「待办」卡与文件里看）
      const cap = Math.min(clampInt(this.plugin.settings.todoLimit, 1, 200, 20), 4);
      for (const it of dayTodos.items.slice(0, cap)) this.todoRow(dayList, 'daily', it, refreshCal);
      if (dayTodos.items.length > cap) {
        dayList.createDiv({ cls: 'kbwb-count', text: '另有 ' + (dayTodos.items.length - cap) + ' 条（「待办」卡里看全）' });
      }
    }

    const hint = body.createDiv({ cls: 'kbwb-count kbwb-hint' });
    hint.createSpan({ text: '● = 有日记｜红点 = 有未完成待办｜日记位置：' + (cfg.dailyFolder || '（库根）') + ' · ' + (cfg.dailyFormat || 'YYYY-MM-DD') });

    /* 新建笔记挪到这里了：卡片底部的按钮，走的还是原来那条 createDailyOn / DayNotesModal 链。
       只把这一行钉在卡体下缘：窄卡里格子 + 当日清单很容易超出可视高度，不钉住的话
       这个按钮要靠滚动才看得见（实测 dh 34 时它在折叠区外 258px）。
       图例不放进来 —— sticky 那块每多一行，当日面板就被多盖住一行（audit 的 calBottom 会报）。 */
    const bottom = body.createDiv({ cls: 'kbwb-cal-bottom' });
    const foot = bottom.createDiv({ cls: 'kbwb-cal-foot' });
    const newBtn = foot.createEl('button', {
      cls: 'kbwb-btn kbwb-cal-new', text: '＋ 新建笔记',
      attr: { title: '为选中的这天建笔记（已有就列出来，可再建一篇）' },
    });
    newBtn.addEventListener('click', async () => {
      newBtn.disabled = true;
      try { await this.plugin.openOrCreateDailyOn(selDate); }
      finally { if (newBtn.isConnected) newBtn.disabled = false; }
      if (this.containerEl.isConnected) await this.refreshCard('calendar');
    });
    // 用户 11-10：底部不要再写「笔记 N 篇」，直接把文件名摆出来，点一下就打开。
    // （原来那个按钮还有个隐藏毛病：写着 N 篇却只打开 notesToday[0]。）
    // 超过 3 篇才退回列表弹框 —— 那一行摆不下，也不该把 sticky 那块越撑越高（calBottom 会报）。
    const notesToday = this.plugin.dailyNotesFor(selDate);
    if (notesToday.length) {
      const names = bottom.createDiv({ cls: 'kbwb-cal-notes' });
      const capN = 3;
      for (const f of notesToday.slice(0, capN)) {
        const label = String(f.basename || (f.name || '').replace(/\.md$/i, '') || f.path);
        const chip = names.createEl('button', {
          cls: 'kbwb-cal-note', text: label,
          attr: { title: '打开 ' + f.path },
        });
        chip.addEventListener('click', () => this.plugin.openFile(f));
      }
      if (notesToday.length > capN) {
        const more = names.createEl('button', {
          cls: 'kbwb-cal-note is-more', text: '另有 ' + (notesToday.length - capN) + ' 篇',
          attr: { title: '这天一共 ' + notesToday.length + ' 篇，点开列表挑' },
        });
        more.addEventListener('click', () => new DayNotesModal(this.app, selYmd, notesToday, (res) => {
          if (res && res.open) this.plugin.openFile(res.open);
          else if (res && res.create) this.plugin.createDailyOn(selDate);
        }).open());
      }
    }
  }

  /* ---------------------------------------------- 第三十二轮：待办（每日 / 每周） */

  /**
   * 一张卡、两个页签（用户说的"标签"= 卡片，所以这是单独一张卡里的两页签，照「任务」「最近」的 kbwb-tabs 抄）。
   * 数据源是插件自己维护的两篇 markdown（待办/每日待办.md、待办/每周待办.md），
   * 不是全库带 📅 的任务 —— 那条路已经被「到期日历」占了，两处都显示等于重复一张卡。
   */
  async buildTodosCard(grid) {
    const c = this.card(grid, 'todos', null);
    const body = c.body;
    const todos = await this.plugin.todosForRender();
    if (!this.containerEl.isConnected) return;

    let mode = this.todosMode || 'daily';
    const tabs = c.actions.createDiv({ cls: 'kbwb-tabs' });
    const paint = (id) => {
      mode = id;
      this.todosMode = id;
      tabs.findAll('.kbwb-tab').forEach((x) => x.toggleClass('is-active', x.dataset.m === id));
      body.empty();
      const isDaily = id === 'daily';
      const now = new Date();
      // 周键走 todosWeekKey（点「‹ 上一周」改的就是它）：
      // 之前这里用 isoWeekKey(now)，翻了周界面还在本周 —— 状态改了个寂寞。
      if (!this.todosWeekKey) this.todosWeekKey = isoWeekKey(now);
      const key = isDaily ? (this.calSelected || todayStr()) : this.todosWeekKey;
      const which = isDaily ? 'daily' : 'weekly';
      const sections = isDaily ? todos.daily : todos.weekly;
      const sec = todoSectionFor(sections, key);
      const items = sec ? sec.items : [];
      const open = items.filter((x) => !x.done).length;
      c.setChip(open ? '待办 ' + open : (items.length ? '已清空' : ''));

      const head = body.createDiv({ cls: 'kbwb-todo-head' });
      head.createSpan({
        cls: 'kbwb-todo-when',
        text: isDaily ? key + ' ' + WEEKDAY_CN[ymdToDate(key).getDay()]
          : key + '｜' + weekSpanText(key),
      });
      if (isDaily && key !== todayStr()) {
        const back = head.createEl('button', { cls: 'kbwb-btn kbwb-todo-today', text: '回今天' });
        back.addEventListener('click', () => { this.calSelected = todayStr(); this.refreshCard('todos'); this.refreshCard('calendar'); });
      }
      if (!isDaily) {
        const prev = head.createEl('button', { cls: 'kbwb-btn kbwb-todo-w', text: '‹ 上一周', attr: { title: '看上一周（周一起算）' } });
        prev.addEventListener('click', () => { this.todosWeekKey = shiftWeekKey(key, -1); this.refreshCard('todos'); });
        if (key !== isoWeekKey(now)) {
          const backW = head.createEl('button', { cls: 'kbwb-btn kbwb-todo-today', text: '回本周' });
          backW.addEventListener('click', () => { this.todosWeekKey = isoWeekKey(new Date()); this.refreshCard('todos'); });
        }
      }
      const openFile = head.createEl('button', {
        cls: 'kbwb-btn kbwb-todo-open', text: '打开文件',
        attr: { title: '在编辑器里打开 ' + this.plugin.todoFilePath(which) + '（分组标题就是 ' + (isDaily ? '日期' : 'ISO 周键') + '，可以直接手改）' },
      });
      openFile.addEventListener('click', () => this.plugin.openTodoFile(which));

      const listEl = body.createDiv({ cls: 'kbwb-todo-list' });
      const after = async () => {
        this.plugin._todosShared = null;
        await this.refreshTodoLinked();           // 红点与 chip 跟着这条待办的增/勾/删走
      };
      this.todoForm(listEl, which, key,
        isDaily ? '加一条到 ' + key.slice(5) + '…' : '加一条到 ' + key + '…', after);
      if (!items.length) {
        this.empty(listEl, isDaily
          ? '这天还没有待办。写一条，回车就存进「' + this.plugin.todoFilePath('daily') + '」。'
          : '本周还没有待办。周一起算，存进「' + this.plugin.todoFilePath('weekly') + '」。', 'list-checks');
        body.createDiv({ cls: 'kbwb-count kbwb-hint', text: '两篇清单直接在 Obsidian 里也能改｜' + this.plugin.todoFilePath('daily') + ' · ' + this.plugin.todoFilePath('weekly') });
        return;
      }
      const cap = clampInt(this.plugin.settings.todoLimit, 1, 200, 20);
      for (const it of items.slice(0, cap)) this.todoRow(listEl, which, it, after);
      if (items.length > cap) {
        listEl.createDiv({ cls: 'kbwb-count', text: '另有 ' + (items.length - cap) + ' 条在文件里' });
      }
      const done = items.length - open;
      body.createDiv({ cls: 'kbwb-count kbwb-hint', text: '共 ' + items.length + ' 条｜已勾 ' + done + '｜文件：' + this.plugin.todoFilePath(which) });
    };

    for (const [id, label] of [['daily', '每日'], ['weekly', '每周']]) {
      const b = tabs.createEl('button', { cls: 'kbwb-tab', text: label });
      b.dataset.m = id;
      b.addEventListener('click', () => paint(id));
    }
    if (!this.todosWeekKey) this.todosWeekKey = isoWeekKey(new Date());
    paint(mode);
  }

  /* ---------------------------------------------- 第二十轮：写作量 */

  async buildWritingCard(grid) {
    const c = this.card(grid, 'writing', null);
    const body = c.body;
    this.skeleton(body, 2);
    const s = await this.plugin.computeStats();
    if (!this.containerEl.isConnected) return;
    body.empty();
    const today = todayStr();
    const log = this.plugin.writingLog || {};
    const words = s && s.words;
    if (!Number.isFinite(words)) {
      this.empty(body, '写作量要算字数。设置 → 知识库工作台 → 打开「统计字数」即可。', 'trending-up');
      return;
    }
    // 今天用当前值（快照可能还是早上的），历史用快照；两天的差才是"那天写了多少"
    const valOf = (k) => (k === today ? words : log[k]);

    const big = body.createDiv({ cls: 'kbwb-write-big' });
    big.createSpan({ cls: 'kbwb-write-num', text: String(words) });
    big.createSpan({ cls: 'kbwb-write-unit', text: '字（全库累计' + (s.wordsCapped ? '，按前 ' + s.wordsScanned + ' 篇估' : '') + '）' });

    const keys = Object.keys(log).filter((k) => YMD_KEY.test(k)).sort();
    const yest = shiftDayStr(today, -1);
    const prevVal = valOf(yest);
    const dRow = body.createDiv({ cls: 'kbwb-write-delta' });
    if (!Number.isFinite(prevVal)) {
      dRow.createSpan({ text: '还没有昨天的基线 —— 快照每天存一次，明天起这里就是「今天写了多少」' });
    } else {
      const dd = words - prevVal;
      dRow.createSpan({ cls: 'kbwb-write-delta-num' + (dd < 0 ? ' is-neg' : ''), text: (dd > 0 ? '+' : '') + dd });
      dRow.createSpan({ text: '字 · 昨天净增（相对 ' + yest + ' 的快照）' });
    }

    const days = [];
    for (let i = 6; i >= 0; i--) {
      const k = shiftDayStr(today, -i);
      const a = valOf(k);
      const b = valOf(shiftDayStr(k, -1));
      const known = Number.isFinite(a) && Number.isFinite(b);
      days.push({ k, label: String(Number(k.slice(5, 7))) + '/' + String(Number(k.slice(8, 10))), value: known ? a - b : null });
    }
    const known = days.filter((x) => x.value !== null);
    if (!known.length) {
      this.empty(body, '要攒两天基线才有柱子。快照最多留 ' + clampInt(this.plugin.settings.writingKeep, 7, 730, 120) + ' 天（当前 ' + keys.length + ' 天）。', 'trending-up');
      c.setChip(keys.length + ' 天基线');
      return;
    }
    const bars = body.createDiv({ cls: 'kbwb-write-bars' });
    bars.createDiv({ cls: 'kbwb-subtitle', text: '近 7 天每天净增' });
    const max = Math.max.apply(null, known.map((x) => Math.abs(x.value)).concat([1]));
    for (const d of days) {
      const r = bars.createDiv({ cls: 'kbwb-write-bar-row' });
      r.createSpan({ cls: 'kbwb-write-bar-label', text: d.label });
      if (d.value === null) {
        // 「无基线」是文字，绝不能塞进轨道里：.kbwb-write-bar-track 只有 6px 且 overflow:hidden，
        // 9.5px 字体的行盒实测 12px ⇒ 上下各切掉 ~3px（真浏览器量到「被切 7px」），
        // 用户截图里那排残缺的字就是这个。轨道只属于真有柱子的那些天。
        r.createSpan({ cls: 'kbwb-write-bar-none', text: '无基线' });
      } else {
        const track = r.createDiv({ cls: 'kbwb-write-bar-track' });
        const fill = track.createDiv({ cls: 'kbwb-write-bar-fill' + (d.value < 0 ? ' is-neg' : '') });
        fill.style.width = Math.max(3, Math.round(Math.abs(d.value) / max * 100)) + '%';
        fill.setAttr('title', d.k + '：' + d.value + ' 字');
      }
      r.createSpan({ cls: 'kbwb-write-bar-val', text: d.value === null ? '—' : (d.value > 0 ? '+' + d.value : String(d.value)) });
    }
    const week = known.reduce((n, x) => n + x.value, 0);
    c.setChip('近 7 天 ' + (week > 0 ? '+' : '') + week + ' 字');
  }

  /* ---------------------------------------------- 通用：笔记行 */

  fileRow(host, file, note, cls) {
    const row = host.createDiv({ cls: (cls || 'kbwb-item') });
    row.dataset.path = file.path;          // ★ 点亮态要能就地更新（syncStars 靠它）
    const main = row.createDiv({ cls: 'kbwb-item-main' });
    main.createSpan({ cls: 'kbwb-item-name', text: file.basename });
    const meta = main.createDiv({ cls: 'kbwb-item-meta' });
    meta.createSpan({ cls: 'kbwb-item-dir', text: folderOf(file.path) || '（根目录）' });
    if (note) meta.createSpan({ cls: 'kbwb-item-note', text: ' · ' + note });
    main.setAttr('title', file.path);
    main.addEventListener('click', () => this.plugin.openFile(file));
    main.addEventListener('dblclick', () => this.plugin.openFile(file, undefined, 'split'));

    const star = row.createDiv({ cls: 'kbwb-star', attr: { title: '收藏到工作台' } });
    if (this.plugin.isPinned(file.path)) { star.addClass('is-on'); star.setAttr('title', '取消收藏'); }
    setIcon(star, 'star');
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      this.plugin.togglePin(file.path);
      this.afterPinsChanged();   // 只重建收藏卡；整版重绘会"闪一下回到最上面"
    });
    return row;
  }

  /* ---------------------------------------------- 局部刷新（避免整版重绘） */

  /**
   * 收藏/置顶变了：只重建收藏卡 + 就地更新其他卡里的 ★。
   * 走整版 render() 的话，host.empty() 让滚动高度瞬间塌成 0，
   * 浏览器把 scrollTop 夹到顶，用户看到的就是"闪一下回到最上面"。
   */
  async afterPinsChanged() {
    if (this.gesture || this.rendering) { this.render(); return; }
    const ok = await this.refreshCard('pinned');
    if (!ok) { this.render(); return; }
    this.syncStars();
  }

  /** 某张卡的卡体（长列表的滚动就发生在这里） */
  cardBodyOf(modId) {
    const grid = this.contentEl.find ? this.contentEl.find('.kbwb-grid') : null;
    if (!grid) return null;
    const card = Array.prototype.slice.call(grid.children || [])
      .find((c) => c.dataset && c.dataset.mod === modId);
    return card && card.find ? card.find('.kbwb-card-body') : null;
  }

  /** 重建前记下每张卡的滚动位置 */
  cardScrollMap() {
    const out = [];
    const grid = this.contentEl.find ? this.contentEl.find('.kbwb-grid') : null;
    if (!grid) return out;
    for (const c of Array.prototype.slice.call(grid.children || [])) {
      const id = c.dataset && c.dataset.mod;
      const body = c.find ? c.find('.kbwb-card-body') : null;
      if (id && body && body.scrollTop) out.push([id, body.scrollTop]);
    }
    return out;
  }

  restoreCardScroll(map) {
    for (const pair of (map || [])) {
      const body = this.cardBodyOf(pair[0]);
      if (body) body.scrollTop = pair[1];
    }
  }

  /**
   * 勾完任务：只重建任务卡（refreshCard 内部会保住它的滚动位置），
   * 不再整版重绘、也不再 invalidate 统计缓存 —— 那两样合起来就是
   * "卡一下 + 跳回列表最上面"。
   * 统计卡上的"今日修改"会晚一步：写文件触发的库事件在 1.2s 后 bump 一次刷新，
   * 60s 自动刷新也会补上。
   */
  async afterTaskToggle() {
    if (this.gesture || this.rendering) { this.render(); return; }
    const ok = await this.refreshCard('tasks');
    if (!ok) { this.render(); return; }
    await this.refreshCard('due');   // 到期日历显示的是同一批任务；那张卡没显示时返回 false，无害
    if (this.barTodoEl && this.barTodoEl.isConnected) {
      this.barTodoEl.setText(String(this.plugin.lastTaskCount || 0) + ' 待办');
    }
  }

  /** 其他卡里已渲染的行：★ 点亮态跟着收藏清单走 */
  syncStars() {
    const pins = this.plugin.pinnedPaths();
    const rows = this.contentEl.findAll('.kbwb-item, .kbwb-res, .kbwb-fileleaf');
    for (const row of rows) {
      const p = row.dataset && row.dataset.path;
      if (!p) continue;
      const star = row.find('.kbwb-star');
      if (!star) continue;
      const on = pins.indexOf(p) >= 0;
      star.toggleClass('is-on', on);
      star.setAttr('title', on ? '取消收藏' : '收藏到工作台');
    }
  }

  /** 只重建一张卡（串行：连点 ★ / 📌 时两次重建会互相把对方刚插好的节点摘掉） */
  refreshCard(modId) {
    const run = () => this._refreshCardNow(modId);
    this._cardChain = (this._cardChain || Promise.resolve()).then(run, run);
    return this._cardChain;
  }

  async _refreshCardNow(modId) {
    const grid = this.contentEl.find ? this.contentEl.find('.kbwb-grid') : null;
    if (!grid) return false;
    const kids = Array.prototype.slice.call(grid.children || []);
    const idx = kids.findIndex((c) => c.dataset && c.dataset.mod === modId);
    if (idx < 0) return false;
    const old = kids[idx];
    // 这张卡自己的滚动位置（勾完一条任务、点完一次收藏都要保住）
    const oldBody = old.find ? old.find('.kbwb-card-body') : null;
    const keepTop = oldBody ? oldBody.scrollTop : 0;
    const slot = this.plugin.slotOf(modId);
    const stage = document.createElement('div');
    this._tasksShared = null;   // 单卡重建 = 用户刚改过数据，必须重扫，不复用上一轮结果
    this.plugin._todosShared = null;
    try {
      if (slot.collapsed) this.buildCollapsedCard(stage, slot);
      else {
        const fn = BUILDERS[modId];
        if (!fn || typeof this[fn] !== 'function') return false;
        await this[fn](stage);
      }
    } catch (err) {
      console.error('[kb-workbench] 单卡重建失败', modId, err);
      return false;
    }
    const fresh = Array.prototype.slice.call(stage.children || [])
      .find((c) => c.dataset && c.dataset.mod === modId);
    if (!fresh) return false;
    // 替换不是入场：新节点不许再播 kbwb-rise。
    // （宿主首屏之后一直带 .kbwb-animate，只有下一次整版渲染才摘；而 card() 给每个新节点
    //  写了 --i，于是点一次月历就把这张卡从 opacity:0 淡入一遍 = 用户看到的「闪一下」。）
    fresh.addClass('kbwb-no-rise');
    fresh.style.setProperty('--i', '0');
    // 同帧换入：旧的还挂着时先插新的，再摘旧的，网格高度不塌
    if (kids[idx + 1]) grid.insertBefore(fresh, kids[idx + 1]);
    else grid.appendChild(fresh);
    grid.removeChild(old);
    if (keepTop) {
      const nb = fresh.find ? fresh.find('.kbwb-card-body') : null;
      if (nb) nb.scrollTop = keepTop;
    }
    this.cardIndex = (this.cardIndex || 0) + 1;
    return true;
  }
}

/**
 * metadataCache 的兜底：文件刚被写入（我们勾任务、或你在编辑器里改）时，
 * Obsidian 会先清掉它的缓存再重新解析，这个窗口里 getFileCache 返回 null，
 * 于是【整篇文档的任务一起消失】，几百毫秒后又冒出来（用户实测到的现象）。
 * 正文本来就已经读在手，直接按行找任务行，不再依赖缓存。
 */
function scanTaskLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([-*+])[ \t]\[( |x|X|-)\]/);
    if (m) out.push({ task: m[3], position: { start: { line: i } } });
  }
  return out;
}

function isTodayTask(t, today, t0) {
  if (t.done) return false;
  if (t.markers.due === today) return true;
  if (t.markers.scheduled === today) return true;
  if (/#today\b/i.test(t.body)) return true;
  if (t.body.indexOf(today) >= 0) return true;
  // 日记/日程笔记的文件名或路径里带今天日期，也算今天的任务
  return t.file.path.indexOf(today) >= 0;
}

/* ================================================================ 弹窗 */

/**
 * 「新建笔记」确认框。
 * 第 5 个参数 opts 给了模板能力（用户要"选择模板 + 新增模板"）：
 *   opts = { dir, listTemplates(), readTemplate(path), onCreateTemplate(name, basePath) }
 * 给了 opts ⇒ 回调结果是 { name, template }（template = 模板路径或 ''=不用模板）；
 * 没给 ⇒ 保持老行为，回调一个标题字符串（月历那条路、createNoteFlow 都靠这个）。
 */
class NameModal extends Modal {
  constructor(app, initial, onDone, hint, opts) {
    super(app);
    this.initial = initial || '';
    this.onDone = onDone;
    this.hint = hint || '';
    this.opts = opts || null;
    this.result = null;
    this.chosen = '';            // 选中的模板路径
  }

  onOpen() {
    const { contentEl } = this;
    const asTpl = !!(this.opts && this.opts.asTemplate);
    contentEl.createEl('h3', { text: asTpl ? '新增模板' : '新建笔记', cls: 'kbwb-modal-title' });
    if (this.hint) contentEl.createEl('p', { text: this.hint, cls: 'kbwb-modal-hint' });
    const input = contentEl.createEl('input', { cls: 'kbwb-input', type: 'text', placeholder: asTpl ? '模板名' : '笔记标题' });
    input.value = this.initial;
    this.inputEl = input;          // 模板列表里的「新增模板」要拿这个标题当默认模板名（踩过：闭包里拿不到 input）

    if (this.opts && this.opts.listTemplates) this.buildTemplatePicker(contentEl);

    const row = contentEl.createDiv({ cls: 'kbwb-modal-row' });
    const ok = row.createEl('button', { text: '创建', cls: 'mod-cta' });
    row.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    const submit = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      this.result = this.opts ? { name: v, template: this.chosen } : v;
      this.close();
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') this.close();
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  /**
   * 模板列表：列出模板目录里所有 .md，末尾「＋ 新增模板」，
   * 点它在同一个目录下建模板文件、建完自动选中。
   * opts.allowNone === false ⇒ 不再插那一行**合成的**「不用模板 / 默认（当天任务模板）」
   * （用户②："列表就等于模板库的那几个文件，选哪个用哪个"）；
   * 这时开局的落点由 opts.selected 决定 —— 以前 refresh() 硬写 chosen=''，selected 根本进不来。
   */
  buildTemplatePicker(contentEl) {
    const box = contentEl.createDiv({ cls: 'kbwb-modal-tpls' });
    const allowNone = this.opts.allowNone !== false;
    const head = box.createDiv({ cls: 'kbwb-modal-tpls-head' });
    head.createSpan({ cls: 'kbwb-modal-label', text: '模板（' + (this.opts.dir || '库根') + '）：' });
    const list = box.createDiv({ cls: 'kbwb-modal-tpls-list' });

    const mkRow = (label, path, title) => {
      const r = list.createDiv({ cls: 'kbwb-modal-tplrow' + (this.chosen === path ? ' is-on' : '') });
      r.createSpan({ cls: 'kbwb-modal-tplrow-name', text: label });
      r.setAttr('title', title || path || '');
      r.addEventListener('click', () => {
        this.chosen = path;
        list.findAll('.kbwb-modal-tplrow').forEach((x) => x.toggleClass('is-on', x === r));
      });
      return r;
    };

    // inline 小表单只建一次（以前放在 refresh 里，每重画一次列表就多一份）
    const form = box.createDiv({ cls: 'kbwb-modal-newtpl' });
    form.style.display = 'none';
    const nameInput = form.createEl('input', { cls: 'kbwb-input kbwb-modal-newtpl-name', type: 'text', placeholder: '新模板名' });
    const okBtn = form.createEl('button', { cls: 'kbwb-btn', text: '建模板' });
    form.createEl('button', { cls: 'kbwb-btn kbwb-btn-ghost', text: '取消' })
      .addEventListener('click', () => { form.style.display = 'none'; });
    const reveal = () => {
      form.style.display = '';
      const t = String((this.inputEl && this.inputEl.value) || '').trim();
      nameInput.value = t ? t + ' 模板' : '';
      if (typeof nameInput.focus === 'function') nameInput.focus();
    };

    const refresh = () => {
      list.empty();
      const items = this.opts.listTemplates() || [];
      // 开局的选中：调用方给的那份（月历 = 设置「当日任务模板」指向的真实文件）。
      // 它必须真的在列表里，否则回到"没选"（allowNone:false 时没有任何一行该亮着）。
      const want = String(this.opts.selected || '');
      this.chosen = items.some((f) => f.path === want) ? want : '';
      if (allowNone) mkRow(this.opts.noneLabel || '不用模板', '', this.opts.noneHint || '直接建空白笔记');
      for (const f of items) mkRow(f.basename, f.path, f.path);
      if (!items.length) list.createDiv({ cls: 'kbwb-modal-tplrow is-empty', text: '（这个目录下还没有模板）' });
      const add = list.createDiv({ cls: 'kbwb-modal-tplrow kbwb-modal-tplrow-new' });
      add.createSpan({ cls: 'kbwb-modal-tplrow-name', text: '＋ 新增模板' });
      add.setAttr('title', '在同一个模板目录下新建一个模板：当前选中的那份是底子，建好自动选中');
      add.addEventListener('click', reveal);
    };

    const doCreate = async () => {
      const nm = String(nameInput.value || '').trim();
      if (!nm) { if (typeof nameInput.focus === 'function') nameInput.focus(); return; }
      const base = this.chosen || '';
      const f = await this.opts.onCreateTemplate(nm, base);
      if (f) {
        refresh();                       // 先重画列表（会把选中重置成开局那一份）
        this.chosen = f.path;            // 再把新模板选上：建完就能直接用
        list.findAll('.kbwb-modal-tplrow').forEach((r) => r.toggleClass('is-on', r.getAttr('title') === f.path));
        new Notice('模板已建并选中：' + f.basename + (base ? '（底子来自 ' + base.split('/').pop() + '）' : ''));
      }
      form.style.display = 'none';
    };
    okBtn.addEventListener('click', doCreate);
    nameInput.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') doCreate(); });

    refresh();
  }

  onClose() {
    this.contentEl.empty();
    if (this.onDone) { const cb = this.onDone; this.onDone = null; cb(this.result); }
  }
}

/**
 * 月历点"已经建过笔记"的那一天：列出那天从月历建的所有笔记，
 * 点一行进去，或者按「新增笔记」在同一天下面再建一篇（用户要的选择权）。
 * 回调结果：{ open: TFile } / { create: true } / null（关闭）
 */
class DayNotesModal extends Modal {
  constructor(app, key, notes, onDone) {
    super(app);
    this.key = key;
    this.notes = notes || [];
    this.onDone = onDone;
    this.result = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.key + ' · 已建 ' + this.notes.length + ' 篇', cls: 'kbwb-modal-title' });
    contentEl.createEl('p', { text: '点一篇进去；或按「新增笔记」在这一天下面再建一篇。', cls: 'kbwb-modal-hint' });
    const list = contentEl.createDiv({ cls: 'kbwb-daylist' });
    for (const f of this.notes) {
      const row = list.createDiv({ cls: 'kbwb-dayrow' });
      row.createSpan({ cls: 'kbwb-dayrow-name', text: f.basename });
      row.createSpan({ cls: 'kbwb-time', text: folderOf(f.path) || '根目录' });
      row.setAttr('title', f.path);
      row.addEventListener('click', () => { this.result = { open: f }; this.close(); });
    }
    const row = contentEl.createDiv({ cls: 'kbwb-modal-row' });
    row.createEl('button', { text: '新增笔记', cls: 'mod-cta' }).addEventListener('click', () => {
      this.result = { create: true }; this.close();
    });
    row.createEl('button', { text: '关闭' }).addEventListener('click', () => this.close());
    setTimeout(() => { const first = list.find ? list.find('.kbwb-dayrow') : null; if (first && typeof first.focus === 'function') first.focus(); }, 30);
  }

  onClose() {
    this.contentEl.empty();
    if (this.onDone) { const cb = this.onDone; this.onDone = null; cb(this.result); }
  }
}

class TemplateModal extends SuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder('输入模板名，回车新建笔记');
  }

  getSuggestions(query) {
    const q = (query || '').toLowerCase();
    return this.plugin.listTemplates()
      .filter((f) => !q || f.path.toLowerCase().indexOf(q) >= 0)
      .slice(0, 40);
  }

  renderSuggestion(file, el) {
    el.createEl('div', { text: file.basename, cls: 'kbwb-sug-name' });
    el.createEl('div', { text: folderOf(file.path) || '（根目录）', cls: 'kbwb-sug-sub' });
  }

  onChooseSuggestion(file) {
    this.plugin.createNoteFlow({ template: file.path, folder: this.plugin.settings.newNoteFolder });
  }
}

/* ================================================================ 插件 */

class KbWorkbenchPlugin extends Plugin {
  async onload() {
    await this.loadAll();

    this.recentMode = 'edited';
    this.statsCache = null;
    this.statsJob = null;

    this.registerView(VIEW_TYPE, (leaf) => new WorkbenchView(leaf, this));
    this.addRibbonIcon('layout-dashboard', '知识库工作台', () => this.activateView());

    this.addCommand({ id: 'open-workbench', name: '打开工作台', callback: () => this.activateView() });
    this.addCommand({
      id: 'refresh-workbench', name: '刷新工作台',
      checkCallback: (checking) => {
        const has = this.app.workspace.getLeavesOfType(VIEW_TYPE).length > 0;
        if (checking) return has;
        if (has) this.refreshViews(true);
      },
    });
    this.addCommand({
      id: 'close-workbench', name: '关闭工作台',
      checkCallback: (checking) => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (checking) return leaves.length > 0;
        leaves.forEach((l) => l.detach());
      },
    });
    this.addCommand({
      id: 'stick-current', name: '把当前笔记置顶／取消置顶（自动进收藏）',
      editorCallback: (editor, view) => {
        if (view && view.file instanceof TFile) { this.toggleStick(view.file.path); this.refreshPins(); }
        else new Notice('当前没有打开的笔记');
      },
    });
    this.addCommand({ id: 'new-from-template', name: '从模板新建笔记', callback: () => new TemplateModal(this.app, this).open() });
    this.addCommand({ id: 'new-daily', name: '新建或打开今日笔记', callback: () => this.createDailyNote() });
    this.addCommand({
      id: 'new-daily-tasks', name: '建立今天的「当日任务」笔记（按模板填当天任务）',
      callback: () => this.openOrCreateDailyOn(new Date()),
    });
    this.addCommand({ id: 'new-note', name: '新建笔记', callback: () => this.createNoteFlow({ folder: this.settings.newNoteFolder }) });
    this.addCommand({
      id: 'pin-current', name: '把当前笔记收藏／取消收藏到工作台',
      editorCallback: (editor, view) => {
        if (view && view.file instanceof TFile) { this.togglePin(view.file.path); this.refreshPins(); }
        else new Notice('当前没有打开的笔记');
      },
    });

    this.registerEvent(this.app.workspace.on('file-open', (file) => this.trackOpen(file)));

    const bump = debounce(() => this.refreshViews(false), 1200, true);
    this.bump = bump;
    for (const ev of ['create', 'modify', 'delete', 'rename']) {
      this.registerEvent(this.app.vault.on(ev, (file, oldPath) => {
        // 改名/移动：先把以路径为键的状态搬过去，再让日期前缀索引失效（用户：「改了名字就不算日记了」）
        if (ev === 'rename') this.onVaultRename(file, oldPath);
        this.invalidateDailyCache();
        bump();
      }));
    }
    try { this.registerEvent(this.app.metadataCache.on('resolved', () => bump())); } catch (e) { /* 老版本无此事件 */ }

    if (this.settings.autoRefresh > 0) {
      this.registerInterval(window.setInterval(() => {
        this.refreshViews(true);
        this.snapshotWriting();      // 写作量快照：放定时器里，不放 render()
      }, Math.max(20, this.settings.autoRefresh) * 1000));
    }

    this.addSettingTab(new WorkbenchSettingTab(this.app, this));
    this.loadConfigs().then(() => {
      // 改名可能发生在插件没运行的时候（外部工具/同步盘/换设备），rename 事件补不回来 ⇒ 启动补一次
      this.repairDailyNotes();
      return this.snapshotWriting();
    }).catch(() => {});

    // 只在装好后的第一次启动自动打开；之后由用户点左侧图标或命令
    if (!this.firstDone) {
      this.app.workspace.onLayoutReady(() => {
        this.firstDone = true;
        this.persist();
        this.activateView();
      });
    }
  }

  onunload() {
    this.persist();
  }

  /* ---------------------------------------------- 数据读写（一份 data.json） */

  async loadAll() {
    const raw = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (raw[k] !== undefined) this.settings[k] = raw[k];
    }
    if (!Array.isArray(this.settings.quickButtons)) this.settings.quickButtons = [];
    this.settings.quickButtons = this.settings.quickButtons
      .filter((b) => b && typeof b === 'object')
      .map((b) => ({ label: String(b.label || ''), folder: String(b.folder || ''), template: String(b.template || ''), prefix: !!b.prefix }));
    // 坐标刻度升级：12 栏 → 24 栏（缩放粒度减半）。旧配置一次性换算，视觉位置/宽度不变：
    // 旧 col c 的起点在 (c-1)/12，换成 24 栏就是第 2(c-1)+1 条线；宽度 w 直接翻倍。
    const rawScale = Number(raw.layoutScale) || 12;
    if (rawScale !== GRID_COLS) {
      const k = GRID_COLS / rawScale;
      this.settings.layout = (Array.isArray(this.settings.layout) ? this.settings.layout : []).map((s) => {
        if (!s || typeof s !== 'object') return s;
        const out = Object.assign({}, s);
        if (Number.isFinite(out.col) && out.col >= 1) out.col = Math.round((out.col - 1) * k) + 1;
        if (Number.isFinite(out.w) && out.w >= 1) out.w = Math.round(out.w * k);
        return out;
      });
      this.settings.layoutScale = GRID_COLS;
    }
    // 新模块补位一次性写回 settings.layout：否则每次 layoutList() 都要重跑一遍 autoPack
    // （实测：8→13 张卡后 layoutList() 单次 0.005ms → 0.324ms，而每张卡都要调它好几次）
    this.settings.layout = this.layoutList();
    this.recentOpenedList = Array.isArray(raw.opened) ? raw.opened.filter((x) => x && x.path) : [];
    this.pins = Array.isArray(raw.pins) ? raw.pins.filter((x) => typeof x === 'string') : [];
    // 置顶是收藏的子集（钉在收藏卡顶部、不随列表滚走）；老数据没有这个字段就是空
    this.sticks = Array.isArray(raw.sticks) ? raw.sticks.filter((x) => typeof x === 'string') : [];
    // 写作量快照：{ 'YYYY-MM-DD': 字数 }。只留合法日期键，脏数据当没有
    // 月历上"这天用的是哪篇笔记"（用户在确认框里改过标题的那些天）；文件没了就丢掉
    // 一天可以有多篇（月历列表里能"再建一篇"）；老数据是"一天一篇"的字符串 ⇒ 自动转成数组
    this.dailyNotes = (raw.dailyNotes && typeof raw.dailyNotes === 'object' && !Array.isArray(raw.dailyNotes))
      ? Object.keys(raw.dailyNotes).filter((k) => YMD_KEY.test(k)).reduce((acc, k) => {
          const v = raw.dailyNotes[k];
          const arr = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x);
          if (arr.length) acc[k] = arr;
          return acc;
        }, {})
      : {};
    this.writingLog = (raw.writingLog && typeof raw.writingLog === 'object' && !Array.isArray(raw.writingLog))
      ? Object.keys(raw.writingLog).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
          .reduce((acc, k) => { const n = Number(raw.writingLog[k]); if (Number.isFinite(n) && n >= 0) acc[k] = n; return acc; }, {})
      : {};
    this.firstDone = !!raw.firstDone;
  }

  async saveSettings() { await this.persist(); }

  /* ---------------------------------------------- 自由网格布局（坐标 / 尺寸 / 显隐 / 折叠） */

  layoutList() {
    const saved = Array.isArray(this.settings.layout) ? this.settings.layout : [];
    const out = [];
    const used = new Set();
    let needsPack = false;

    for (const s of saved) {
      const mod = MODULES.find((m) => m.id === (s && s.id));
      if (!mod || used.has(mod.id)) continue;
      used.add(mod.id);
      const w = clampInt(s.w, MIN_W, GRID_COLS, mod.dw);
      const h = clampInt(s.h, MIN_H, 400, mod.dh);
      const col = parseInt(s.col, 10);
      const row = parseInt(s.row, 10);
      if (!(col >= 1) || !(row >= 1)) needsPack = true;
      out.push({
        id: mod.id, w, h,
        col: col >= 1 ? Math.min(col, GRID_COLS - w + 1) : 0,
        row: row >= 1 ? row : 0,
        on: s.on !== false,
        collapsed: !!s.collapsed,
      });
    }
    for (const mod of MODULES) {
      if (used.has(mod.id)) continue;
      out.push({ id: mod.id, w: mod.dw, h: mod.dh, col: 0, row: 0, on: true, collapsed: false });
      needsPack = true;
    }
    // 有缺坐标就补排一次（旧版只有 span 的配置也走这条路，等于自动迁移）。
    // 但已有合法坐标的卡必须当"不许动的盒子"传进去：autoPack 不带 pins 时
    // 会给【每一个】未固定项重排 —— 那样加一张新卡就把用户摆好的整版布局推倒了。
    if (needsPack) autoPack(out, GRID_COLS, out.filter((s) => s.col >= 1 && s.row >= 1));
    return out;
  }

  slotOf(id) {
    return this.layoutList().find((s) => s.id === id) || { id, w: 4, h: 30, col: 1, row: 1, on: true, collapsed: false };
  }

  mutateLayout(fn) {
    const l = this.layoutList();
    fn(l);
    this.settings.layout = l;
    return this.persist();
  }

  /** 改坐标或尺寸（拖动/缩放结束时调用） */
  setBox(id, patch) {
    return this.mutateLayout((l) => {
      const s = l.find((x) => x.id === id);
      if (!s) return;
      if (patch.col !== undefined) s.col = Math.max(1, Math.min(GRID_COLS - s.w + 1, patch.col));
      if (patch.row !== undefined) s.row = Math.max(1, patch.row);
      if (patch.w !== undefined) {
        s.w = clampInt(patch.w, MIN_W, GRID_COLS, s.w);
        s.col = Math.max(1, Math.min(s.col, GRID_COLS - s.w + 1));
      }
      if (patch.h !== undefined) s.h = clampInt(patch.h, MIN_H, 400, s.h);
    });
  }

  setModuleOn(id, on) { return this.mutateLayout((l) => { const s = l.find((x) => x.id === id); if (s) s.on = !!on; }); }
  setCollapsed(id, v) { return this.mutateLayout((l) => { const s = l.find((x) => x.id === id); if (s) s.collapsed = !!v; }); }

  /** 自动排列：保留当前尺寸，按顺序重新装箱（消除重叠）；forceFull 用于窄栏 */
  tidyLayout(forceFull) {
    return this.mutateLayout((l) => {
      if (forceFull) l.forEach((s) => { s.w = GRID_COLS; s.col = 1; });
      autoPack(l, GRID_COLS);
    });
  }

  /** 碰撞消解：新落点压住谁，就把谁缩小/让位（独立入口，供设置页与测试调用） */
  resolveOverlaps(movedId) {
    return this.mutateLayout((l) => resolveOverlapsIn(l, movedId));
  }

  /**
   * 拖动落位：写坐标 + 消解重叠合并成一次落盘。
   * 分两次写会先把"压住别人"的中间态存进 data.json，
   * 中途刷新/重启就看到两张卡叠在一起。
   */
  commitDrop(id, patch) {
    return this.mutateLayout((l) => {
      const s = l.find((x) => x.id === id);
      if (!s) return;
      if (patch.col !== undefined) s.col = Math.max(1, Math.min(GRID_COLS - s.w + 1, patch.col));
      if (patch.row !== undefined) s.row = Math.max(1, patch.row);
      resolveOverlapsIn(l, id);
    });
  }

  /**
   * 缩放结束：写尺寸 + 消解重叠，合并成一次落盘（和 commitDrop 同一套路）。
   * 以前只调 setBox ⇒ 放大那张直接压在邻居身上，别人一点都不让位（用户报的就是这个）。
   * `setBox` 故意保持"裸写"：设置页要能手动把两张卡摆到同一格（自由放置允许），
   * 消解只在这两个"用户明确要变大"的入口里做（拖边/拖角、⋯ 菜单的尺寸预设）。
   */
  commitResize(id, patch) {
    return this.mutateLayout((l) => {
      const s = l.find((x) => x.id === id);
      if (!s) return;
      if (patch.w !== undefined) {
        s.w = clampInt(patch.w, MIN_W, GRID_COLS, s.w);
        s.col = Math.max(1, Math.min(s.col, GRID_COLS - s.w + 1));
      }
      if (patch.h !== undefined) s.h = clampInt(patch.h, MIN_H, 400, s.h);
      resolveOverlapsIn(l, id);
    });
  }

  /** 窄栏（单列堆叠）按位置重排：DOM 顺序就是显示顺序，否则拖动换序看不出来 */
  sortLayoutByPosition() {
    return this.mutateLayout((l) => {
      l.sort((a, b) => (a.row - b.row) || (a.col - b.col));
    });
  }


  resetLayout() {
    this.settings.layout = [];
    return this.persist();
  }

  hiddenModules() { return this.layoutList().filter((s) => !s.on); }

  /* ---------------------------------------------- 字体 */

  applyFonts(host) {
    const ui = FONT_UI[this.settings.uiFont || ''] || '';
    const num = FONT_NUM[this.settings.numFont === undefined ? 'Consolas' : (this.settings.numFont || '')] || '';
    if (ui) host.style.setProperty('--kbwb-ui', ui); else host.style.removeProperty('--kbwb-ui');
    if (num) host.style.setProperty('--kbwb-num', num); else host.style.removeProperty('--kbwb-num');
  }

  async persist() {
    const payload = Object.assign({}, this.settings, {
      opened: this.recentOpenedList, pins: this.pins, sticks: this.sticks || [], firstDone: !!this.firstDone,
      writingLog: this.writingLog && typeof this.writingLog === 'object' ? this.writingLog : {},
      dailyNotes: this.dailyNotes && typeof this.dailyNotes === 'object' ? this.dailyNotes : {},
    });
    try { await this.saveData(payload); } catch (e) { console.error('[kb-workbench] 保存失败', e); }
  }

  /* ---------------------------------------------- 视图控制 */

  openSettings() {
    const s = this.app.setting;
    if (s && typeof s.open === 'function') {
      s.open();
      if (typeof s.openTabById === 'function') s.openTabById(PLUGIN_ID);
    }
  }

  activateView() {
    const where = this.settings.openWhere || 'left';
    if (where === 'main') {
      const leaf = this.app.workspace.getLeaf('tab');
      leaf.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
      return leaf;
    }
    // ensureSideLeaf 负责"已存在就复用、不存在就创建"
    return this.app.workspace.ensureSideLeaf(VIEW_TYPE, where === 'right' ? 'right' : 'left', {
      active: true, reveal: true,
    });
  }

  /** 停靠位置改了：把视图从旧位置摘掉再按新位置打开 */
  relocateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (!leaves.length) return null;
    const where = this.settings.openWhere || 'left';
    const wantDock = where !== 'main';
    let inDock = false;
    try {
      inDock = !!(leaves[0].containerEl && leaves[0].containerEl.closest &&
        leaves[0].containerEl.closest('.workspace-sidedock'));
    } catch (e) { inDock = false; }
    if (inDock === wantDock) return this.activateView();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    return this.activateView();
  }

  refreshViews(invalidateStats) {
    if (invalidateStats) { this.statsCache = null; this.statsJob = null; this.hygieneCache = null; }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof WorkbenchView) view.render();
    }
  }

  /* ---------------------------------------------- 最近编辑 / 打开 */

  recentEdited() {
    const n = clampInt(this.settings.recentCount, 1, 50, 8);
    return this.app.vault.getMarkdownFiles().slice()
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, n)
      .map((f) => ({ file: f, time: f.stat.mtime }));
  }

  recentOpened() {
    const n = clampInt(this.settings.openedCount, 1, 40, 6);
    const out = [];
    for (const item of this.recentOpenedList) {
      const f = this.app.vault.getFileByPath(normalizePath(item.path));
      if (f) out.push({ file: f, path: item.path, time: item.time });
      if (out.length >= n) break;
    }
    return out;
  }

  /** 每日回顾：14 天以上没动过的笔记，按日期固定打散取 3 篇 */
  reviewPicks() {
    const cutoff = Date.now() - 14 * 86400000;
    const seed = todayStr().replace(/-/g, '');
    const pool = this.app.vault.getMarkdownFiles().filter((f) => {
      if (f.stat.mtime >= cutoff) return false;
      if (this.isTemplateFile(f)) return false;
      return !this.isExcludedPath(f.path);
    });
    return pool
      .slice()
      .sort((a, b) => hashStr(a.path + seed) - hashStr(b.path + seed))
      .slice(0, 3)
      .map((f) => ({ file: f, time: f.stat.mtime }));
  }

  /** 笔记体检：空笔记 / 无标签 / 无入链，缓存到 statsCache 同级的字段 */
  computeHygiene() {
    if (this.hygieneCache) return this.hygieneCache;
    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      if (this.isExcludedPath(f.path)) return false;
      return !this.isTemplateFile(f);
    });

    const inlinks = new Map();
    const links = this.app.metadataCache.resolvedLinks || {};
    for (const src of Object.keys(links)) {
      const targets = links[src] || {};
      for (const t of Object.keys(targets)) inlinks.set(t, (inlinks.get(t) || 0) + 1);
    }

    const empty = [], untagged = [], orphan = [];
    for (const f of files) {
      const size = f.stat.size || 0;
      if (size <= 320) empty.push(f);
      const cache = this.app.metadataCache.getFileCache(f);
      const tags = cache ? (getAllTags(cache) || []) : [];
      if (!tags.length) untagged.push(f);
      if (!inlinks.has(f.path)) orphan.push(f);
    }
    const byTime = (a, b) => b.stat.mtime - a.stat.mtime;
    this.hygieneCache = {
      total: files.length,
      empty: empty.sort(byTime),
      untagged: untagged.sort(byTime),
      orphan: orphan.sort(byTime),
    };
    return this.hygieneCache;
  }

  /** 单个文件的"缓存 vs 磁盘"判定（纯函数，测试直接喂假 item） */
  scanClassify(item) {
    const out = [];
    if (!item || !item.indexed) return ['notIndexed'];
    if (item.noCache) out.push('noCache');
    if ((item.ownTags || []).length && !(item.cacheTags || []).length) out.push('tagMissed');
    if ((item.cacheTags || []).length && !(item.ownTags || []).length) out.push('tagExtra');
    return out;
  }

  /**
   * 从文件系统列出磁盘上的 .md（全盘扫描用）。两条真机教训写在这里：
   *   · 库根的写法各版本不一（`''` 与 `'/'` 都有人在用）⇒ 两种都试，取列得出更多的那种。
   *   · **`recursive=true` 这个标志不一定被遵守**：真机实测 `adapter.list('/', true)` 只回了库根
   *     那一层的 1 篇 .md（整库 770 篇），所以这里**自己逐层下钻**，每层只 `list(dir, false)`。
   * 返回 { md, dirs, via, failed }。
   */
  async listDiskMarkdown(root) {
    const adapter = this.app.vault.adapter;
    const rel = (p) => String(p || '').replace(/^\/+/, '');
    const wantAtLeast = (this.app.vault.getMarkdownFiles() || []).length;   // 索引篇数是"列全了没有"的参照
    const starts = root ? [root] : ['', '/'];
    let best = null;
    for (const start of starts) {
      const md = new Set();
      const seenDir = new Set();
      const stack = [rel(start)];
      let failed = false;
      for (let guard = 0; stack.length && guard < 4000; guard++) {
        const dir = stack.pop();
        if (seenDir.has(dir)) continue;
        seenDir.add(dir);
        let got = null;
        try { got = await adapter.list(dir, false); }
        catch (e) { failed = true; break; }
        // 有的版本回全路径、有的回这一层的名字 —— 统一补上所在目录的前缀
        const pre = (p) => { const q = rel(p); return (!dir || q === dir || q.indexOf(dir + '/') === 0) ? q : dir + '/' + q; };
        for (const f of (((got && got.files) || []))) { const q = pre(f); if (/\.md$/i.test(q)) md.add(q); }
        for (const x of (((got && got.folders) || []))) stack.push(pre(x));
      }
      const out = { md: Array.from(md), dirs: seenDir.size, via: start || '（空串）', failed };
      if (!best || out.md.length > best.md.length) best = out;
      if (best.md.length >= wantAtLeast) break;    // 已经不少于索引 ⇒ 不用再试第二种根写法
    }
    return best;
  }

  /**
   * 全盘扫描（第二十二轮）：从【文件系统】出发，而不是 Obsidian 的索引与缓存，
   * 看体检卡（那三份按缓存算出来的清单）有没有漏掉的东西。
   *   · notIndexed  磁盘上有这个 .md，Obsidian 却没索引它（隐藏目录、"已排除的文件"、以 . 开头）
   *   · noCache     索引里有、metadata 缓存还没上（这篇的标签/链接在体检里等于不存在）
   *   · tagMissed   缓存说没标签，正文里其实有 #标签 或 YAML tags
   *   · tagExtra    缓存说有标签，自己解析却没找到（两边口径不一致，也要报出来）
   *   · orphanDiff  缓存认为没有任何笔记链到它，但扫描范围内的正文里确实链了它
   * 只在用户按按钮时跑，绝不进 render()（一次要读几百上千个文件）。只读，不写任何文件。
   */
  async fullScan(onProgress, shouldStop) {
    const t0 = Date.now();
    const root = normDir(this.settings.scanRoot);        // 留空 = 整库（不能用 normalizePath 判空，见 normDir 的注释）
    const cap = clampInt(this.settings.scanCap, 1, 200000, 3000);   // 设置页里限 100–20000；这里只保证是个正数，方便小库/测试也能验证截断
    const res = {
      at: t0, root: root || '（整库）', disk: 0, scanned: 0, indexed: 0, capped: false,
      stopped: false, error: '', seconds: 0, dirs: 0, via: '', lessThanIndex: 0,
      notIndexed: [], noCache: [], tagMissed: [], tagExtra: [], orphanDiff: [],
    };
    const done = (x) => { x.seconds = Math.round((Date.now() - t0) / 100) / 10; this.lastScan = x; return x; };
    const adapter = this.app.vault.adapter;
    if (!adapter || typeof adapter.list !== 'function') {
      res.error = '这个 Obsidian 版本没有 vault.adapter.list，全盘扫描用不了';
      return done(res);
    }
    const listed = await this.listDiskMarkdown(root);
    res.dirs = listed.dirs; res.via = listed.via;
    if (!listed.md.length && listed.failed) {
      res.error = '读目录失败：vault.adapter.list 抛错（' + (root || '整库') + '）';
      return done(res);
    }
    const diskMd = listed.md;
    res.indexed = (this.app.vault.getMarkdownFiles() || []).length;
    // 磁盘比索引还少 = 列表方式坏了（正常情况磁盘 ⊇ 索引：隐藏/被排除的文件只在磁盘上）
    if (diskMd.length < res.indexed) res.lessThanIndex = res.indexed - diskMd.length;
    res.disk = diskMd.length;
    if (diskMd.length > cap) { res.capped = true; diskMd.length = cap; }

    const indexedByPath = new Map();
    for (const f of this.app.vault.getMarkdownFiles()) indexedByPath.set(normalizePath(f.path), f);
    const pathByBase = new Map();
    for (const p of diskMd) {
      const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
      if (!pathByBase.has(base)) pathByBase.set(base, p);
    }
    const links = this.app.metadataCache.resolvedLinks || {};
    const inlinks = new Set();
    for (const src of Object.keys(links)) {
      const targets = links[src] || {};
      for (const t of Object.keys(targets)) inlinks.add(t);
    }

    const bodies = [];
    for (let i = 0; i < diskMd.length; i++) {
      if (shouldStop && shouldStop()) { res.stopped = true; break; }
      const p = diskMd[i];
      let text = '';
      try { text = await adapter.read(p); } catch (e) { text = ''; }
      const f = indexedByPath.get(normalizePath(p)) || null;
      const cache = f ? this.app.metadataCache.getFileCache(f) : null;
      const item = {
        path: p, file: f, indexed: !!f, noCache: !!f && !cache,
        ownTags: ownTagsOf(text),
        cacheTags: cache ? (getAllTags(cache) || []).map((x) => String(x).replace(/^#/, '')) : [],
      };
      bodies.push({ path: p, links: ownLinksOf(text) });
      res.scanned++;
      for (const code of this.scanClassify(item)) res[code].push(item);
      if (res.scanned % 25 === 0) {
        if (typeof onProgress === 'function') onProgress(res.scanned, diskMd.length);
        await new Promise((r) => setTimeout(r, 0));   // 让出主线程：扫几千篇不能把界面冻住
      }
    }

    // 入链对账：我自己从正文解析出的链接指向了谁（范围只有被扫到的那些文件，UI 里要写清）
    const ownInbound = new Set();
    for (const b of bodies) {
      for (const t of b.links) {
        const tp = linkTargetPath(t, pathByBase);
        if (tp && tp !== b.path) ownInbound.add(tp);
      }
    }
    for (const p of ownInbound) {
      if (inlinks.has(p)) continue;                  // 缓存也认为有人链它 → 一致
      const f = indexedByPath.get(normalizePath(p));
      if (!f) continue;
      res.orphanDiff.push({ path: p, file: f, indexed: true, noCache: false, ownTags: [], cacheTags: [] });
    }
    res.indexed = res.scanned - res.notIndexed.length;
    return done(res);
  }

  clearScan() { this.lastScan = null; this.scanRunning = false; }

  trackOpen(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (file.path.indexOf('.') === 0) return;
    this.recentOpenedList = this.recentOpenedList.filter((x) => x.path !== file.path);
    this.recentOpenedList.unshift({ path: file.path, time: Date.now() });
    if (this.recentOpenedList.length > 40) this.recentOpenedList.length = 40;
    this.persist();
  }

  pinnedPaths() { return this.pins || []; }

  isPinned(path) { return (this.pins || []).indexOf(path) >= 0; }

  /** 收藏/置顶变化后的刷新：能走单卡重建就不整版重绘（整版重绘会闪回顶部） */
  refreshPins() {
    let hit = false;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view;
      if (v && typeof v.afterPinsChanged === 'function') { v.afterPinsChanged(); hit = true; }
    }
    if (!hit) this.refreshViews(false);
  }

  /**
   * 把面板【当前】尺寸记成最小值（用户："以我现在的垂直方向大小做基准"）。
   * 量的是我们真正施加限制的那个元素，免得量了叶子却限制在 tabs 上。
   */
  capturePaneMin(axis) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const v = leaf && leaf.view;
    if (!v || typeof v.paneMinTargets !== 'function') return 0;
    const t = v.paneMinTargets();
    const el = axis === 'height' ? t.h : t.w;
    if (!el || typeof el.getBoundingClientRect !== 'function') return 0;
    const r = el.getBoundingClientRect();
    const px = Math.round(axis === 'height' ? r.height : r.width);
    if (!(px > 0)) return 0;
    if (axis === 'height') this.settings.minPaneHeight = px;
    else this.settings.minPaneWidth = px;
    this.persist();
    this.refreshViews(false);
    return px;
  }

  /** 置顶 = 收藏的子集：钉在收藏卡顶部一条 sticky 带里，列表滚动也不会被推走 */
  stuckPaths() { return this.sticks || []; }

  isStuck(path) { return (this.sticks || []).indexOf(path) >= 0; }

  dropStick(path) {
    const j = (this.sticks || []).indexOf(path);
    if (j >= 0) this.sticks.splice(j, 1);
  }

  togglePin(path) {
    if (!this.sticks) this.sticks = [];
    const i = this.pins.indexOf(path);
    if (i >= 0) { this.pins.splice(i, 1); this.dropStick(path); }   // 取消收藏就一并取消置顶
    else this.pins.unshift(path);
    this.persist();
  }

  toggleStick(path) {
    if (!this.sticks) this.sticks = [];
    if (!this.pins) this.pins = [];
    const i = this.sticks.indexOf(path);
    if (i >= 0) this.sticks.splice(i, 1);
    else {
      this.sticks.unshift(path);
      if (this.pins.indexOf(path) < 0) this.pins.unshift(path);      // 置顶必进收藏
    }
    this.persist();
  }

  removePin(path) {
    const i = this.pins.indexOf(path);
    if (i >= 0) { this.pins.splice(i, 1); this.dropStick(path); this.persist(); }
  }

  /* ---------------------------------------------- 任务 */

  excludePrefixes() {
    return String(this.settings.taskExclude || '')
      .split(',')
      .map((s) => normDir(s))
      .filter(Boolean);
  }

  /** 路径是否被排除：既支持前缀路径（a/b），也支持任意层级的同名目录（raw、upstream） */
  isExcludedPath(path) {
    for (const p of this.excludePrefixes()) {
      if (!p) continue;
      if (path === p || path.startsWith(p + '/')) return true;
      if (p.indexOf('/') < 0 && ('/' + path + '/').indexOf('/' + p + '/') >= 0) return true;
    }
    return false;
  }

  /** 模板文件里的勾选框是占位符，不算待办 */
  isTemplateFile(file) {
    const dirs = this.templateFolders();
    if (dirs.some((d) => file.path === d || file.path.startsWith(d + '/'))) return true;
    if (/(^|[/\\])模板[/\\]/.test(file.path)) return true;
    return /模板$/.test(file.basename);
  }

  scopeFiles() {
    const scope = (this.settings.taskScope || '').trim();
    const excl = this.excludePrefixes();
    let files = this.app.vault.getMarkdownFiles();
    if (scope) {
      const prefix = normalizePath(scope).replace(/\/+$/, '');
      if (prefix) files = files.filter((f) => f.path.startsWith(prefix + '/') || folderOf(f.path) === prefix);
    }
    if (excl.length) {
      files = files.filter((f) => !this.isExcludedPath(f.path));
    }
    return files;
  }

  async collectTasks() {
    const t0 = startOfToday();
    const today = todayStr();
    const out = [];
    const skipped = { empty: 0, template: 0, dup: 0 };
    const seen = new Map();
    // 上次扫到的"有任务行的文件"，用来判断缓存消失是不是刚写入造成的
    const lastSeen = this.lastTaskFiles || new Map();
    const nextSeen = new Map();

    for (const file of this.scopeFiles()) {
      // 待办那两篇是「待办」卡自己的清单：既不进任务卡，也不进到期日历（否则与刚新增的卡重复一份）。
      // 放在最前面按路径判掉 ⇒ 一条正文都不多读。
      if (this.isTodoFile(file.path)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      let items = (cache && cache.listItems && cache.listItems.length) ? cache.listItems : null;
      // 缓存没了、但上次这个文件是有任务行的 → 多半是刚被写入、缓存正在重建：
      // 读正文按行兜底，别让整篇文档的任务闪一下消失再冒出来。
      // 上次也没有任务的文件照旧跳过 ⇒ 扫描成本不变（不会因此多读任何文件）。
      if (!items && !(lastSeen.get(file.path) > 0)) continue;
      // 模板文件先按路径判掉，别白读一遍正文（实测：加了「每日任务模板」后 cachedRead 11→12）。
      // 计数按"这个文件里有几条任务行"算，跟以前逐条判的口径一致，卡上的「已忽略 N 条」不会突然变小。
      if (items && this.isTemplateFile(file)) { skipped.template += items.length; continue; }
      let text;
      try { text = await this.app.vault.cachedRead(file); } catch (e) { continue; }
      const lines = text.split('\n');
      if (!items) items = scanTaskLines(lines);
      nextSeen.set(file.path, items.length);
      if (!items.length) continue;
      // 带 KBWB 标记的是"工作台自己生成的当日任务页"：那是副本，勾它不改源笔记，
      // 所以绝不能再进任务清单（否则同文去重会把源笔记那条顶掉，看起来像任务被复制了一份）
      if (text.indexOf(KBWB_GENERATED_MARK) >= 0 || text.indexOf(KBWB_TASKS_MARK) >= 0) { skipped.template++; continue; }
      const isTpl = this.isTemplateFile(file);

      for (const item of items) {
        if (item.task === undefined) continue;
        const line = lines[item.position.start.line];
        if (line === undefined) continue;
        const parsed = parseTaskLine(line);
        if (!parsed) continue;

        const pretty = prettyTask(parsed.body);
        // 只有日期标记、什么都没有的行 → 空任务，不显示
        if (!pretty.text) { skipped.empty++; continue; }
        if (isTpl) { skipped.template++; continue; }

        const norm = pretty.text.toLowerCase().replace(/\s+/g, ' ');
        if (this.settings.taskDedupe && seen.has(norm)) {
          const prev = seen.get(norm);
          prev.dup = (prev.dup || 1) + 1;
          skipped.dup++;
          continue;
        }

        const markers = parseMarkers(parsed.body);
        const task = {
          file,
          line: item.position.start.line,
          body: parsed.body,
          text: pretty.text,
          chips: pretty.chips,
          done: parsed.state !== ' ',
          markers,
          indent: parsed.indent.length,
          isOverdue: !!markers.due && markers.due < today,
          doneToday: parsed.state !== ' ' && (!!markers.done ? markers.done === today : file.stat.mtime >= t0),
          dup: 1,
        };
        seen.set(norm, task);
        out.push(task);
      }
    }

    this.lastTaskStats = skipped;
    this.lastTaskCount = out.length;
    this.lastTaskFiles = nextSeen;
    out.sort((a, b) => {
      const ao = a.markers.due || '9999', bo = b.markers.due || '9999';
      if (ao !== bo) return ao < bo ? -1 : 1;
      if (a.file.path !== b.file.path) return a.file.path.localeCompare(b.file.path);
      return a.line - b.line;
    });
    return out;
  }

  async toggleTask(t) {
    const stamp = todayStr();
    try {
      await this.app.vault.process(t.file, (data) => {
        const lines = data.split('\n');
        const idx = t.line;
        if (idx < 0 || idx >= lines.length) return data;
        const parsed = parseTaskLine(lines[idx]);
        if (!parsed) return data;
        let state = parsed.state, body = parsed.body;
        if (parsed.state === ' ') {
          state = 'x';
          if (this.settings.markDoneDate && !/✅[ \t]*\d{4}-\d{2}-\d{2}/.test(body)) {
            body = body.replace(/\s+$/, '') + ' ✅' + stamp;
          }
        } else {
          state = ' ';
          body = body.replace(/\s*✅[ \t]*\d{4}-\d{2}-\d{2}/g, '');
        }
        lines[idx] = parsed.indent + parsed.bullet + ' [' + state + '] ' + body;
        return lines.join('\n');
      });
    } catch (err) {
      new Notice('勾选失败：' + (err && err.message ? err.message : err));
    }
  }

  /* ---------------------------------------------- 目录树 */

  folderTree() {
    const files = this.app.vault.getMarkdownFiles();
    const root = { name: '（根目录笔记）', path: '', count: 0, children: new Map(), files: [] };
    for (const f of files) {
      root.count++;
      const parts = f.path.split('/');
      let node = root;
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? acc + '/' + parts[i] : parts[i];
        if (!node.children.has(parts[i])) {
          node.children.set(parts[i], { name: parts[i], path: acc, count: 0, children: new Map(), files: [] });
        }
        node = node.children.get(parts[i]);
        node.count++;
      }
      if (parts.length > 1) node.files.push(f); else root.files.push(f);
    }
    const toArr = (node, depth) => Array.from(node.children.values())
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((k) => ({
        name: k.name, path: k.path, count: k.count,
        files: k.files.slice().sort((a, b) => b.stat.mtime - a.stat.mtime),
        children: depth < 4 ? toArr(k, depth + 1) : [],
      }));
    const kids = toArr(root, 0);
    if (root.files.length) {
      kids.push({
        name: '（根目录笔记）', path: '/', count: root.files.length,
        files: root.files.slice().sort((a, b) => b.stat.mtime - a.stat.mtime), children: [],
      });
    }
    return kids;
  }

  openFolderFirst(node) {
    const f = node.files && node.files[0];
    if (f) this.openFile(f);
    else new Notice('「' + node.name + '」下还没有笔记');
  }

  /* ---------------------------------------------- 统计 */

  computeStats() {
    // 结果缓存：以前只去重"在飞的任务"，所以每次 render（点收藏、切页签、勾任务这类
    // 不 invalidate 的刷新）都会重读全库正文算字数。refreshViews(true) 会把 statsCache 清掉。
    if (this.statsCache) return Promise.resolve(this.statsCache);
    if (this.statsJob) return this.statsJob;
    this.statsJob = (async () => {
      const t0 = startOfToday();
      const weekAgo = Date.now() - 7 * 86400000;
      const all = this.app.vault.getFiles();
      const md = all.filter((f) => f.extension === 'md');
      const s = {
        total: all.length, files: all.length, md: md.length, nonMd: all.length - md.length,
        bytes: 0, todayNew: 0, todayEdit: 0, week: 0,
        tagCount: 0, topTags: [], folders: [], words: null, wordsScanned: 0, wordsCapped: false,
        hist7: [], hist7Labels: [],
      };
      for (const f of all) {
        s.bytes += f.stat.size || 0;
        if (f.stat.ctime >= t0) s.todayNew++;
        if (f.stat.mtime >= t0) s.todayEdit++;
        if (f.stat.mtime >= weekAgo || f.stat.ctime >= weekAgo) s.week++;
      }

      // 近 7 天每日活跃数（按修改时间分桶），用于火花条
      for (let i = 6; i >= 0; i--) {
        const from = t0 - i * 86400000;
        const to = from + 86400000;
        let n = 0;
        for (const f of md) if (f.stat.mtime >= from && f.stat.mtime < to) n++;
        s.hist7.push(n);
        const d = new Date(from);
        s.hist7Labels.push((d.getMonth() + 1) + '/' + d.getDate());
      }

      const tagMap = new Map();
      const tagFiles = new Map();     // 标签 → 带它的文件（标签总览的"框选多选"要在这里取交集）
      for (const f of md) {
        const cache = this.app.metadataCache.getFileCache(f);
        if (!cache) continue;
        for (const t of (getAllTags(cache) || [])) {
          const key = String(t).replace(/^#/, '');
          if (!key) continue;
          tagMap.set(key, (tagMap.get(key) || 0) + 1);
          if (!tagFiles.has(key)) tagFiles.set(key, []);
          tagFiles.get(key).push(f);
        }
      }
      s.tagCount = tagMap.size;
      s.topTags = Array.from(tagMap.entries()).sort((a, b) => b[1] - a[1]);
      s.tagFiles = tagFiles;

      const folders = new Map();
      for (const f of md) {
        const top = f.path.indexOf('/') >= 0 ? f.path.split('/')[0] : '（根目录）';
        folders.set(top, (folders.get(top) || 0) + 1);
      }
      s.folders = Array.from(folders.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      if (this.settings.showWordCount) {
        const cap = clampInt(this.settings.wordCountCap, 200, 20000, 4000);
        const list = md.slice(0, cap);
        // 字数要读全库正文（真实库实测 769 篇 / 4.6 MB / ~42ms）。
        // 用「篇数 + mtime 之和 + 字节数之和」当签名：库没动就复用上次结果，
        // 于是 60 秒自动刷新在库静止时几乎不花钱，改过笔记才重扫。
        let acc = 0;
        for (const f of list) acc += Math.round(f.stat.mtime || 0) + (f.stat.size || 0);
        const sig = list.length + ':' + acc;
        if (this.wordsCache && this.wordsCache.sig === sig) {
          s.words = this.wordsCache.words;
          s.wordsScanned = this.wordsCache.scanned;
        } else {
          let words = 0;
          for (const f of list) {
            try { words += countWords(await this.app.vault.cachedRead(f)); } catch (e) { /* ignore */ }
          }
          s.words = words;
          s.wordsScanned = list.length;
          this.wordsCache = { sig, words, scanned: list.length };
        }
        s.wordsCapped = md.length > list.length;
      }

      this.statsCache = s;
      this.statsJob = null;
      return s;
    })().catch((err) => {
      console.error('[kb-workbench] 统计失败', err);
      this.statsJob = null;
      return { total: 0, files: 0, md: 0, nonMd: 0, bytes: 0, todayNew: 0, todayEdit: 0, week: 0, tagCount: 0, topTags: [], folders: [], words: null, wordsScanned: 0, wordsCapped: false };
    });
    return this.statsJob;
  }

  /* ---------------------------------------------- 打开文件 */

  async openFile(file, line, mode) {
    if (!(file instanceof TFile)) return;
    const leaf = mode === 'split' ? this.app.workspace.getLeaf('split') : this.app.workspace.getLeaf(false);
    try {
      if (line === undefined) {
        await leaf.openFile(file, { active: true });
      } else {
        await leaf.openFile(file, { active: true, eState: { line, cursor: { line: line, ch: 0 } } });
        if (leaf.view && typeof leaf.view.setEphemeralState === 'function') {
          leaf.view.setEphemeralState({ line, cursor: { line: line, ch: 0 } });
        }
      }
      this.app.workspace.revealLeaf(leaf);
    } catch (err) {
      new Notice('打开失败：' + (err && err.message ? err.message : err));
    }
  }

  /* ---------------------------------------------- 新建笔记 */

  async loadConfigs() {
    const dir = this.app.vault.configDir || '.obsidian';
    const readJson = async (p) => {
      try {
        const abs = normalizePath(p);
        if (await this.app.vault.adapter.exists(abs)) {
          const txt = await this.app.vault.adapter.read(abs);
          return txt ? JSON.parse(txt) : null;
        }
      } catch (e) { /* ignore */ }
      return null;
    };
    const strip = (v) => normDir(v);   // 留空 / 只有斜杠都算"没设置"（normalizePath 会把 '' 变成 '/'，别用它判空）
    const templater = await readJson(dir + '/plugins/templater-obsidian/data.json');
    const coreTpl = await readJson(dir + '/templates.json');
    const daily = await readJson(dir + '/daily-notes.json');
    this.coreConfig = {
      templaterFolder: strip(templater && templater.templates_folder),
      templatesFolder: strip(coreTpl && coreTpl.folder),
      dailyFolder: strip(daily && daily.folder),
      dailyFormat: (daily && daily.format) || 'YYYY-MM-DD',
      dailyTemplate: strip(daily && daily.template),
    };
    return this.coreConfig;
  }

  templateFolders() {
    const cfg = this.coreConfig || {};
    const dirs = [];
    if (cfg.templaterFolder) dirs.push(cfg.templaterFolder);
    if (cfg.templatesFolder && dirs.indexOf(cfg.templatesFolder) < 0) dirs.push(cfg.templatesFolder);
    return dirs;
  }


  listTemplates() {
    const dirs = this.templateFolders();
    if (!dirs.length) return [];
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (dirs.some((d) => f.path === d || f.path.startsWith(d + '/'))) out.push(f);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * 模板都放同一个目录：设置里指定；留空 = 自动取模板夹（Templater 优先，其次核心「模板」），
   * 再退到「模板」。用户要的是"新增的模板都在同一个目录下"。
   */
  templateDir() {
    const custom = normDir(this.settings.templateDir);
    if (custom) return custom;
    const dirs = this.templateFolders();
    return normDir(dirs[0]) || '模板';
  }

  /**
   * 「选模板」列表：模板目录下的所有 .md，按名字排。
   * 故意**只按目录过滤、不读正文**（开框现读，不进 render）：
   * 「＋ 新增模板」以当前选中的那份为底子，新模板会带上 KBWB 指纹，
   * 按指纹过滤反而会把刚建好的那份从列表里藏掉 —— 所以这里不做"生成物识别"。
   */
  listTemplatesForPicker() {
    const dir = this.templateDir();
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (dir && !(f.path === dir || f.path.startsWith(dir + '/'))) continue;
      out.push(f);
    }
    return out.sort((a, b) => String(a.basename).localeCompare(String(b.basename), 'zh'));
  }

  /**
   * 新增模板：一律写进 templateDir()。给了 basePath 就"照着它改"（把那份内容当底子），
   * 否则用骨架。同名不覆盖，直接打开已有的那个。
   */
  async createTemplate(name, basePath) {
    const clean = String(name || '').replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) { new Notice('模板名不能为空'); return null; }
    const dir = this.templateDir();
    if (dir) await this.ensureFolder(dir);
    const path = normalizePath((dir ? dir + '/' : '') + clean + '.md');
    const dup = this.app.vault.getFileByPath(path);
    if (dup) { new Notice('已有同名模板，直接用：' + dup.path); return dup; }
    // 骨架里的 {{title}} / {{date}} 要留着 —— 占位符是"每次建笔记时"才换的，
    // 在模板名上就替换掉的话，之后每篇笔记的标题都会写成模板名（实测踩过）
    let text = DEFAULT_TEMPLATE_SKELETON;
    const base = basePath ? this.app.vault.getFileByPath(normalizePath(basePath)) : null;
    if (base) {
      try { text = await this.app.vault.cachedRead(base); } catch (e) { /* 读不到就用骨架 */ }
    }
    try {
      const f = await this.app.vault.create(path, text);
      new Notice('模板已建：' + f.path);
      return f;
    } catch (e) {
      new Notice('建模板失败：' + (e && e.message ? e.message : e));
      return null;
    }
  }

  /**
   * 统一的"标题（+ 可选模板）"确认框。
   * withTemplates=true 时会列出模板目录里的所有模板，并给一个「新增模板」按钮。
   * 返回 { name, template }；取消返回 null。
   */
  promptNewNote(opts) {
    const o = opts || {};
    const self = this;
    return new Promise((resolve) => {
      // 没给 opts 时 NameModal 回调的是字符串（老行为）；这里统一成 { name, template }，
      // 调用点就不必知道自己走没走模板分支（踩过：直接 res.name 在字符串上是 undefined）
      const done = (r) => resolve(typeof r === 'string' ? { name: r, template: '' } : (r || null));
      const box = new NameModal(self.app, o.initial, done, o.hint, o.asTemplate ? { asTemplate: true } : (o.withTemplates ? {
        dir: self.templateDir(),
        listTemplates: () => self.listTemplatesForPicker(),
        readTemplate: async (p) => {
          const f = self.app.vault.getFileByPath(normalizePath(p));
          if (!f) return '';
          try { return await self.app.vault.cachedRead(f); } catch (e) { return ''; }
        },
        onCreateTemplate: (name, basePath) => self.createTemplate(name, basePath),
        // 第一行（"不选模板"）的文案由调用方定：月历那条路上它的意思是"用当天任务模板"
        noneLabel: o.noneLabel || '不用模板',
        noneHint: o.noneHint || '直接建空白笔记',
        // 月历那条路（用户②）：列表就等于模板目录里的那些真实文件，不要合成的第一行；
        // 开局的选中落在 selected 指的那份文件上（= 设置「当日任务模板」）。
        allowNone: o.allowNone !== false,
        selected: o.selected || '',
      } : null));
      box.open();
    });
  }

  pickTemplateFlow() {
    if (!this.templateFolders().length) {
      new Notice('没找到模板文件夹：去 Templater 或核心「模板」插件里设一个模板目录');
      return;
    }
    new TemplateModal(this.app, this).open();
  }

  /** 打开相对今天的日记（delta=-1 即昨天） */
  async openDailyOffset(delta) {
    if (!this.coreConfig) await this.loadConfigs();
    const cfg = this.coreConfig || {};
    const fmt = cfg.dailyFormat || 'YYYY-MM-DD';
    let name;
    try {
      const d = new Date();
      d.setDate(d.getDate() + delta);
      name = moment(d).format(fmt);
    } catch (e) { name = ''; }
    if (!name) return;
    const folder = cfg.dailyFolder || this.settings.newNoteFolder || '';
    const full = normalizePath((folder ? folder + '/' : '') + name + '.md');
    const f = this.app.vault.getFileByPath(full);
    if (f) this.openFile(f);
    else new Notice('没有找到：' + full);
  }

  async ensureFolder(path) {
    if (!path) return;
    const parts = String(path).split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
      acc = acc ? acc + '/' + p : p;
      if (!this.app.vault.getFolderByPath(normalizePath(acc))) {
        try { await this.app.vault.createFolder(normalizePath(acc)); } catch (e) { /* 可能已存在 */ }
      }
    }
  }

  /**
   * 按路径/文件名找到库里那个文件。
   * 「日记」核心的 daily-notes.json 把模板存成 "每日笔记/每日笔记模板"（**不带 .md**），
   * 直接 getFileByPath 拿不到 ⇒ 以前建日记其实没套上模板（真机实测：建出来只有 frontmatter + 标题）。
   * 这里依次试：原样 → 补 .md → 按 basename 找。
   */
  resolveVaultFile(pathOrName) {
    const raw = String(pathOrName || '').trim();
    if (!raw) return null;
    const direct = this.app.vault.getFileByPath(normalizePath(raw));
    if (direct) return direct;
    const withMd = this.app.vault.getFileByPath(normalizePath(raw + '.md'));
    if (withMd) return withMd;
    const base = raw.split('/').pop().replace(/\.md$/i, '');
    const all = this.app.vault.getMarkdownFiles();
    for (const f of all) if (f.basename === base) return f;
    return null;
  }

  /**
   * 给定日期 → 日记文件名。月历卡与「今日笔记」按钮共用这一套格式解析，
   * 免得两处各写一遍 moment().format() 而后缀规则漂移。
   */
  dailyNameFor(date) {
    const cfg = this.coreConfig || {};
    const fmt = cfg.dailyFormat || 'YYYY-MM-DD';
    let name = '';
    try { name = moment(date).format(fmt); } catch (e) { name = ''; }
    if (!name || /[\\/:*?"<>|]/.test(name)) name = ymd(date);
    return name;
  }

  /**
   * 给定日期 → 日记在库内的完整路径。
   * 先看"这天记住的笔记"（用户在月历确认框里改过标题的那些天），再看按格式推出来的路径；
   * 记住的那篇如果被删了就当没有（回到格式路径）。
   */
  /** 按「日记」的文件夹 + 格式推出来的那篇路径（不管它存不存在） */
  dailyFormatPath(date) {
    const cfg = this.coreConfig || {};
    const folder = cfg.dailyFolder || this.settings.newNoteFolder || '';
    return normalizePath((folder ? folder + '/' : '') + this.dailyNameFor(date) + '.md');
  }


  /**
   * 这天从月历建过的所有笔记（不止一篇）：记住的映射 + 「日记」格式推出来的那篇。
   * 文件被删了就自动掉出去；按修改时间新的在前。
   */
  dailyNotesFor(date) {
    const key = ymd(date);
    // 注意：这里【不做按天缓存】—— 试过，一次渲染里 30 个格子问的是 30 个不同日期，
    // memo 只省 1 次调用（脚部那次），却引入缓存生命周期风险 ⇒ 量化后不值，撤掉。
    const raw = (this.dailyNotes && this.dailyNotes[key]) || [];
    const arr = Array.isArray(raw) ? raw : [raw];
    const out = [];
    const seen = {};
    const add = (f) => { if (f && !seen[f.path]) { seen[f.path] = true; out.push(f); } };
    for (const p of arr) add(typeof p === 'string' ? this.app.vault.getFileByPath(normalizePath(p)) : null);
    add(this.app.vault.getFileByPath(this.dailyFormatPath(date)));
    // 兜底：用户把这篇改了名（2026-11-09 → 2026-11-09 随笔），映射还指着旧路径 ⇒ 上面两条都落空。
    // 按「文件名以这天的日期开头」在日记夹里找。只认开头不认中间，免得把
    // 「随笔 2026-11-09.md」这种标题里引用了别天日期的笔记算进来。
    for (const f of (this.dailyIndex()[key] || [])) add(f);
    out.sort((a, b) => ((b.stat && b.stat.mtime) || 0) - ((a.stat && a.stat.mtime) || 0));
    return out;
  }

  /** 记下"这天建了哪篇"（同一天可以有多条） */
  rememberDailyNote(key, path) {
    if (!this.dailyNotes) this.dailyNotes = {};
    const arr = Array.isArray(this.dailyNotes[key]) ? this.dailyNotes[key]
      : (this.dailyNotes[key] ? [this.dailyNotes[key]] : []);
    if (arr.indexOf(path) >= 0) return false;
    arr.push(path);
    this.dailyNotes[key] = arr;
    this.persist();
    return true;
  }

  /** 两个「按天算笔记」的缓存一起失效：日期前缀索引 + 按天的结果缓存。谁改了路径/映射/文件就调它。 */
  invalidateDailyCache() {
    this._dailyIndex = null;
  }

  /** 日记夹（核心「日记」设置指的那个）；没配就用新建笔记的目录 */
  dailyFolderPrefix() {
    const cfg = this.coreConfig || {};
    return normDir(cfg.dailyFolder || this.settings.newNoteFolder || '');
  }

  /**
   * 「文件名以 YYYY-MM-DD 开头」→ 那天的笔记。一次遍历 getMarkdownFiles()，缓存复用。
   * 缓存由 create/modify/delete/rename 事件与 onVaultRename 清掉；一次 render 最多建一份，
   * 42 个月历格子共用同一份（绝不在每个格子里各扫一遍全库）。
   */
  dailyIndex() {
    if (this._dailyIndex) return this._dailyIndex;
    const folder = this.dailyFolderPrefix();
    const map = {};
    const files = this.app.vault.getMarkdownFiles() || [];
    for (const f of files) {
      const p = normalizePath(String((f && f.path) || ''));
      if (!p) continue;
      if (folder && p.indexOf(folder + '/') !== 0) continue;
      const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
      const mm = base.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!mm) continue;
      if (!map[mm[1]]) map[mm[1]] = [];
      map[mm[1]].push(f);
    }
    this._dailyIndex = map;
    return map;
  }

  /**
   * 改名/移动。Obsidian 对每个受影响文件发一次 rename(新文件, 旧路径)（文件夹改名时里面的文件也各发一次）。
   * 所有以路径为键的状态必须一起搬，少一样就有一条对应的「改了名字就不算了」：
   *   dailyNotes（月历的 ● 与「这天已建几篇」）· pins（收藏）· sticks（置顶）· recentOpenedList（最近打开）。
   */
  onVaultRename(file, oldPath) {
    if (!file || !oldPath) return false;
    const np = normalizePath(String(file.path || ''));
    const op = normalizePath(String(oldPath));
    if (!np || !op || np === op) return false;
    let changed = false;
    const move = (p) => {
      const q = normalizePath(String(p || ''));
      if (q === op) return np;                     // 改名的就是它（文件或文件夹本身）
      if (q.indexOf(op + '/') === 0) {
        // oldPath 是文件夹前缀：只有 np 也是文件夹时才做前缀替换。
        // 防呆：Obsidian 对文件夹改名会【给每个子文件各发一次】事件（file.path 已是子文件的新路径），
        // 所以带 .md 的 np 走上面那条精确分支就够了；拿它当文件夹用会把路径拼两遍（测试抓到过）。
        if (/\.md$/i.test(np)) return p;
        return np + q.slice(op.length);
      }
      return p;
    };
    const swapList = (list) => {
      const next = [];
      for (const p of list) { const q = move(p); if (q && next.indexOf(q) < 0) next.push(q); }
      return next;
    };
    for (const key of Object.keys(this.dailyNotes || {})) {
      const raw = this.dailyNotes[key];
      const arr = Array.isArray(raw) ? raw : [raw];
      const next = swapList(arr);
      if (next.join('|') !== arr.join('|')) {
        if (next.length) this.dailyNotes[key] = next; else delete this.dailyNotes[key];
        changed = true;
      }
    }
    for (const fld of ['pins', 'sticks']) {
      if (!Array.isArray(this[fld])) continue;
      const next = swapList(this[fld]);
      if (next.join('|') !== this[fld].join('|')) { this[fld] = next; changed = true; }
    }
    if (Array.isArray(this.recentOpenedList)) {
      const pathsOf = (l) => l.map((x) => (x && x.path) || '').join('|');
      const before = pathsOf(this.recentOpenedList);
      const next = this.recentOpenedList.map((x) => (x && x.path ? { path: move(x.path), time: x.time } : x));
      if (pathsOf(next) !== before) { this.recentOpenedList = next; changed = true; }
    }
    if (changed) { this.invalidateDailyCache(); this.persist(); }
    return changed;
  }

  /**
   * 启动时一次性补映射：指向不存在路径的条目，按日期前缀找一篇还没记过的补回去；补不到就丢掉。
   * 只在 loadConfigs 之后跑一次，不在 render 里跑（render 不许写盘，也不该扫全库）。
   */
  repairDailyNotes() {
    let changed = false;
    for (const key of Object.keys(this.dailyNotes || {})) {
      const raw = this.dailyNotes[key];
      const arr = Array.isArray(raw) ? raw : [raw];
      const next = [];
      for (const p of arr) {
        if (this.app.vault.getFileByPath(normalizePath(p))) { if (next.indexOf(p) < 0) next.push(p); continue; }
        changed = true;
        const cand = (this.dailyIndex()[key] || []).filter((f) => next.indexOf(f.path) < 0 && arr.indexOf(f.path) < 0);
        if (cand.length) next.push(cand[0].path);
      }
      if (next.join('|') !== arr.join('|')) {
        if (next.length) this.dailyNotes[key] = next; else delete this.dailyNotes[key];
      }
    }
    if (changed) this.persist();
    return changed;
  }

  /**
   * 月历点某一天：
   *   · 有日记 → 直接打开；
   *   · 没有 → 先弹确认框，标题默认用「日记」的格式（如 2026-11-05），可以改；
   *            按确认后的标题建，取消就什么都不做（用户："先确认标题再按照标题建立笔记"）。
   */
  async openOrCreateDailyOn(date) {
    if (!this.coreConfig) await this.loadConfigs();
    const notes = this.dailyNotesFor(date);
    if (notes.length) {
      // 用户要的是"列出所有从月历建的笔记 + 一个新增按钮"，不是直接打开第一篇
      const res = await new Promise((resolve) => new DayNotesModal(this.app, ymd(date), notes, resolve).open());
      if (!res) return null;
      if (res.create) return this.createDailyOn(date);
      if (res.open) { this.openFile(res.open); return res.open; }
      return null;
    }
    return this.createDailyOn(date);
  }

  /** 确认标题 → 按当天任务填好的正文建 → 记下"这天建了这篇"（同一天可以建好几篇） */
  async createDailyOn(date) {
    if (!this.coreConfig) await this.loadConfigs();
    const cfg = this.coreConfig || {};
    const key = ymd(date);
    const folder = cfg.dailyFolder || this.settings.newNoteFolder || '';
    // 默认标题要让开同名的那篇：同一天已经有 2026-11-04.md 时，第二篇默认叫「2026-11-04 2」，
    // 否则用户不改标题点创建，就会命中 createNoteFlow 的"同名直接打开"分支（用户实测报过）
    const guess = this.uniqueNameIn(folder, this.dailyNameFor(date));
    // 月历那条路的模板列表 = 模板目录里的真实文件（用户②："不要那一行合成的默认"）：
    // 不再有「默认（当天任务模板）」这种既不是文件的假条目，选哪个用哪个；
    // 开局的选中落在设置「当日任务模板」指向的那份文件上（找不到就谁都不选，建的时候仍会走 buildDailyContent 的模板链）。
    const defTpl = this.resolveVaultFile(this.settings.dailyCreateTemplate);
    const hint = '为 ' + key + ' 建立笔记 · 放在「' + (folder || '库根') + '」· 默认名 ' + guess
      + (defTpl ? ' · 模板：' + defTpl.basename : ' · 没找到「当日任务模板」，会走内置兜底');
    const res = await this.promptNewNote({
      initial: guess, hint, withTemplates: true,
      allowNone: false,
      selected: defTpl ? defTpl.path : '',
    });
    if (!res || !res.name) return null;           // 取消或空标题：一个文件都不建
    const built = await this.buildDailyContent(date, res.name, res.template);
    // 正文已经在 buildDailyContent 里按"确认框选中的那份文件"算好了，这里不再传 template
    // （传了也不参与：createNoteFlow 只在 content 为空时才读模板）—— 免得两条模板链看着像在打架。
    const created = await this.createNoteFlow({ folder, forcedName: res.name, content: built.text, ensureNew: true });
    if (created) this.rememberDailyNote(key, created.path);
    return created || null;
  }

  /**
   * 组装"这一天"的笔记正文：模板 → 换占位符 → 把 KBWB 标记换成当天任务。
   * 模板优先用**库里那份文件**：确认框里点的那份 → 设置里的 dailyCreateTemplate → 「日记」核心设的模板；
   * 内置 KBWB_DEFAULT_DAILY_TASKS 只是**最后的兜底**（一份都没用到才用它），
   * 用到兜底时明确告诉用户 —— 否则"内置那份与库里那份漂移了"会一直静默（用户③）。
   */
  async buildDailyContent(date, title, tplChoice) {
    const cfg = this.coreConfig || {};
    const d = date || new Date();
    let tpl = null;
    let asked = '';
    // 用户在确认框里点了某份模板就用它；没点（''）走默认链：当日任务模板 → 「日记」核心的模板
    if (typeof tplChoice === 'string' && tplChoice.trim()) { asked = tplChoice.trim(); tpl = this.resolveVaultFile(asked); }
    if (!tpl && String(this.settings.dailyCreateTemplate || '').trim()) {
      asked = String(this.settings.dailyCreateTemplate).trim();
      tpl = this.resolveVaultFile(asked);
    }
    if (!tpl && cfg.dailyTemplate) { asked = String(cfg.dailyTemplate).trim(); tpl = this.resolveVaultFile(asked); }
    let text = KBWB_DEFAULT_DAILY_TASKS;
    let used = '（内置默认模板）';
    let fromFile = false;
    if (tpl) {
      try { text = await this.app.vault.cachedRead(tpl); used = tpl.path; fromFile = true; }
      catch (e) { /* 读不到就用内置的，别把建笔记整个搞失败 */ }
    }
    // 兜底不是无声的：配过模板（设置里或确认框里点的）却没用到 ⇒ 明说，漂移当场看得见
    if (!fromFile && asked) {
      new Notice('没用到模板「' + asked.split('/').pop() + '」：这篇是内置默认模板建的，去设置里核对「当日任务模板」');
    }
    let tasks = [];
    try { tasks = await this.collectTasks(); } catch (e) { tasks = []; }
    let out = fillTaskMarkers(
      substituteTemplateTokens(text, { date: d, title: title || this.dailyNameFor(d) }),
      tasks, ymd(d), clampInt(this.settings.dailyTasksLimit, 1, 200, 30));
    // 副本要能被认出来：TASKS 标记会被填掉（填完就没了），所以另钉一行常驻指纹。
    // 但只有"这份模板真的产生了副本"才需要 —— 模板里一个 KBWB 标记都没有时，一条副本也没产生，
    // 钉上去反而把整篇当生成物跳过：用户在日记里自己写的 - [ ] 永远进不了任务卡（实测）。
    const hadMarkers = String(text).indexOf(KBWB_TASKS_MARK) >= 0;
    if (hadMarkers && out.indexOf(KBWB_GENERATED_MARK) < 0) {
      out = out.replace(/\n+$/, '') + '\n\n' + KBWB_GENERATED_MARK + '\n';
    }
    return { text: out, template: used, hadMarkers: hadMarkers };
  }

  async createDailyNote() {
    if (!this.coreConfig) await this.loadConfigs();
    const cfg = this.coreConfig || {};
    const name = this.dailyNameFor(new Date());
    const folder = cfg.dailyFolder || this.settings.newNoteFolder || '';
    const full = normalizePath((folder ? folder + '/' : '') + name + '.md');
    const exists = this.app.vault.getFileByPath(full);
    if (exists) { this.openFile(exists); new Notice('已打开今日笔记：' + exists.path); return; }
    await this.createNoteFlow({ folder, template: cfg.dailyTemplate, forcedName: name });
  }

  /* ---------------------------------------------- 速记本（写文件，只追加） */

  scratchPath() {
    // 留空或写成一个孤零零的 '/' 都回到默认：normalizePath('/') 在真实 Obsidian 里就是 '/'，
    // 那样 appendScratch 会往库根的 '/' 写（normDir 的注释里有本体原文）
    const p = normDir(this.settings.scratchPath);
    return normalizePath(p || '每日笔记/速记.md');
  }

  /** 追加一条速记：文件不存在先建（带一个一级标题），存在就只用 vault.process 往末尾加一行。
      与勾选任务同一套做法：整份文件只在回调里改那一段，不整篇重写。 */
  async appendScratch(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const p = this.scratchPath();
    let f = this.app.vault.getFileByPath(p);
    if (!f) {
      const folder = folderOf(p);
      if (folder) await this.ensureFolder(folder);
      try { f = await this.app.vault.create(p, '# 速记\n\n'); }
      catch (e) { new Notice('创建速记本失败：' + (e && e.message ? e.message : e)); return null; }
    }
    const line = '- ' + todayStr() + ' ' + clockStr() + ' ' + clean;
    try {
      await this.app.vault.process(f, (data) => {
        const base = String(data === undefined || data === null ? '' : data);
        return (base === '' || base.endsWith('\n') ? base : base + '\n') + line + '\n';
      });
    } catch (e) {
      new Notice('写入速记本失败：' + (e && e.message ? e.message : e));
      return null;
    }
    this.bump && this.bump();   // 让 1.2s 后的那轮刷新把统计也带上
    return line;
  }

  /** 读速记条目（新的在前）。文件不存在返回空数组，不报错。 */
  async readScratchLines() {
    const f = this.app.vault.getFileByPath(this.scratchPath());
    if (!f) return [];
    let text = '';
    try { text = await this.app.vault.cachedRead(f); } catch (e) { return []; }
    const out = [];
    for (const raw of String(text).split('\n')) {
      const m = /^-\s*(\d{4}-\d{2}-\d{2})?\s*(\d{2}:\d{2})?\s*(.*)$/.exec(raw.trim());
      if (!m) continue;
      const body = String(m[3] || '').trim();
      if (!body) continue;
      const stamp = [m[1], m[2]].filter(Boolean).join(' ');
      out.push({ stamp: stamp || '—', text: body, raw: raw.trim() });
    }
    out.reverse();
    return out;
  }

  /* ---------------------------------------------- 待办清单（第三十二轮：写文件，插件自维护） */

  /** 两篇待办文件的落点：留空 / 只有斜杠都回到默认（与 scratchPath 同一套判空，别用 normalizePath 判空） */
  todoFilePath(which) {
    const raw = which === 'weekly' ? this.settings.todoWeeklyPath : this.settings.todoDailyPath;
    const def = which === 'weekly' ? '待办/每周待办.md' : '待办/每日待办.md';
    return normalizePath(normDir(raw) || def);
  }

  /** 两个待办路径按设置值算一次就够（设置一改就换 key 重算）。
      不缓存的话每条文件都要跑两遍 normalizePath + normDir：实测 collectTasks 12.2ms → 22.3ms。 */
  todoPathSet() {
    const key = String(this.settings.todoDailyPath) + '|' + String(this.settings.todoWeeklyPath);
    if (this._todoPathKey !== key || !this._todoPaths) {
      this._todoPathKey = key;
      this._todoPaths = [this.todoFilePath('daily'), this.todoFilePath('weekly')];
    }
    return this._todoPaths;
  }

  /** 这两篇是插件自己的清单，不参与全库任务扫描（否则待办会被当成"库里的任务"到处冒出来）。
      入参是 TFile.path，本体里已经是规范化过的 ⇒ 这里只做字符串比较。 */
  isTodoFile(path) {
    const p = String(path || '');
    const set = this.todoPathSet();
    return set.indexOf(p) >= 0;
  }

  /** 文件不存在就建一个带一级标题的空壳（照 appendScratch 的先例：先补目录，再 create） */
  async ensureTodoFile(which) {
    const p = this.todoFilePath(which);
    const f = this.app.vault.getFileByPath(p);
    if (f) return f;
    const folder = folderOf(p);
    if (folder) await this.ensureFolder(folder);
    const title = which === 'weekly' ? '# 每周待办' : '# 每日待办';
    try { return await this.app.vault.create(p, title + '\n\n'); }
    catch (e) {
      // 括号不能省：`cond ? 'A' : 'B' + msg` 会让周那一支拼不上错误原因（三元优先级比 + 低）
      new Notice((which === 'weekly' ? '创建每周待办失败：' : '创建每日待办失败：') + (e && e.message ? e.message : e));
      return null;
    }
  }

  /** 读一篇待办 → 分组。文件不存在 = 空数组，不报错也不建文件（render 里调用它是安全的） */
  async readTodoSections(which) {
    const f = this.app.vault.getFileByPath(this.todoFilePath(which));
    if (!f) return [];
    let text = '';
    try { text = await this.app.vault.cachedRead(f); } catch (e) { return []; }
    return parseTodoSections(text);
  }

  /** 一次渲染共用一份扫描：待办卡 + 月历红点要的是同一批数据（与 tasksForRender 同一套路） */
  async todosForRender() {
    if (this._todosShared) return this._todosShared;
    const daily = await this.readTodoSections('daily');
    const weekly = await this.readTodoSections('weekly');
    this._todosShared = { daily, weekly, openDaily: todoOpenKeys(daily), openCountDaily: todoOpenCounts(daily) };
    return this._todosShared;
  }

  async addTodo(which, key, body) {
    const clean = String(body || '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const f = await this.ensureTodoFile(which);
    if (!f) return null;
    let ok2 = false;
    try {
      await this.app.vault.process(f, (data) => {
        const out = addTodoInSection(String(data === undefined || data === null ? '' : data), key, clean);
        if (out === null) return data;   // 键不合法（既不是日期也不是周键）：不动文件
        ok2 = true;
        return out;
      });
    } catch (e) {
      new Notice('写入待办失败：' + (e && e.message ? e.message : e));
      return null;
    }
    if (!ok2) return null;
    this._todosShared = null;
    this.bump && this.bump();
    return clean;
  }

  /**
   * 待办两行操作（勾 / 删）的公共前奏：取文件 → 按内容复核行号 → vault.process 写回 → 失效缓存。
   * 原来这两段各写一遍（12 行 × 2），改一处忘另一处的风险全在这里；合成一个 helper。
   * transform(src, at) 返回 null 表示「不动文件」。
   */
  async editTodoLine(which, line, expectText, failLabel, transform) {
    const f = this.app.vault.getFileByPath(this.todoFilePath(which));
    if (!f) return false;
    const want = String(expectText || '').replace(/\s+/g, ' ').trim();
    let changed = false;
    try {
      await this.app.vault.process(f, (data) => {
        const src = String(data === undefined || data === null ? '' : data);
        const at = findTodoLine(src, line, want);
        if (at < 0) return data;
        const out = transform(src, at);
        if (out === null) return data;
        changed = true;
        return out;
      });
    } catch (e) {
      new Notice(failLabel + '：' + (e && e.message ? e.message : e));
      return false;
    }
    if (changed) { this._todosShared = null; this.bump && this.bump(); }
    return changed;
  }

  /** 翻某一行的勾选状态。行号来自 parseTodoSections，写回时按行内容再核一遍，避免"改了别人那一行" */
  async setTodoDone(which, line, expectText, done) {
    return this.editTodoLine(which, line, expectText, '改待办状态失败', (src, at) => setTodoDoneAt(src, at, done));
  }

  async removeTodo(which, line, expectText) {
    return this.editTodoLine(which, line, expectText, '删除待办失败', (src, at) => dropTodoLine(src, at));
  }

  /** 打开那篇待办文件（月历卡里点"去文件里看"） */
  async openTodoFile(which) {
    const f = await this.ensureTodoFile(which);
    if (f) this.openFile(f);
  }

  /* ---------------------------------------------- 写作量快照 */

  /**
   * 把"当前全库字数"按天记一笔（data.json.writingLog）。
   * 只在数值真的变了才落盘，并裁到 writingKeep 天 —— 所以放 60s 自动刷新里，不放 render()
   * （render 每点一次收藏/页签都要跑，写盘会跟着一起抖）。
   */
  async snapshotWriting() {
    if (this.settings.showWordCount === false) return null;
    const s = await this.computeStats();
    const w = s && s.words;
    if (!Number.isFinite(w)) return null;
    if (!this.writingLog || typeof this.writingLog !== 'object' || Array.isArray(this.writingLog)) {
      this.writingLog = {};
    }
    const today = todayStr();
    let changed = false;
    if (this.writingLog[today] !== w) { this.writingLog[today] = w; changed = true; }
    const keep = clampInt(this.settings.writingKeep, 7, 730, 120);
    const keys = Object.keys(this.writingLog).filter((k) => YMD_KEY.test(k)).sort();
    if (keys.length > keep) {
      for (const k of keys.slice(0, keys.length - keep)) delete this.writingLog[k];
      changed = true;
    }
    if (changed) await this.persist();
    return w;
  }

  /**
   * 同一个文件夹里给标题找一个不撞车的名字：X → X 2 → X 3 …
   * 为什么需要：`createNoteFlow` 对同名文件的处理是"直接打开已有的那篇"，
   * 而月历「新增笔记」的默认标题就是日期名 —— 同一天第二篇正好撞上第一篇，
   * 于是"点了创建"变成"打开旧的"（用户实测报的就是这个）。默认标题先让开，才不会踩到那个分支。
   */
  uniqueNameIn(folder, title) {
    const dir = normDir(folder);
    const base = String(title || '').trim();
    if (!base) return base;
    const has = (nm) => !!this.app.vault.getFileByPath(normalizePath((dir ? dir + '/' : '') + nm + '.md'));
    if (!has(base)) return base;
    for (let i = 2; i <= 200; i++) {
      const nm = base + ' ' + i;
      if (!has(nm)) return nm;
    }
    return base + ' ' + Date.now();     // 200 篇同名同日：几乎不可能，兜底别死循环
  }

  /**
   * @param {{folder?: string, template?: string, forcedName?: string, suggest?: string, ensureNew?: boolean}} opts
   */
  async createNoteFlow(opts) {
    opts = opts || {};
    if (!this.coreConfig) await this.loadConfigs();

    let name = opts.forcedName;
    if (!name) {
      const guess = opts.suggest || (opts.template ? dirName(opts.template).replace(/\.md$/, '') : '');
      name = await new Promise((resolve) => new NameModal(this.app, guess, resolve, opts.hint).open());
    }
    if (!name) return null;
    const safe = name.replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!safe) { new Notice('标题不能为空或全是非法字符'); return null; }

    const folder = String(opts.folder || '').replace(/^\/+|\/+$/g, '');
    if (folder) await this.ensureFolder(folder);
    let path = normalizePath((folder ? folder + '/' : '') + safe + '.md');

    const dup = this.app.vault.getFileByPath(path);
    if (dup) {
      if (opts.ensureNew) {
        // 用户明确是"同一天/同目录再建一篇"：名字让开照建，
        // 别把手上的"创建"偷偷换成"打开旧的"（用户报过："点了创建新笔记，还是指向原有的笔记"）
        const alt = this.uniqueNameIn(folder, safe);
        path = normalizePath((folder ? folder + '/' : '') + alt + '.md');
        new Notice('已有同名笔记，这篇存成：' + alt);
      } else {
        new Notice('已存在同名笔记，直接打开：' + dup.path);
        this.openFile(dup); return dup;
      }
    }

    let content = '';
    if (typeof opts.content === 'string' && opts.content) {
      content = opts.content;              // 月历那条路已经算好正文（含当天任务），直接用
    } else {
      const tplFile = opts.template ? this.resolveVaultFile(opts.template) : null;
      if (tplFile) {
        try { content = await this.app.vault.cachedRead(tplFile); } catch (e) { content = ''; }
        // 核心 Templates 的占位符它自己会换，但笔记是我们建的、它不插手 ⇒ 这里换掉，别留字面 {{date}}
        content = substituteTemplateTokens(content, { date: new Date(), title: safe });
      } else {
        content = '---\ncreated: ' + moment().format('YYYY-MM-DD HH:mm') + '\ntags: []\n---\n\n# ' + safe + '\n\n';
      }
    }

    let file;
    try { file = await this.app.vault.create(path, content); }
    catch (err) { new Notice('创建失败：' + (err && err.message ? err.message : err)); return null; }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true });
    this.app.workspace.revealLeaf(leaf);

    if (content.indexOf('<%') >= 0) {
      const templater = this.app.plugins && this.app.plugins.getPlugin && this.app.plugins.getPlugin('templater-obsidian');
      const engine = templater && templater.templater;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (engine && view && view.editor) {
        try {
          if (typeof engine.overwrite_file_contents === 'function') await engine.overwrite_file_contents(file, content);
          else if (typeof engine.append_template_to_active_file === 'function') await engine.append_template_to_active_file(view.editor);
          else new Notice('模板已复制；Templater 版本没有可调用接口，变量未执行');
        } catch (e) {
          new Notice('模板已复制，但 Templater 执行失败：' + (e && e.message ? e.message : e));
        }
      } else {
        new Notice('模板含 <% %> 变量，但未检测到 Templater，已原样复制');
      }
    }
    new Notice('已创建：' + file.path);
    return file;      // 月历靠这个返回值记下"这天用的是哪篇"（改了标题也认得回来）
  }
}

/* ================================================================ 设置页 */

class WorkbenchSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: '知识库工作台' });

    if (!this.plugin.coreConfig) await this.plugin.loadConfigs();
    const note = containerEl.createEl('p', { cls: 'kbwb-note' });
    const dirs = this.plugin.templateFolders();
    note.setText(dirs.length
      ? '模板文件夹：' + dirs.join('、') + '（共 ' + this.plugin.listTemplates().length + ' 个模板）｜日记设置：' + (this.plugin.coreConfig.dailyFolder || '（库根）') + ' · ' + this.plugin.coreConfig.dailyFormat
      : '未检测到 Templater 或核心「模板」插件的模板文件夹；「从模板新建」不可用，其余功能不受影响。');

    const save = debounce(async () => { await this.plugin.saveSettings(); this.plugin.refreshViews(false); }, 350, true);

    new Setting(containerEl).setName('最近编辑条数').setDesc('「最近 · 编辑」列表最多显示几篇')
      .addText((t) => t.setPlaceholder('8').setValue(String(this.plugin.settings.recentCount))
        .onChange((v) => { this.plugin.settings.recentCount = clampInt(v, 1, 50, 8); save(); }));

    new Setting(containerEl).setName('最近打开条数').setDesc('插件自己记录的打开历史条数')
      .addText((t) => t.setPlaceholder('6').setValue(String(this.plugin.settings.openedCount))
        .onChange((v) => { this.plugin.settings.openedCount = clampInt(v, 1, 40, 6); save(); }));

    new Setting(containerEl).setName('任务扫描范围').setDesc('填库内相对路径（如 实习/学习文档(md)），留空 = 全库')
      .addText((t) => t.setPlaceholder('留空为全库').setValue(this.plugin.settings.taskScope || '')
        .onChange((v) => { this.plugin.settings.taskScope = (v || '').trim(); save(); }));

    new Setting(containerEl).setName('任务排除目录').setDesc('逗号分隔的库内路径前缀；这些目录里的勾选框不算待办（默认排除导入的原始资料）')
      .addText((t) => t.setPlaceholder('raw/, upstream/').setValue(this.plugin.settings.taskExclude || '')
        .onChange((v) => { this.plugin.settings.taskExclude = (v || '').trim(); this.plugin.refreshViews(true); save(); }));

    new Setting(containerEl).setName('同文去重').setDesc('多份复制资料里重复出现的同一任务只保留一条，并标出 ×N')
      .addToggle((t) => t.setValue(!!this.plugin.settings.taskDedupe).onChange(async (v) => {
        this.plugin.settings.taskDedupe = v;
        await this.plugin.saveSettings();
        this.plugin.refreshViews(true);
      }));

    new Setting(containerEl).setName('任务显示上限').setDesc('任务卡片一次最多渲染多少条')
      .addText((t) => t.setPlaceholder('60').setValue(String(this.plugin.settings.taskLimit))
        .onChange((v) => { this.plugin.settings.taskLimit = clampInt(v, 5, 500, 60); save(); }));

    new Setting(containerEl).setName('勾选完成写入 ✅ 日期').setDesc('符合 Obsidian Tasks 插件的完成标记格式')
      .addToggle((t) => t.setValue(this.plugin.settings.markDoneDate).onChange(async (v) => {
        this.plugin.settings.markDoneDate = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName('新建笔记默认位置').setDesc('点「新建笔记」时放哪个文件夹，留空 = 库根目录')
      .addText((t) => t.setPlaceholder('例如 实习/学习文档(md)/讲解待办').setValue(this.plugin.settings.newNoteFolder || '')
        .onChange((v) => { this.plugin.settings.newNoteFolder = (v || '').trim(); save(); }));

    new Setting(containerEl).setName('速记本文件').setDesc('「速记本」卡往这个文件末尾追加一行（库内相对路径）。文件不存在时，第一次追加会自动创建它。')
      .addText((t) => t.setPlaceholder('每日笔记/速记.md').setValue(this.plugin.settings.scratchPath || '')
        .onChange((v) => { this.plugin.settings.scratchPath = (v || '').trim() || '每日笔记/速记.md'; save(); this.plugin.refreshViews(false); }));

    new Setting(containerEl).setName('速记显示条数').setDesc('速记本卡显示最近几条（新的在上）；更早的还在文件里')
      .addText((t) => t.setPlaceholder('12').setValue(String(this.plugin.settings.scratchLimit))
        .onChange((v) => { this.plugin.settings.scratchLimit = clampInt(v, 1, 200, 12); save(); this.plugin.refreshViews(false); }));

    new Setting(containerEl).setName('每日待办文件').setDesc('「待办」卡的「每日」页签与月历的当日待办，往这个文件的「## YYYY-MM-DD」小节里写（库内相对路径）。文件不存在时，第一次加一条会自动创建它。这两篇是插件自己的清单，不参与全库任务扫描。')
      .addText((t) => t.setPlaceholder('待办/每日待办.md').setValue(this.plugin.settings.todoDailyPath || '')
        .onChange((v) => { this.plugin.settings.todoDailyPath = (v || '').trim() || '待办/每日待办.md'; this.plugin._todosShared = null; save(); this.plugin.refreshViews(false); }));

    new Setting(containerEl).setName('每周待办文件').setDesc('「每周」页签写到这里，按 ISO 周分节「## YYYY-Www」（周一起算，与月历第一列一致）。')
      .addText((t) => t.setPlaceholder('待办/每周待办.md').setValue(this.plugin.settings.todoWeeklyPath || '')
        .onChange((v) => { this.plugin.settings.todoWeeklyPath = (v || '').trim() || '待办/每周待办.md'; this.plugin._todosShared = null; save(); this.plugin.refreshViews(false); }));

    new Setting(containerEl).setName('待办显示上限').setDesc('待办卡一个月历当日区一屏最多显示几条（更早的还在文件里）。1–200。')
      .addText((t) => t.setPlaceholder('20').setValue(String(this.plugin.settings.todoLimit))
        .onChange((v) => { this.plugin.settings.todoLimit = clampInt(v, 1, 200, 20); save(); this.plugin.refreshViews(false); }));

    new Setting(containerEl).setName('写作量快照保留天数').setDesc('「写作量」卡每天记一笔全库字数（存 data.json），超过这个天数就裁掉最旧的。7–730 天。')
      .addText((t) => t.setPlaceholder('120').setValue(String(this.plugin.settings.writingKeep))
        .onChange((v) => { this.plugin.settings.writingKeep = clampInt(v, 7, 730, 120); save(); }));

    new Setting(containerEl).setName('全盘扫描上限（篇）').setDesc('「笔记体检」卡里的「全盘扫描」一次最多读多少篇 .md（走文件系统，不是索引）。超出就截断并说明。100–20000。')
      .addText((t) => t.setPlaceholder('3000').setValue(String(this.plugin.settings.scanCap))
        .onChange((v) => { this.plugin.settings.scanCap = clampInt(v, 100, 20000, 3000); save(); }));

    new Setting(containerEl).setName('当日任务模板').setDesc('月历点空白日期、确认标题后，用这个模板建笔记：里面的 <!--KBWB:TASKS:due--> 等标记会被换成当天的任务。这一份也是月历确认框里【开局选中】的那一行 —— 列表就是「模板目录」里的那些文件，没有额外合成的条目。留空 = 用「日记」核心设的模板；两者都没有 = 用内置默认模板（会弹提示说明）。')
      .addText((t) => t.setPlaceholder('模板/每日任务模板.md').setValue(this.plugin.settings.dailyCreateTemplate || '')
        .onChange((v) => { this.plugin.settings.dailyCreateTemplate = (v || '').trim(); save(); }));

    new Setting(containerEl).setName('模板目录').setDesc('「新建笔记」里的模板列表、以及「新增模板」的落点，都只用这一个目录。留空 = 自动取模板夹（Templater 优先，其次核心「模板」），都没有就用「模板」。')
      .addText((t) => t.setPlaceholder('模板').setValue(this.plugin.settings.templateDir || '')
        .onChange((v) => { this.plugin.settings.templateDir = String(v || '').trim().replace(/^\/+|\/+$/g, ''); save(); }));

    new Setting(containerEl).setName('每组建任务上限').setDesc('「今天到期 / 已逾期 / 已勾掉 / 没写日期」每一组最多往笔记里写多少条任务')
      .addText((t) => t.setPlaceholder('30').setValue(String(this.plugin.settings.dailyTasksLimit))
        .onChange((v) => { this.plugin.settings.dailyTasksLimit = clampInt(v, 1, 200, 30); save(); }));

    new Setting(containerEl).setName('统计字数').setDesc('关掉后统计卡只算文件数、时间与标签')
      .addToggle((t) => t.setValue(this.plugin.settings.showWordCount).onChange(async (v) => {
        this.plugin.settings.showWordCount = v; this.plugin.statsCache = null; this.plugin.statsJob = null;
        await this.plugin.saveSettings(); this.plugin.refreshViews(true);
      }));

    new Setting(containerEl).setName('字数统计上限').setDesc('最多读取多少篇笔记来估算总字数')
      .addText((t) => t.setPlaceholder('4000').setValue(String(this.plugin.settings.wordCountCap))
        .onChange((v) => { this.plugin.settings.wordCountCap = clampInt(v, 200, 20000, 4000); this.plugin.statsCache = null; save(); }));

    new Setting(containerEl).setName('悬停特效').setDesc('光斑跟随、卡片强调、顶栏扫描线等。若发现悬停时文字瞬时发糊（Windows 合成层常见），关掉即可')
      .addToggle((t) => t.setValue(this.plugin.settings.hoverFx !== false).onChange(async (v) => {
        this.plugin.settings.hoverFx = v;
        await this.plugin.saveSettings();
        this.plugin.refreshViews(false);
      }));

    containerEl.createEl('h3', { text: '字体' });
    containerEl.createEl('p', { cls: 'kbwb-note', text: '候选族名都在本机 Chromium 里实测命中（MiSans-Regular、Noto Sans SC、JetBrains Mono 这类命中失败，故未列入）。' });

    new Setting(containerEl).setName('界面字体').setDesc('只作用于工作台视图，不改 Obsidian 全局')
      .addDropdown((d) => {
        d.addOption('', '跟随 Obsidian');
        Object.keys(FONT_UI).filter((k) => k).forEach((k) => d.addOption(k, FONT_UI_LABEL[k] || k));
        d.setValue(this.plugin.settings.uiFont || '').onChange(async (v) => {
          this.plugin.settings.uiFont = v || '';
          await this.plugin.saveSettings();
          this.plugin.refreshViews(false);
        });
      });

    new Setting(containerEl).setName('数字 / 等宽字体').setDesc('统计数字、chip、时间、编号用的那套')
      .addDropdown((d) => {
        d.addOption('', '跟随 Obsidian');
        Object.keys(FONT_NUM).filter((k) => k).forEach((k) => d.addOption(k, FONT_NUM_LABEL[k] || k));
        d.setValue(this.plugin.settings.numFont === undefined ? 'Consolas' : (this.plugin.settings.numFont || ''))
          .onChange(async (v) => {
            this.plugin.settings.numFont = v || '';
            await this.plugin.saveSettings();
            this.plugin.refreshViews(false);
          });
      });

    new Setting(containerEl).setName('工作台停靠位置').setDesc('默认左侧栏；改这里会把已打开的工作台搬到新位置')
      .addDropdown((d) => {
        d.addOption('left', '左侧栏').addOption('right', '右侧栏').addOption('main', '主区域新标签页');
        d.setValue(this.plugin.settings.openWhere || 'left').onChange(async (v) => {
          this.plugin.settings.openWhere = v;
          await this.plugin.saveSettings();
          this.plugin.relocateView();
        });
      });

    const minNum = (name, desc, key, max) => new Setting(containerEl).setName(name).setDesc(desc)
      .addText((t) => {
        t.setPlaceholder('0 = 不限制').setValue(String(this.plugin.settings[key] || 0))
          .onChange(async (v) => {
            const n = clampInt(v, 0, max, 0);
            this.plugin.settings[key] = n;
            await this.plugin.saveSettings();
            this.plugin.refreshViews(false);
          });
      });
    minNum('面板最小宽度', '拖分割线比这更窄时不再继续缩，避免工作台被挤到不可用。侧栏 300px 以下本来就会退化成单列，所以 300 是个合适的地板。', 'minPaneWidth', 2000);
    minNum('面板最小高度', '主区域上下分屏时，工作台不会被压到比这更矮。', 'minPaneHeight', 2000);

    new Setting(containerEl).setName('用现在的尺寸当基准').setDesc('按你此刻面板的实际大小设地板：先摆成你满意的尺寸，再点下面的按钮。量的是真正被限制的那个元素（侧栏 / 分屏里的 tabs）。')
      .addButton((b) => {
        b.setButtonText('取当前高度').onClick(() => {
          const px = this.plugin.capturePaneMin('height');
          new Notice(px ? ('面板最小高度已设为 ' + px + 'px') : '没找到已打开的工作台面板');
        });
      })
      .addButton((b) => {
        b.setButtonText('取当前宽度').onClick(() => {
          const px = this.plugin.capturePaneMin('width');
          new Notice(px ? ('面板最小宽度已设为 ' + px + 'px') : '没找到已打开的工作台面板');
        });
      });

    const chainP = containerEl.createEl('p', { cls: 'kbwb-note' });
    const paintChain = () => {
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      const v = leaf && leaf.view;
      if (!v || typeof v.paneChainInfo !== 'function') {
        chainP.setText('工作台没打开，检测不到层级——先打开工作台再点「重新检测」。');
        return;
      }
      const label = (el) => {
        if (!el) return '（没找到）';
        const cls = typeof el.className === 'string' ? String(el.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
        return (el.tagName || '?').toLowerCase() + (cls ? '.' + cls : '');
      };
      const hs = typeof v.minTargetsFor === 'function' ? v.minTargetsFor('height') : [v.minTargetFor('height')];
      const ws = typeof v.minTargetsFor === 'function' ? v.minTargetsFor('width') : [v.minTargetFor('width')];
      chainP.setText(
        '最小尺寸现在施加在：高度 = ' + (hs.map(label).join(' + ') || '（没找到）') +
        '｜宽度 = ' + (ws.map(label).join(' + ') || '（没找到）') + '\n' +
        '从视图容器往上：' + v.paneChainInfo().map((c) => c.depth + '·' + c.label + ' ' + c.w + '×' + c.h).join('  →  ') +
        '（垂直方向还压不住就把这两行原样发我；也可换个层级再点「取当前高度」）');
    };

    new Setting(containerEl).setName('最小尺寸施加在哪一层').setDesc('默认「自动」= 把链上只属于这个面板的几层一起压上（分屏的直接子元素 + .workspace-tabs + .workspace-leaf），不再猜一层。若还想单独试某一层，在下面选它。')
      .addDropdown((d) => {
        d.addOption('auto', '自动（推荐）')
          .addOption('tabs', '.workspace-tabs')
          .addOption('leaf', '.workspace-leaf')
          .addOption('split', '最近的 .workspace-split')
          .addOption('dock', '整条侧栏')
          .addOption('self', '视图容器自己');
        d.setValue(this.plugin.settings.minPaneTarget || 'auto').onChange(async (v) => {
          this.plugin.settings.minPaneTarget = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews(false);
          paintChain();
        });
      });

    new Setting(containerEl).setName('检测面板层级').setDesc('上面那行「最小尺寸现在施加在…」就是当前生效的元素。')
      .addButton((b) => { b.setButtonText('重新检测').onClick(() => paintChain()); });
    paintChain();

    containerEl.createEl('h3', { text: '模块画板' });
    containerEl.createEl('p', {
      cls: 'kbwb-note',
      text: '网格是 48 列 × 8px 行（宽度每档 = 面板宽/48，1200px 下面板约 25px 一跳）。工作台里【按住卡片标题栏】就能拖到任意位置（居中的小抓手已按你的要求去掉），拖右/下/右下角可改宽高；⋯ 菜单有尺寸预设、折叠、隐藏与自动排列。下面也能直接填坐标。',
    });
    const mods = containerEl.createDiv({ cls: 'kbwb-mods' });
    const paintMods = () => {
      mods.empty();
      const list = this.plugin.layoutList();
      list.forEach((s, i) => {
        const mod = MODULES.find((m) => m.id === s.id);
        const row = mods.createDiv({ cls: 'kbwb-modrow' });
        row.createSpan({ cls: 'kbwb-mod-name', text: (mod ? mod.title : s.id) });

        const num = (label, val, min, max, onSet) => {
          row.createSpan({ cls: 'kbwb-mod-lab', text: label });
          const inp = row.createEl('input', { cls: 'kbwb-mod-num', type: 'number', attr: { min: String(min), max: String(max) } });
          inp.value = String(val);
          inp.addEventListener('change', async () => {
            const v = parseInt(inp.value, 10);
            if (Number.isFinite(v)) await onSet(Math.max(min, Math.min(max, v)));
            paintMods();
            this.plugin.refreshViews(false);
          });
        };
        num('列', s.col, 1, GRID_COLS, (v) => this.plugin.setBox(s.id, { col: v }));
        num('行', s.row, 1, 600, (v) => this.plugin.setBox(s.id, { row: v }));
        num('宽', s.w, MIN_W, GRID_COLS, (v) => this.plugin.setBox(s.id, { w: v }));
        num('高', s.h, MIN_H, 400, (v) => this.plugin.setBox(s.id, { h: v }));

        const fold = row.createEl('button', { cls: 'kbwb-mod-btn', text: s.collapsed ? '展开' : '折叠', attr: { title: '折叠后不扫描内容' } });
        fold.addEventListener('click', async () => { await this.plugin.setCollapsed(s.id, !s.collapsed); paintMods(); this.plugin.refreshViews(false); });

        const on = row.createEl('button', { cls: 'kbwb-mod-btn' + (s.on ? '' : ' is-off'), text: s.on ? '显示中' : '已隐藏' });
        on.addEventListener('click', async () => { await this.plugin.setModuleOn(s.id, !s.on); paintMods(); this.plugin.refreshViews(false); });
      });
      const tidy = mods.createEl('button', { cls: 'kbwb-mod-reset', text: '自动排列（保留尺寸，消除重叠）' });
      tidy.addEventListener('click', async () => {
        await this.plugin.tidyLayout();
        paintMods();
        this.plugin.refreshViews(false);
      });
      const reset = mods.createEl('button', { cls: 'kbwb-mod-reset', text: '恢复默认布局（位置 / 尺寸 / 显隐 / 折叠）' });
      reset.addEventListener('click', async () => {
        await this.plugin.resetLayout();
        paintMods();
        this.plugin.refreshViews(true);
        new Notice('布局已恢复默认');
      });
    };
    paintMods();

    new Setting(containerEl).setName('自动刷新间隔（秒）').setDesc('0 = 关闭。笔记增删改会即时刷新，这个定时器主要重算统计')
      .addText((t) => t.setPlaceholder('60').setValue(String(this.plugin.settings.autoRefresh))
        .onChange((v) => { this.plugin.settings.autoRefresh = clampInt(v, 0, 3600, 60); save(); new Notice('自动刷新间隔要重载插件（或重启 Obsidian）后才生效'); }));

    new Setting(containerEl).setName('清空打开历史与收藏').setDesc('只清这两份记录，笔记本体不受影响')
      .addButton((b) => {
        b.setButtonText('清空').setWarning().onClick(async () => {
          this.plugin.recentOpenedList = [];
          this.plugin.pins = [];
          await this.plugin.persist();
          this.plugin.refreshViews(true);
          new Notice('已清空打开历史与收藏');
        });
      });

    containerEl.createEl('h3', { text: '快捷新建按钮' });
    containerEl.createEl('p', { cls: 'kbwb-note', text: '每项 = 按钮名 + 保存文件夹 + 模板路径（都是库内相对路径）。勾选「日期前缀」会把按钮名后面接上时间戳当标题。' });
    const wrap = containerEl.createDiv({ cls: 'kbwb-qbwrap' });
    const paint = () => {
      wrap.empty();
      const list = this.plugin.settings.quickButtons;
      if (!list.length) wrap.createEl('p', { cls: 'kbwb-note', text: '（还没有自定义按钮）' });
      list.forEach((item, i) => {
        const r = wrap.createDiv({ cls: 'kbwb-qbrow' });
        const nameEl = r.createEl('input', { cls: 'kbwb-input kbwb-qb-name', type: 'text', placeholder: '按钮名' });
        nameEl.value = item.label || '';
        nameEl.addEventListener('change', () => { item.label = nameEl.value; save(); });
        const folderEl = r.createEl('input', { cls: 'kbwb-input kbwb-qb-folder', type: 'text', placeholder: '文件夹（可空）' });
        folderEl.value = item.folder || '';
        folderEl.addEventListener('change', () => { item.folder = folderEl.value.trim(); save(); });
        const tplEl = r.createEl('input', { cls: 'kbwb-input kbwb-qb-tpl', type: 'text', placeholder: '模板路径，如 模板/讲解待办.md（可空）' });
        tplEl.value = item.template || '';
        tplEl.addEventListener('change', () => { item.template = tplEl.value.trim(); save(); });
        const pre = r.createEl('input', { type: 'checkbox', cls: 'kbwb-qb-pre' });
        pre.checked = !!item.prefix;
        pre.setAttr('title', '日期前缀');
        pre.addEventListener('change', () => { item.prefix = pre.checked; save(); });
        r.createSpan({ cls: 'kbwb-qb-prelabel', text: '前缀' });
        const del = r.createEl('button', { text: '删除', cls: 'kbwb-qb-del' });
        del.addEventListener('click', async () => {
          list.splice(i, 1);
          await this.plugin.saveSettings();
          paint();
          this.plugin.refreshViews(false);
        });
      });
      wrap.createEl('button', { text: '+ 添加一个按钮', cls: 'kbwb-qb-add' }).addEventListener('click', async () => {
        list.push({ label: '新按钮', folder: '', template: '', prefix: false });
        await this.plugin.saveSettings();
        paint();
        this.plugin.refreshViews(false);
      });
    };
    paint();

    containerEl.createEl('h3', { text: '命令一览' });
    const cmds = containerEl.createEl('ul', { cls: 'kbwb-cmds' });
    for (const t of [
      '打开工作台 / 关闭工作台 / 刷新工作台',
      '新建笔记 · 新建或打开今日笔记 · 从模板新建笔记',
      '把当前笔记收藏／取消收藏到工作台',
    ]) cmds.createEl('li', { text: t });
  }
}

/* ================================================================ 导出 */

module.exports = KbWorkbenchPlugin;
module.exports.default = KbWorkbenchPlugin;
/* 把模块作用域里的纯函数挂出来：测试（和以后的脚本）能直接喂假数据验模板填充，
   不用为了测一行字符串替换去搭整个 vault。运行时行为不变。 */
module.exports.fillTaskMarkers = fillTaskMarkers;
module.exports.substituteTemplateTokens = substituteTemplateTokens;
module.exports.taskLineForTemplate = taskLineForTemplate;
module.exports.fmtDate = fmtDate;
module.exports.KBWB_TASKS_MARK = KBWB_TASKS_MARK;
module.exports.KBWB_GENERATED_MARK = KBWB_GENERATED_MARK;
module.exports.KBWB_DEFAULT_DAILY_TASKS = KBWB_DEFAULT_DAILY_TASKS;
module.exports.dailyTasksTemplateShape = dailyTasksTemplateShape;
module.exports.normDir = normDir;
module.exports.firstFreeRow = firstFreeRow;
/* 第三十二轮：待办清单的纯函数（测试直接喂假正文，不用搭整个 vault） */
module.exports.isoWeekOf = isoWeekOf;
module.exports.isoWeekKey = isoWeekKey;
module.exports.shiftWeekKey = shiftWeekKey;
module.exports.weekSpanText = weekSpanText;
module.exports.parseTodoSections = parseTodoSections;
module.exports.todoSectionFor = todoSectionFor;
module.exports.todoOpenKeys = todoOpenKeys;
module.exports.todoOpenCounts = todoOpenCounts;
module.exports.addTodoInSection = addTodoInSection;
module.exports.setTodoDoneAt = setTodoDoneAt;
module.exports.dropTodoLine = dropTodoLine;
module.exports.findTodoLine = findTodoLine;
