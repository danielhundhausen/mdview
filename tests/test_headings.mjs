// Exercise the actual embedded outline script without browser control.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import vm from 'node:vm';

const directory = mkdtempSync(join(tmpdir(), 'mdview-headings-'));
let script, ids;
try {
  const output = join(directory, 'outline.html');
  execFileSync(resolve(process.argv[2]), ['--no-open', '--toc', '-o', output, '-'], {
    input: '# Intro\n\n## Installation\n\n### Usage\n\n## Héllo\n\n## End\n',
  });
  const html = readFileSync(output, 'utf8');
  script = html.match(/<script data-mdview-headings>\n([\s\S]*?)\n<\/script>/)[1];
  assert.equal(script.trim(), readFileSync(new URL('../heading_adapter.js', import.meta.url), 'utf8').trim());
  ids = [...html.matchAll(/data-heading-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids, ['intro', 'installation', 'usage', 'héllo', 'end']);
} finally {
  rmSync(directory, {recursive: true, force: true});
}

function page(options = {}) {
  const listeners = new Map(), frames = [], observers = [];
  const positions = options.positions ?? [0, 400, 900, 1600, 2300];
  const listen = (name, callback) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(callback);
  };
  const links = (options.empty ? [] : ids).map((id, index) => ({
    dataset: {headingId: id}, attributes: new Map(),
    labelRect: {left: 110 + (index === 2 ? 20 : 0), top: 80 + index * 36,
      width: id.length * 8, height: 22},
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  }));
  const nav = {
    scrollLeft: 0, scrollTop: 0, bounds: {left: 100, top: 70},
    style: {properties: new Map(), setProperty(name, value) { this.properties.set(name, value); }},
    classList: {values: new Set(), add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); }},
    getBoundingClientRect() { return this.bounds; },
  };
  const toc = {open: false, addEventListener: listen,
    querySelector(selector) { assert.equal(selector, 'nav'); return nav; },
    querySelectorAll(selector) { assert.equal(selector, 'a[data-heading-id]'); return links; }};
  const main = {};
  const window = {
    innerWidth: options.width ?? 1200, innerHeight: 600, scrollY: 0,
    matchMedia(query) {
      assert.equal(query, '(max-width: 1000px)');
      return {matches: this.innerWidth <= 1000};
    },
    addEventListener: listen,
    requestAnimationFrame(callback) { frames.push(callback); },
  };
  const document = {
    documentElement: {scrollHeight: 2600},
    createRange() { return {
      selectNodeContents(link) { this.link = link; },
      getBoundingClientRect() { return this.link.labelRect; },
    }; },
    querySelector(selector) {
      if (selector === '.toc') return options.noToc ? null : toc;
      assert.equal(selector, 'main');
      return main;
    },
    getElementById(id) {
      if (id === options.missing) return null;
      return {getBoundingClientRect() { return {top: positions[ids.indexOf(id)] - window.scrollY}; }};
    },
  };
  const context = {window, document};
  if (!options.noObserver) context.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
  };
  vm.runInNewContext(script, context);
  return {toc, nav, links, window, document, positions, frames, observers,
    event(name) { for (const callback of listeners.get(name) ?? []) callback(); },
    flush() { for (const callback of frames.splice(0)) callback(); },
    current() {
      const marked = links.filter(link => link.attributes.has('aria-current'));
      assert.ok(marked.length <= 1, 'Only the current section is marked');
      if (marked.length) assert.equal(marked[0].attributes.get('aria-current'), 'location');
      return marked[0]?.dataset.headingId;
    },
  };
}

for (const [width, open] of [[1600, true], [1001, true], [1000.5, true], [1000, false], [375, false]]) {
  const view = page({width});
  assert.equal(view.toc.open, open);
  view.toc.open = !open;
  view.event('toggle');
  view.window.innerWidth = open ? 375 : 1600;
  view.event('resize');
  view.flush();
  assert.equal(view.toc.open, !open, 'Resizing preserves the reader’s toggle');
}

