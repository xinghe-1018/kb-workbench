'use strict';
/*
 * obsidian 模块的最小桩：只用于在 Node 里加载 kb-workbench/main.js 并验证
 * 数据层逻辑（不涉及真实 DOM 的部分）。真实运行时这些名字来自 Obsidian 本体。
 */

class Component {
  addChild(c) { return c; }
  removeChild(c) { return this; }
  registerEvent() { return {}; }
  registerInterval(id) { return id; }
  registerDomEvent() {}
  load() { return this; }
  unload() {}
}

class Events {
  constructor() { this._ev = {}; }
  on(name, cb) { (this._ev[name] = this._ev[name] || []).push(cb); return { name }; }
  off() {}
  trigger(name, ...args) { (this._ev[name] || []).forEach((cb) => cb(...args)); }
}

class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest || { id: 'kb-workbench' };
  }
  registerView() {}
  addRibbonIcon() { return { addEventListener() {} }; }
  addCommand() { return {}; }
  addSettingTab() {}
  registerEvent() { return {}; }
  registerInterval(id) { return id; }
  async loadData() { return this.__data || null; }
  async saveData(d) { this.__data = d; return undefined; }
}

class View extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf && leaf.app;
    this.containerEl = { empty() {}, addClass() {}, isConnected: true };
    // contentEl 由测试的 DOM 垫片提供（getter/setter 挂在原型上）
  }
}

class ItemView extends View {}

/**
 * Modal 桩：测试里要真的驱动确认框（月历点空白日期 → 改名 → 创建 / 取消），
 * 所以 open() 要调 onOpen()、close() 要调 onClose()。
 * contentEl 由测试注入（stub.Modal.__makeEl = (tag) => new dom.El(tag)）；
 * 没注入时保持原来的"哑对象"行为，数据层测试不受影响（也永远不会走进弹框分支）。
 */
const dumbEl = () => {
  const o = { empty() {}, value: '', focus() {}, select() {}, addEventListener() {}, setText() {} };
  o.createEl = () => o; o.createDiv = () => o; o.createSpan = () => o;
  return o;
};
class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = Modal.__makeEl ? Modal.__makeEl('div') : dumbEl();
    this.isOpen = false;
  }
  open() {
    Modal.last = this;                      // 测试要能拿到这个框：改标题、点「创建」/「取消」
    this.isOpen = true;
    if (Modal.__makeEl && typeof this.onOpen === 'function') this.onOpen();
  }
  close() { this.isOpen = false; if (typeof this.onClose === 'function') this.onClose(); }
}

class SuggestModal extends Modal {
  setPlaceholder() {}
  // 建议框要的是 Obsidian 的输入建议 UI，桩里不模拟：保持哑行为
  open() { this.isOpen = true; }
  close() { this.isOpen = false; }
}

class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addToggle() { return this; }
  /** DropdownComponent 形状：addOption/setValue/onChange，fire 供测试触发 */
  addDropdown(cb) {
    const d = Setting.lastDropdown = {
      _opts: [], _v: '', _fn: null,
      addOption(v, label) { this._opts.push([v, label]); return this; },
      addOptions(map) { Object.keys(map || {}).forEach((k) => this._opts.push([k, map[k]])); return this; },
      setValue(v) { this._v = v; return this; },
      onChange(fn) { this._fn = fn; return this; },
      fire(v) { if (this._fn) return this._fn(v === undefined ? this._v : v); },
    };
    if (cb) cb(d);
    return this;
  }
  /** ButtonComponent 形状：链式 + onClick 可被测试触发 */
  addButton(cb) {
    const btn = Setting.lastButton = {
      _label: '',
      setButtonText(t) { this._label = t; return this; },
      setTooltip() { return this; },
      setCta() { return this; },
      setWarning() { this._warning = true; return this; },   // 真实 ButtonComponent 有这个方法（缺它会把 display() 炸掉）
      onClick(fn) { this._fn = fn; return this; },
      fire() { if (this._fn) return this._fn(); },
    };
    if (cb) cb(btn);
    return this;
  }
}

class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = { empty() {} }; }
  display() {}
}

class Notice {
  constructor(msg) { Notice.last = String(msg); }
}

class TFile {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
    this.basename = this.name.replace(/\.[^.]+$/, '');
    this.extension = this.name.includes('.') ? this.name.split('.').pop() : '';
    this.stat = { ctime: 0, mtime: 0, size: 0 };
  }
}

class TFolder {
  constructor(path) { this.path = path; this.name = path.split('/').pop(); this.children = []; }
}

class MarkdownView extends View {
  constructor(app) { super({ app }); this.file = null; this.editor = { getValue() { return ''; }, getCursor() { return { line: 0, ch: 0 }; } }; }
}

/**
 * 与真实 Obsidian 一致的实现（第二十七轮从 obsidian.asar 里抠出来对齐的，别再"自己猜一个"）：
 *   function uu(e){ return ""===(e=e.replace(/([\\/])+/g,"/").replace(/(^\/+|\/+$)/g,"")) && (e="/"), e }
 *   function cu(e){ return trim(uu(e)).normalize("NFC") }        // = normalizePath
 * 关键在 `&&(e="/")`：**空串进去，"/" 出来**。
 * 旧桩返回 ''，于是 `if (normalizePath(x))` 这类判空在测试里成立、在真机上恒成立 ——
 * templateDir() 的"留空 = 自动取模板夹"就是这么在真机上被跳过的（用户截图「模板（/）」）。
 */
function normalizePath(p) {
  let e = String(p === undefined || p === null ? '' : p)
    .replace(/([\\/])+/g, '/')
    .replace(/(^\/+|\/+$)/g, '');
  if (e === '') e = '/';
  return e.trim().normalize('NFC');
}

function debounce(fn) {
  const wrapped = function () { return fn.apply(this, arguments); };
  wrapped.cancel = () => {};
  wrapped.run = () => fn();
  return wrapped;
}

function setIcon() {}
function getAllTags(cache) {
  if (!cache || !cache.tags) return null;
  return cache.tags.map((t) => (t.tag.charAt(0) === '#' ? t.tag : '#' + t.tag));
}

const moment = (input) => {
  const d = input ? new Date(input) : new Date('2026-11-03T10:00:00+08:00');
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return {
    format(fmt) {
      return String(fmt)
        .replace(/YYYY/g, String(d.getFullYear()))
        .replace(/MM/g, pad(d.getMonth() + 1))
        .replace(/DD/g, pad(d.getDate()))
        .replace(/HH/g, pad(d.getHours()))
        .replace(/mm/g, pad(d.getMinutes()));
    },
  };
};

module.exports = {
  Component, Events, Plugin, View, ItemView, Modal, SuggestModal, Setting,
  PluginSettingTab, Notice, TFile, TFolder, MarkdownView,
  normalizePath, debounce, setIcon, getAllTags, moment,
};