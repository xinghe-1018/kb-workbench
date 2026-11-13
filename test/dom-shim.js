'use strict';
/*
 * 极简 DOM 垫片：实现 Obsidian 注入到 HTMLElement 上的那批扩展方法
 * （createDiv / createSpan / createEl / empty / setText / setAttr /
 *   addClass / removeClass / toggleClass / hide / show / findAll / find），
 * 让 WorkbenchView.render() 能在 Node 里真跑一遍。
 */

let uid = 0;

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._text = '';
    this._classes = new Set();
    this._attrs = {};
    this._listeners = {};
    this.dataset = {};
    const styleStore = new Map();
    const styleTarget = {
      setProperty(k, v) { styleStore.set(k, String(v)); },
      getPropertyValue(k) { return styleStore.get(k) || ''; },
      removeProperty(k) { styleStore.delete(k); },
      get cssText() { return Array.from(styleStore, ([k, v]) => k + ':' + v).join(';'); },
    };
    // 记录每一次内联样式写入：手势测试靠它数"一帧里写了几次 transform"
    this._styleWrites = [];
    const self = this;
    this.style = new Proxy(styleTarget, {
      set(t, k, v) {
        t[k] = v;
        if (typeof k === 'string') self._styleWrites.push(k);
        return true;
      },
    });
    this._styleStore = styleStore;
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes.add(x)),
      remove: (...c) => c.forEach((x) => this._classes.delete(x)),
      contains: (c) => this._classes.has(c),
    };
    this.isConnected = true;
    this.scrollTop = 0;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.uid = ++uid;
  }

  /* --- 结构 --- */
  appendChild(child) { child.parentNode = this; this.children.push(child); child._setConnected(true); return child; }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child._setConnected(false);
    return child;
  }
  /** 真实 DOM 的 insertBefore：单卡重建要靠它把新卡插回原位 */
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    node.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    node._setConnected(true);
    return node;
  }
  /** 真实 DOM 里被摘掉的子树 isConnected=false；手势代码就靠这个判断"节点还在不在" */
  _setConnected(v) {
    this.isConnected = v;
    for (const c of this.children) c._setConnected(v);
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v); this.children = []; }

  /* --- Obsidian DOM 扩展 --- */
  empty() { this.children.forEach((c) => c._setConnected(false)); this.children = []; this._text = ''; return this; }
  setText(v) { this._text = String(v); return this; }
  setAttr(k, v) { this._attrs[k] = v; return this; }
  getAttr(k) { return this._attrs[k]; }
  addClass(...c) { c.flat().forEach((x) => String(x).split(/\s+/).filter(Boolean).forEach((y) => this._classes.add(y))); return this; }
  removeClass(...c) { c.flat().forEach((x) => String(x).split(/\s+/).filter(Boolean).forEach((y) => this._classes.delete(y))); return this; }
  toggleClass(c, on) {
    const list = (Array.isArray(c) ? c : [c]).flatMap((x) => String(x).split(/\s+/).filter(Boolean));
    list.forEach((x) => (on ? this._classes.add(x) : this._classes.delete(x)));
    return this;
  }
  hasClass(c) { return this._classes.has(c); }
  hide() { this._hidden = true; return this; }
  show() { this._hidden = false; return this; }
  focus() { this._focused = true; }
  select() {}
  setSelectionRange() {}
  /* 指针捕获（手势期间保证 pointerup 一定回到手柄） */
  setPointerCapture(id) { this.__capture = id; return undefined; }
  releasePointerCapture(id) { if (this.__capture === id) this.__capture = null; return undefined; }
  hasPointerCapture(id) { return this.__capture === id; }

  createEl(tag, o) {
    const el = new El(tag);
    applyInfo(el, o);
    return this.appendChild(el);
  }
  createDiv(o) { return this.createEl('div', o); }
  createSpan(o) { return this.createEl('span', o); }

  findAll(selector) {
    const out = [];
    const match = makeMatcher(selector);
    const walk = (node) => {
      for (const c of node.children) { if (match(c)) out.push(c); walk(c); }
    };
    walk(this);
    return out;
  }
  find(selector) { return this.findAll(selector)[0] || null; }
  /** 真实 DOM 的 closest：含自身与祖先，逗号分隔的多选择器都要支持 */
  closest(selector) {
    const match = makeMatcher(selector);
    let node = this;
    while (node) { if (match(node)) return node; node = node.parentNode; }
    return null;
  }
  querySelector(selector) { return this.find(selector); }
  querySelectorAll(selector) { return this.findAll(selector); }

  addEventListener(type, cb) {
    (this._listeners[type] = this._listeners[type] || []).push(cb);
  }
  removeEventListener(type, cb) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((x) => x !== cb);
  }
  fire(type, ev) {
    (this._listeners[type] || []).slice().forEach((cb) => cb(Object.assign({
      preventDefault() {}, stopPropagation() {}, target: this, currentTarget: this,
    }, ev)));
  }
  /* 布局：给一个稳定的假 rect，够手势数学用（1200px 宽 → 每列 100px） */
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 640, width: 1200, height: 640 };
  }
  scrollIntoView() { this._scrolled = true; }
  click() { this.fire('click', {}); }

  /* --- 断言帮手 --- */
  classes() { return Array.from(this._classes); }
  dump() { return { tag: this.tagName, cls: this.classes(), text: this.textContent.slice(0, 80), children: this.children }; }
}

function applyInfo(el, o) {
  if (!o) return;
  if (o.cls) el.addClass(o.cls);
  if (o.text !== undefined) el.setText(o.text);
  if (o.type) el.setAttr('type', o.type);
  if (o.placeholder) el.setAttr('placeholder', o.placeholder);
  if (o.value !== undefined) el.value = o.value;
  if (o.attr) Object.keys(o.attr).forEach((k) => el.setAttr(k, o.attr[k]));
}

/** 支持 ".class"、"tag"、".a.b" 复合类，以及逗号分隔的组合（closest 的排除表要用） */
function makeMatcher(selector) {
  const parts = String(selector || '').split(',').map((s) => s.trim()).filter(Boolean);
  const tests = parts.map((p) => {
    const classes = (p.match(/\.[\w-]+/g) || []).map((s) => s.slice(1));
    const tag = p.replace(/\.[\w-]+/g, '').trim().toUpperCase();
    return (el) => {
      if (tag && el.tagName !== tag) return false;
      if (!tag && !classes.length) return false;
      return classes.every((c) => el._classes.has(c));
    };
  });
  return (el) => tests.some((t) => t(el));
}

function createRoot() {
  const root = new El('div');
  root.isConnected = true;
  return root;
}

module.exports = { El, createRoot, applyInfo };