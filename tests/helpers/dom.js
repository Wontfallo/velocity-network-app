// Deliberately small DOM contract harness, not a browser or layout emulator.
// It models tree ownership (textContent removes descendants), select defaults,
// events, table insertion, plain-text rendering, and the canvas API used by app.js.
const decode = value => String(value).replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&nbsp;':' '}[entity]));
const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

class EventTarget {
  constructor(owner) { this.owner = owner; this.listeners = new Map(); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(fn => fn !== callback));
  }
  async fire(type, event = {}) {
    const value = {type, target:this, preventDefault() { this.defaultPrevented = true; }, ...event};
    for (const callback of this.listeners.get(type) || []) {
      try { await callback(value); }
      catch (error) { this.owner.errors.push(error); throw error; }
    }
  }
}

class Element extends EventTarget {
  constructor(tag, owner) {
    super(owner); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.attributes = new Map(); this.style = {}; this._text = ''; this._value = undefined;
    this.disabled = false; this.hidden = false; this.clientWidth = 600; this.clientHeight = 150;
    this.scrollHeight = 0; this.scrollTop = 0;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' ').trim(); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const present = this.className.split(/\s+/).includes(name), next = force ?? !present;
        this.classList[next ? 'add' : 'remove'](name); return next;
      },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.attributes.set('id', String(value)); }
  get className() { return this.attributes.get('class') || ''; }
  set className(value) { this.attributes.set('class', String(value)); }
  get type() { return this.attributes.get('type') || ''; }
  set type(value) { this.attributes.set('type', String(value)); }
  get value() {
    if (this.tagName === 'SELECT') {
      const options = this.querySelectorAll('option');
      if (this._value !== undefined) return options.some(o => o.value === this._value) ? this._value : '';
      return (options.find(o => o.attributes.has('selected')) || options[0])?.value || '';
    }
    return this._value ?? this.attributes.get('value') ?? (this.tagName === 'OPTION' ? this.textContent : '');
  }
  set value(value) { this._value = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value ?? ''); }
  // Any HTML-based insertion in production code must receive explicit scrutiny.
  set innerHTML(_value) { throw new Error('Unexpected innerHTML write: plain-text rendering contract violated'); }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'disabled') this.disabled = true;
    if (key === 'hidden') this.hidden = true;
    if (key === 'value') this._value = String(value);
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) {
    this.attributes.delete(key);
    if (key === 'disabled') this.disabled = false;
    if (key === 'hidden') this.hidden = false;
  }
  append(...elements) {
    for (const element of elements) {
      element.remove(); element.parentNode = this; this.children.push(element);
    }
  }
  replaceChildren(...elements) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = []; this._text = '';
    if (this.tagName === 'SELECT') this._value = undefined;
    this.append(...elements);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  insertRow() { const element = new Element('tr', this.owner); this.append(element); return element; }
  insertCell() { const element = new Element('td', this.owner); this.append(element); return element; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(s => s.trim());
    const matches = element => selectors.some(s => {
      const m = /^([\w-]+)?(?:\[([\w-]+)="([^"]*)"\])?$/.exec(s);
      if (!m) throw new Error(`Unsupported harness selector: ${s}`);
      return (!m[1] || element.tagName === m[1].toUpperCase()) && (!m[2] || element.getAttribute(m[2]) === m[3]);
    });
    const result = [];
    const visit = node => node.children.forEach(child => { if (matches(child)) result.push(child); visit(child); });
    visit(this); return result;
  }
  focus() { this.owner.activeElement = this; }
  select() { this.owner.selectedElement = this; }
  click() {
    if (this.disabled) return Promise.resolve();
    if (this.tagName === 'A') this.owner.downloads.push({href:this.href, download:this.download});
    return this.fire('click');
  }
  getContext(type) {
    if (this.tagName !== 'CANVAS' || type !== '2d') throw new Error('Unexpected canvas context');
    return new Proxy({}, {get: (target, key) => target[key] || (() => {}), set: (target, key, value) => { target[key] = value; return true; }});
  }
}

export function memoryStorage(seed = []) {
  const values = new Map(seed);
  return {getItem:key => values.get(key) ?? null, setItem:(key,value) => values.set(key,String(value)), removeItem:key => values.delete(key), values};
}

export function createDOM(html) {
  const state = {errors:[], downloads:[], activeElement:null};
  const root = new Element('document', state);
  const document = new EventTarget(state);
  document.hidden = false;
  document.createElement = tag => new Element(tag, state);
  document.getElementById = id => {
    const visit = node => { if (node.id === id) return node; for (const child of node.children) { const result = visit(child); if (result) return result; } return null; };
    return visit(root);
  };
  document.querySelectorAll = selector => root.querySelectorAll(selector);
  Object.defineProperty(document, 'activeElement', {get:() => state.activeElement});
  const source = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const stack = [root];
  for (const token of source.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[\w:-]+(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>|[^<]+/g) || []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const tag = /^<\/([^\s>]+)/.exec(token)[1].toUpperCase();
      const i = stack.findLastIndex(element => element.tagName === tag);
      if (i > 0) stack.length = i;
    } else if (token.startsWith('<')) {
      const match = /^<([\w:-]+)/.exec(token), tag = match[1].toLowerCase();
      const element = new Element(tag, state);
      for (const attr of token.slice(match[0].length).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        element.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
      }
      stack.at(-1).append(element);
      if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(element);
    } else stack.at(-1)._text += decode(token);
  }
  document.body = root.querySelector('body');
  const window = new EventTarget(state);
  window.devicePixelRatio = 1; window.confirm = () => true; window.prompt = () => null;
  return {document, window, state, root};
}
