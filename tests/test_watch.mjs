// Exercise refresh and scroll restoration without browser control or dependencies.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../watch_adapter.js', import.meta.url), 'utf8');
function page(options = {}) {
  const timers = [], listeners = new Map(), requests = [], scrolls = [], observers = [];
  const storage = new Map(options.saved ? [['mdview-scroll:/preview', JSON.stringify(options.saved)]] : []);
  const base = {href: 'file:///tmp/space%20%23%20%C3%BC/'};
  const history = {scrollRestoration: 'auto'};
  let reloaded = 0, height = options.height ?? 1000;
  const window = {
    scrollX: options.x ?? 20, scrollY: options.y ?? 700,
    scrollTo(x, y) { scrolls.push({x, y}); this.scrollX = x; this.scrollY = Math.min(y, height); },
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  };
  vm.runInNewContext(script, {
    location: {protocol: options.protocol ?? 'http:', origin: 'http://127.0.0.1:1234',
      pathname: '/preview', reload() { ++reloaded; }},
    document: {body: {}, addEventListener: window.addEventListener, querySelector(selector) {
      if (selector === 'base') return base;
      assert.equal(selector, 'meta[name="mdview-revision"]');
      return {content: '1'};
    }},
    history, window, URL,
    sessionStorage: {
      getItem(key) { if (options.noStorage) throw Error('Blocked'); return storage.get(key) ?? null; },
      removeItem(key) { storage.delete(key); },
      setItem(key, value) { if (options.noStorage) throw Error('Blocked'); storage.set(key, value); },
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() { this.observing = true; }
      disconnect() { this.observing = false; }
    },
    setTimeout(callback, delay) { timers.push({callback, delay}); },
    async fetch(url, init) {
      requests.push({url, init});
      if (options.offline) throw Error('Connection refused');
      return {ok: options.ok ?? true, async text() { return options.revision ?? '1\n'; }};
    },
  });
  const result = {base, history, window, timers, requests, storage, scrolls, observers,
    get reloaded() { return reloaded; },
    event(name) { for (const callback of [...(listeners.get(name) ?? [])]) callback(); },
    resize(newHeight) { height = newHeight; for (const o of observers) if (o.observing) o.callback(); },
    async poll() {
      const index = timers.findIndex(timer => timer.delay === 500);
      assert.notEqual(index, -1);
      await timers.splice(index, 1)[0].callback();
    },
  };
  if (!options.deferDOM) result.event('DOMContentLoaded');
  return result;
}

const unchanged = page();
assert.equal(unchanged.base.href, 'http://127.0.0.1:1234/files/tmp/space%20%23%20%C3%BC/');
await unchanged.poll();
assert.equal(unchanged.reloaded, 0);
assert.equal(unchanged.requests.length, 1);
assert.equal(unchanged.requests[0].url, 'http://127.0.0.1:1234/revision');
assert.equal(unchanged.requests[0].init.cache, 'no-store');
assert.equal(unchanged.timers.length, 1);

const changed = page({revision: '2\n'});
await changed.poll();
assert.equal(changed.reloaded, 1);
assert.deepEqual(JSON.parse(changed.storage.get('mdview-scroll:/preview')), {x: 20, y: 700});
assert.equal(changed.timers.length, 0);

const restored = page({saved: {x: 30, y: 900}, height: 100});
assert.equal(restored.history.scrollRestoration, 'manual');
assert.equal(restored.storage.size, 0);
restored.event('load');
assert.equal(restored.window.scrollY, 100);
restored.resize(1200);
assert.equal(restored.window.scrollY, 900);
// Continue restoration through late image/diagram layout changes.
restored.window.scrollY = 850;
restored.resize(1300);
assert.equal(restored.window.scrollY, 900);
restored.event('wheel');
restored.window.scrollY = 250;
restored.resize(1400);
assert.equal(restored.window.scrollY, 250);

const shorter = page({saved: {x: 0, y: 900}, height: 100});
shorter.event('load');
shorter.timers.find(timer => timer.delay === 5000).callback();
assert.equal(shorter.observers[0].observing, false);

for (const event of ['touchstart', 'keydown', 'pointerdown']) {
  const interrupted = page({saved: {x: 0, y: 500}});
  interrupted.event('load');
  interrupted.event(event);
  assert.equal(interrupted.observers[0].observing, false);
}
for (const options of [{offline: true}, {ok: false}]) {
  const disconnected = page(options);
  await disconnected.poll();
  assert.equal(disconnected.reloaded, 0);
  assert.equal(disconnected.timers.length, 1);
}
const blocked = page({noStorage: true, revision: '2'});
await blocked.poll();
assert.equal(blocked.reloaded, 1);
assert.equal(blocked.history.scrollRestoration, 'auto');

const corrupt = page({saved: {x: 'bad', y: 100}});
assert.equal(corrupt.observers.length, 0);
assert.equal(corrupt.history.scrollRestoration, 'auto');

const file = page({protocol: 'file:'});
assert.equal(file.timers.length, 0);
assert.equal(file.base.href, 'file:///tmp/space%20%23%20%C3%BC/');

const parsing = page({deferDOM: true, saved: {x: 0, y: 400}});
assert.equal(parsing.timers.length, 0);
parsing.event('DOMContentLoaded');
assert.equal(parsing.window.scrollY, 400);
assert.equal(parsing.observers[0].observing, true);
assert.equal(parsing.timers.length, 1);
console.log('Watch adapter tests passed');