const view = page();
assert.equal(view.current(), 'intro');
assert.equal(view.nav.style.properties.get('--toc-mark-x'), '4px');
assert.equal(view.nav.style.properties.get('--toc-mark-y'), '8px');
assert.equal(view.nav.style.properties.get('--toc-mark-width'), '52px');
assert.equal(view.nav.style.properties.get('--toc-mark-height'), '26px');
assert.equal(view.nav.style.properties.get('--toc-mark-opacity'), '1');
assert.ok(view.nav.classList.values.has('toc-motion'));
view.window.scrollY = 340;
view.event('scroll');
view.event('scroll');
assert.equal(view.frames.length, 1, 'Scroll updates are batched per frame');
view.flush();
assert.equal(view.current(), 'installation');
assert.equal(view.nav.style.properties.get('--toc-mark-y'), '44px');
assert.equal(view.nav.style.properties.get('--toc-mark-width'), '108px');
view.window.scrollY = 990;
view.event('scroll');
view.flush();
assert.equal(view.current(), 'usage');
assert.equal(view.nav.style.properties.get('--toc-mark-x'), '24px');
assert.equal(view.nav.style.properties.get('--toc-mark-y'), '80px');
assert.equal(view.nav.style.properties.get('--toc-mark-width'), '52px');
// At the bottom, a short final section is selected before it reaches the margin.
view.window.scrollY = 2000;
view.event('scroll');
view.flush();
assert.equal(view.current(), 'end');
view.window.scrollY = 0;
view.event('scroll');
view.flush();
assert.equal(view.current(), 'intro');

// A fragment jump and a browser resize both update the reading position.
view.window.scrollY = 1540;
view.event('hashchange');
view.flush();
assert.equal(view.current(), 'héllo');
view.window.scrollY = 820;
view.window.innerHeight = 300; // The smaller viewport uses a 60px margin.
view.event('resize');
view.flush();
assert.equal(view.current(), 'installation');
view.window.innerHeight = 600;
view.event('resize');
view.flush();
assert.equal(view.current(), 'usage');

// Reflowing a wrapped label updates its marker even when the section is unchanged.
view.links[2].labelRect.width = 120;
view.links[2].labelRect.height = 44;
view.event('resize');
view.flush();
assert.equal(view.nav.style.properties.get('--toc-mark-width'), '132px');
assert.equal(view.nav.style.properties.get('--toc-mark-height'), '48px');
view.toc.open = false;
view.event('toggle');
view.flush();
assert.equal(view.nav.style.properties.get('--toc-mark-opacity'), '0');
assert.equal(view.nav.classList.values.has('toc-motion'), false);
view.toc.open = true;
view.event('toggle');
view.flush();
assert.equal(view.nav.style.properties.get('--toc-mark-opacity'), '1');
assert.ok(view.nav.classList.values.has('toc-motion'));

// A scrolling mobile outline measures the label in its own content coordinates.
const mobile = page({width: 375});
assert.equal(mobile.nav.classList.values.has('toc-motion'), false);
mobile.toc.open = true;
mobile.nav.scrollTop = 50;
mobile.links[0].labelRect.top -= 50;
mobile.event('toggle');
mobile.flush();
assert.equal(mobile.nav.style.properties.get('--toc-mark-y'), '8px');
assert.equal(mobile.nav.style.properties.get('--toc-mark-opacity'), '1');
assert.ok(mobile.nav.classList.values.has('toc-motion'));

// Late images and diagrams can move the current heading without a scroll event.
assert.equal(view.observers.length, 1);
assert.ok(view.observers[0].targets.includes(view.toc));
view.positions[2] = 1100;
view.observers[0].callback();
view.flush();
assert.equal(view.current(), 'installation');
view.positions[2] = 900;
view.event('load');
view.flush();
assert.equal(view.current(), 'usage');

const missing = page({missing: 'installation'});
missing.window.scrollY = 500;
missing.event('scroll');
missing.flush();
assert.equal(missing.current(), 'intro');
const fallback = page({noObserver: true});
fallback.window.scrollY = 990;
fallback.event('scroll');
fallback.flush();
assert.equal(fallback.current(), 'usage');
assert.equal(page({empty: true}).current(), undefined);
assert.equal(page({noToc: true}).current(), undefined);
console.log('Heading outline: viewport defaults, current sections, moving marker geometry, and layout changes pass.');
