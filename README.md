# 知识库工作台 · KB Workbench

一个 Obsidian 插件：把「搜索、新建、收藏、任务、统计、体检、日历、速记」等十几件日常小事收进**一个工作台视图**，替代一屏散落的侧边栏面板。

- **零网络请求**：插件内没有 `requestUrl` / `fetch`，不联网、不上传、不统计。
- **零构建、零依赖**：只有 `main.js` + `styles.css` + `manifest.json` 三个文件，装进 vault 即用。
- **写入只走 `vault.process()` 行级改写**：改待办、写速记不会重排你的笔记结构，也不会触发整库同步风暴。
- 桌面端与移动端通用（`isDesktopOnly: false`），最低 Obsidian **1.4.0**。

## 安装

社区市场尚未上架，手动安装：

```bash
git clone https://github.com/xinghe-1018/kb-workbench.git
mkdir -p "<你的笔记库>/.obsidian/plugins/kb-workbench"
cp main.js styles.css manifest.json "<你的笔记库>/.obsidian/plugins/kb-workbench/"
```

重启 Obsidian → 设置 → 第三方插件 → 启用「知识库工作台」。

## 十四张卡

| 卡片 | 做什么 |
|---|---|
| 搜索笔记 | 全文搜索，回车打开，支持键盘上下选 |
| 快捷新建 | 按模板新建笔记（日记 / 会议 / 临时） |
| 收藏 | 钉住常用笔记，一键跳转 |
| 最近 | 最近打开 / 最近修改 |
| 任务 | 汇总全库 `- [ ]` 待办，就地勾选回写 |
| 知识库 | 目录树快速定位 |
| 库统计 | 笔记数、字数、标签数、附件体积 |
| 笔记体检 | 空笔记、断链、重复标题、孤立笔记；可选磁盘全盘扫描 |
| 到期日历 | 带 `@date` 的任务按日期聚合 |
| 速记本 | 随手记一行，落到当日速记文件 |
| 标签总览 | 标签分布，支持框选多选批量筛选 |
| 月历 | 点日期看当日待办，红点标记有任务的日期 |
| 写作量 | 按日/周统计新增字数 |
| 待办 | 每日 / 每周任务视图 |

每张卡可单独开关、可拖动排序，布局存 `data.json`（本地，不上传）。

## 测试

渲染层用 Obsidian 桩 + DOM 垫片在 Node 里跑，不依赖桌面客户端：

```bash
# 单元/行为断言
KBWB_VAULT=/path/to/your/vault node test/harness.js
# 渲染层断言（读 styles.css 与 DOM 结构）
KBWB_VAULT=/path/to/your/vault node test/render-harness.js
# 性能基准
KBWB_VAULT=/path/to/your/vault node test/bench.js
```

当前：**324 项行为断言 + 708 项渲染断言全绿**。`KBWB_VAULT` 指向任意真实笔记库（测试只在临时副本上写）。

## 设计取舍

- **不引入构建链**：没有 bundler、没有 TypeScript 编译步骤，`main.js` 就是源码，便于在客户端内直接调试、也便于用户审计。
- **不做云同步**：插件只管本机 vitault 内的读写，同步交给 Obsidian Sync / Git 插件。
- **改动最小化**：所有写入都按行替换，保留原有 frontmatter、缩进与空行。
- **性能优先局部重绘**：月历翻月只重绘变化的日期格（实测新元素 1750 → 154，约 -91%）。

## 许可

MIT · © 2026 徐嘉明 (xinghe-1018)

---

### English

An Obsidian plugin that gathers 14 daily micro-tasks (search, new note, favorites, recent, tasks, vault stats, health check, due-date calendar, scratchpad, tag overview, month view, writing stats, todo) into one workbench view. No network requests, no build step, no dependencies — three files, drop into your vault. Writes are line-level via `vault.process()`. Tests run in plain Node with an Obsidian stub (324 behaviour + 708 render assertions). MIT licensed.
