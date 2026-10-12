// Test the browser adapter without opening a browser or downloading dependencies.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import vm from 'node:vm';

const directory = mkdtempSync(join(tmpdir(), 'mdview-js-test-'));
let script;
try {
  const output = join(directory, 'preview.html');
  execFileSync(resolve(process.argv[2]), ['--no-open', '-o', output, '-'], {
    input: '```mermaid\nflowchart LR\nA --> B\n```\n',
  });
  script = readFileSync(output, 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];
} finally { rmSync(directory, {recursive: true}); }

function figure(text) {
  const nodes = {
    code: {textContent: text},
    details: {open: true},
    '.diagram-status': {hidden: false, textContent: 'Initial status'},
    '.diagram-canvas': {
      hidden: true, innerHTML: '',
      image: {viewBox: {baseVal: {width: 400}}, style: {}, setAttributeNS() {}, querySelectorAll() { return []; }},
      querySelector() { return this.image; },
    },
  };
  const attributes = new Set();
  return {
    nodes,
    querySelector(selector) { return nodes[selector]; },
    hasAttribute(name) { return attributes.has(name); },
    setAttribute(name) { attributes.add(name); },
    removeAttribute(name) { attributes.delete(name); },
  };
}

async function run(figures, missingRuntime = false) {
  const configurations = [], rendered = [];
  let themeHandler;
  const media = {matches: false, addEventListener(event, fn) {
    assert.equal(event, 'change'); themeHandler = fn;
  }};
  const colors = {'--paper': '#fffdf9', '--fg': '#343630', '--line': '#e5dfd4',
                  '--surface': '#f4f0e8', '--accent': '#a44832'};
  const mermaid = {
    initialize(options) { configurations.push(options); },
    async render(id, source) {
      rendered.push({id, source});
      if (source === 'invalid') throw Error('Syntax error');
      return {svg: '<svg viewBox="0 0 400 200"></svg>'};
    },
  };
  const context = {
    document: {documentElement: {}, querySelectorAll() { return figures; }},
    matchMedia() { return media; },
    getComputedStyle() { return {getPropertyValue(name) { return colors[name]; }}; },
    mermaid: missingRuntime ? undefined : mermaid,
    console: {warn() {}},
  };
  await vm.runInNewContext('(async () => {' + script + '})()', context, {timeout: 1000});
  return {configurations, rendered, media, colors, themeChange: () => themeHandler()};
}

const good = figure('flowchart LR\nA[<text>] --> B');
const bad = figure('invalid');
const result = await run([good, bad]);
assert.equal(good.nodes['.diagram-canvas'].hidden, false);
assert.equal(good.nodes.details.open, false);
assert.equal(good.nodes['.diagram-status'].hidden, true);
assert.equal(good.nodes['.diagram-canvas'].image.style.width, '400px');
assert.equal(result.rendered[0].source, good.nodes.code.textContent);
assert.equal(bad.nodes['.diagram-canvas'].hidden, true);
assert.equal(bad.nodes.details.open, true);
assert.match(bad.nodes['.diagram-status'].textContent, /Could not render/);
assert.equal(result.configurations[0].securityLevel, 'strict');
assert.equal(result.configurations[0].arrowMarkerAbsolute, true);
assert.equal(result.configurations[0].themeVariables.primaryTextColor, '#343630');

// Keep a user's source disclosure open when re-rendering for a theme change.
good.nodes.details.open = true;
result.media.matches = true;
result.colors['--paper'] = '#202522';
await Promise.all([result.themeChange(), result.themeChange()]);
assert.equal(result.configurations.length, 3);
assert.equal(result.configurations[1].themeVariables.darkMode, true);
assert.equal(result.configurations[1].themeVariables.background, '#202522');
assert.equal(good.nodes.details.open, true);
assert.equal(new Set(result.rendered.map(r => r.id)).size, result.rendered.length);

// A failed re-render must also restore printable source after an earlier success.
good.nodes.code.textContent = 'invalid';
await result.themeChange();
assert.equal(good.hasAttribute('data-rendered'), false);
assert.equal(good.nodes.details.open, true);

const disconnected = figure('flowchart TD\nC --> D');
await run([disconnected], true);
assert.equal(disconnected.nodes['.diagram-canvas'].hidden, true);
assert.equal(disconnected.nodes.details.open, true);
assert.equal(disconnected.nodes['.diagram-status'].hidden, false);
assert.match(disconnected.nodes['.diagram-status'].textContent, /initialize Mermaid/);
console.log('Mermaid adapter: rendering, syntax errors, missing-runtime fallback, and theme changes pass.');
