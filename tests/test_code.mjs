// Execute the generated page's actual offline highlighter and copy adapter.
// DOM/clipboard stubs keep this suite dependency-free and never open a browser.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const directory = mkdtempSync(join(tmpdir(), 'mdview-code-test-'));
const samples = [
  ['js', 'const value = "<tag> & ü 🌍"; // comment\n'],
  ['python', 'def greet(name):\n    return "hello"\n'],
  ['c', 'int main(void) { return 42; }\n'],
  ['bash', 'echo "hello" # comment\n'],
  ['json', '{"key": true, "count": 12}\n'],
  ['html', '<!-- comment -->\n<script>alert("x")</script>\n'],
  ['SQL', 'SELECT * FROM users WHERE id = 1;\n'],
  ['rust', 'fn main() { let n = 1; }\n'],
  ['not-a-language', '<literal> & "text"\n'],
  ['', 'const leave = "unlabeled";\n'],
  ['text', '<plain> & literal\n'],
  ['mermaid-extra', 'flowchart LR\nA --> B\n'],
  ['js', ''],
];
let html;
try {
  const output = join(directory, 'preview.html');
  const input = samples.map(([language, source]) => '```' + language + '\n' + source + '```\n').join('\n')
    + '\n    indented & ü\n';
  execFileSync(resolve(process.argv[2]), ['--no-open', '-o', output, '-'], {input});
  html = readFileSync(output, 'utf8');
} finally { rmSync(directory, {recursive: true}); }

const runtime = html.match(/<script data-mdview-highlight-runtime="11\.12\.0">([\s\S]*?)<\/script>/)[1];
const adapter = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) =>
  ({amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'"})[entity]);
const parsed = [...html.matchAll(/<pre><code(?: class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g)]
  .map(([, classes, escaped]) => ({classes, source: decode(escaped), escaped}));
assert.deepEqual(parsed.map(block => block.source), [...samples.map(([, source]) => source), 'indented & ü\n']);

function block({classes, source, escaped = source}) {
  let text = source, markup = escaped;
  const code = {
    classList: new Set(classes?.split(' ') ?? []),
    get textContent() { return text; },
    set textContent(value) { text = value; },
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = value; text = decode(value.replace(/<[^>]*>/g, '')); },
  };
  const nodes = {
    'pre > code': code,
    '.code-copy': {disabled: false, textContent: '', innerHTML: '<svg>icon</svg>', dataset: {state: 'idle'}, title: 'Copy code', addEventListener(event, fn) {
      assert.equal(event, 'click'); this.click = fn;
    }},
    '.code-status': {textContent: ''},
    '.code-toolbar': {hidden: true},
  };
  return {nodes, querySelector(selector) { return nodes[selector]; }};
}

function run(blocks, options = {}) {
  const timers = new Map(), copied = [], fields = [], restored = [], focused = [];
  let nextTimer = 0, legacyCalls = 0;
  const active = {focus(value) { focused.push(value); }};
  const range = {cloneRange() { return this; }};
  const selection = {
    rangeCount: options.selection === false ? 0 : 1,
    getRangeAt(index) { assert.equal(index, 0); return range; },
    removeAllRanges() { restored.push('clear'); },
    addRange(value) { assert.equal(value, range); restored.push('range'); },
  };
  const context = vm.createContext({
    document: {
      activeElement: active,
      getSelection() { return options.selection === false ? null : selection; },
      querySelectorAll(selector) { assert.equal(selector, '.md-code-block'); return blocks; },
      createElement(tag) {
        assert.equal(tag, 'textarea');
        const field = {style: {}, value: '', removed: false, selected: false,
          setAttribute(name, value) { assert.equal(name, 'readonly'); assert.equal(value, ''); },
          select() { this.selected = true; },
          remove() { this.removed = true; },
        };
        fields.push(field);
        return field;
      },
      body: {appendChild(field) { assert.equal(field, fields.at(-1)); }},
      execCommand: options.noExecCommand ? undefined : command => {
        assert.equal(command, 'copy');
        ++legacyCalls;
        assert.equal(fields.at(-1).selected, true);
        copied.push(fields.at(-1).value);
        if (options.legacyThrows) throw Error('Copy blocked');
        return options.legacyResult ?? true;
      },
    },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, {fn, ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: {log() {}, warn() {}, error() {}},
  });
  if (!options.noNavigator) context.navigator = options.noClipboard ? {} : {clipboard: {async writeText(text) {
    if (options.clipboard) return options.clipboard(text);
    if (options.clipboardRejects) throw Error('Permission denied');
    copied.push(text);
  }}};
  if (!options.missingRuntime) vm.runInContext(runtime, context, {timeout: 1000});
  if (options.brokenHighlight) context.hljs.highlight = () => { throw Error('Highlighter failed'); };
  vm.runInContext(adapter, context, {timeout: 1000});
  return {context, timers, copied, fields, focused, restored, get legacyCalls() { return legacyCalls; }, reset() {
    for (const [id, timer] of timers) { timers.delete(id); timer.fn(); }
  }};
}

// Real highlighting, aliases and case normalization, HTML escaping, plaintext,
// empty/unlabeled/unknown/indented blocks, and one copy control per block.
const blocks = parsed.map(block);
const result = run(blocks);
assert.equal(result.context.hljs.versionString, '11.12.0');
for (let i = 0; i < blocks.length; ++i) {
  const nodes = blocks[i].nodes, code = nodes['pre > code'];
  assert.equal(code.textContent, parsed[i].source);
  assert.equal(nodes['.code-toolbar'].hidden, false);
  if (i < 8) assert.match(code.innerHTML, /<span class="hljs-/);
  if ([8, 9, 10, 11, 13].includes(i)) assert.doesNotMatch(code.innerHTML, /<span/);
  assert.doesNotMatch(code.innerHTML, /<script>|<tag>/);
  await nodes['.code-copy'].click();
  assert.equal(nodes['.code-copy'].dataset.state, 'success');
  assert.equal(nodes['.code-copy'].title, 'Code copied');
  assert.equal(nodes['.code-copy'].innerHTML, '<svg>icon</svg>');
  assert.equal(nodes['.code-copy'].disabled, false);
  assert.equal(nodes['.code-status'].textContent, 'Code copied.');
}
assert.deepEqual(result.copied, parsed.map(block => block.source));
assert.equal(result.legacyCalls, 0);
assert.ok([...result.timers.values()].every(timer => timer.ms === 2000));
result.reset();
assert.ok(blocks.every(block => block.nodes['.code-copy'].dataset.state === 'idle'));
assert.ok(blocks.every(block => block.nodes['.code-status'].textContent === ''));
assert.ok(blocks.every(block => block.nodes['.code-copy'].title === 'Copy code'));

// Mermaid source is never highlighted, even if a grammar is registered later.
const diagram = block({source: 'flowchart LR\nA --> B\n', classes: 'language-mermaid'});
const diagramResult = run([diagram]);
assert.equal(diagram.nodes['pre > code'].classList.has('hljs'), false);
await diagram.nodes['.code-copy'].click();
assert.deepEqual(diagramResult.copied, ['flowchart LR\nA --> B\n']);

// Missing or failed highlighting still allows reading/copying every block.
for (const options of [{missingRuntime: true}, {brokenHighlight: true}]) {
  const fallbackBlocks = [block(parsed[0]), block(parsed[1])];
  const fallback = run(fallbackBlocks, options);
  for (const item of fallbackBlocks) {
    assert.equal(item.nodes['pre > code'].classList.has('hljs'), false);
    await item.nodes['.code-copy'].click();
  }
  assert.deepEqual(fallback.copied, [parsed[0].source, parsed[1].source]);
}

// Local-file fallback, denied Clipboard API, absent navigator, focus restoration,
// selection restoration, and temporary textarea cleanup after success or failure.
for (const options of [{noClipboard: true}, {clipboardRejects: true}, {noNavigator: true},
  {noClipboard: true, selection: false}]) {
  const item = block(parsed[0]), fallback = run([item], options);
  await item.nodes['.code-copy'].click();
  assert.deepEqual(fallback.copied, [parsed[0].source]);
  assert.equal(fallback.legacyCalls, 1);
  assert.equal(fallback.fields[0].removed, true);
  assert.equal(fallback.focused.length, 1);
  assert.equal(fallback.focused[0].preventScroll, true);
  assert.deepEqual(fallback.restored, options.selection === false ? [] : ['clear', 'range']);
  assert.equal(item.nodes['.code-copy'].dataset.state, 'success');
}

for (const options of [{legacyResult: false}, {legacyThrows: true}, {noExecCommand: true}]) {
  const item = block(parsed[0]), failure = run([item], {...options, clipboardRejects: true});
  for (let attempt = 0; attempt < 2; ++attempt) {
    await item.nodes['.code-copy'].click();
    assert.equal(item.nodes['.code-copy'].disabled, false);
    assert.equal(item.nodes['.code-copy'].dataset.state, 'error');
    assert.equal(item.nodes['.code-copy'].title, 'Copy failed');
    assert.equal(item.nodes['.code-copy'].innerHTML, '<svg>icon</svg>');
    assert.equal(item.nodes['.code-status'].textContent, 'Select and copy the code manually.');
    assert.equal(failure.fields.at(-1).removed, true);
    assert.equal(failure.timers.size, 1); // Retry replaces the pending status reset.
    assert.equal([...failure.timers.values()][0].ms, 4000);
  }
  failure.reset();
  assert.equal(item.nodes['.code-copy'].dataset.state, 'idle');
}

// Slow writes disable repeated clicks; copy captures the source before markup
// changes, and success remains per-block rather than affecting other buttons.
let complete;
const busyBlocks = [block(parsed[0]), block(parsed[1])];
const writes = [];
run(busyBlocks, {clipboard(text) { writes.push(text); return new Promise(resolve => { complete = resolve; }); }});
busyBlocks[0].nodes['pre > code'].textContent = 'changed DOM text';
const pending = busyBlocks[0].nodes['.code-copy'].click();
assert.equal(busyBlocks[0].nodes['.code-copy'].disabled, true);
await busyBlocks[0].nodes['.code-copy'].click();
assert.deepEqual(writes, [parsed[0].source]);
complete();
await pending;
assert.equal(busyBlocks[0].nodes['.code-copy'].disabled, false);
assert.equal(busyBlocks[1].nodes['.code-copy'].dataset.state, 'idle');

console.log('Code blocks: real offline highlighting, escaping, copying, fallbacks, accessibility status, and retries pass.');

// Optional real DOM coverage. Pass a directory containing node_modules/jsdom.
if (process.argv[3]) {
  const require = createRequire(join(resolve(process.argv[3]), 'package.json'));
  const {JSDOM, ResourceLoader, VirtualConsole} = require('jsdom');
  let networkAttempts = 0;
  const errors = [], copies = [];
  class NoNetwork extends ResourceLoader {
    fetch(url) { ++networkAttempts; throw Error('Unexpected network request: ' + url); }
  }
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', resources: new NoNetwork(), virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.navigator, 'clipboard', {configurable: true,
        value: {async writeText(text) { copies.push(text); }}});
      window.fetch = () => { ++networkAttempts; throw Error('Network disabled'); };
    },
  });
  try {
    const document = dom.window.document;
    assert.equal(dom.window.hljs.versionString, '11.12.0');
    assert.equal(document.querySelectorAll('script').length, 2);
    for (const script of document.querySelectorAll('script[type="module"]')) dom.window.eval(script.textContent);
    const realBlocks = [...document.querySelectorAll('.md-code-block')];
    assert.equal(realBlocks.length, parsed.length);
    for (const [index, item] of realBlocks.entries()) {
      assert.equal(item.querySelector('code').textContent, parsed[index].source);
      if (index < 8) assert.ok(item.querySelector('code span[class^="hljs-"]'), samples[index][0]);
      assert.equal(item.querySelector('.code-toolbar').hidden, false);
      assert.equal(dom.window.getComputedStyle(item).position, 'relative');
      assert.equal(dom.window.getComputedStyle(item.querySelector('.code-toolbar')).position, 'absolute');
      assert.equal(item.querySelector('.code-copy').getAttribute('aria-label'), 'Copy code');
      assert.equal(item.querySelector('.code-copy').textContent, '');
      assert.ok(item.querySelector('.code-copy svg[aria-hidden="true"]'));
      assert.equal(dom.window.getComputedStyle(item.querySelector('.code-icon-copy')).display, 'block');
      item.querySelector('.code-copy').click();
      await new Promise(resolve => dom.window.setTimeout(resolve, 0));
      assert.equal(item.querySelector('.code-copy').dataset.state, 'success');
      assert.equal(dom.window.getComputedStyle(item.querySelector('.code-icon-success')).display, 'block');
      assert.equal(dom.window.getComputedStyle(item.querySelector('.code-icon-copy')).display, 'none');
    }
    assert.deepEqual(copies, parsed.map(item => item.source));
    // Exercise the actual DOM textarea path, including selection/focus cleanup.
    delete dom.window.navigator.clipboard;
    const first = realBlocks[0], button = first.querySelector('.code-copy');
    button.focus();
    const selection = document.getSelection(), range = document.createRange();
    range.selectNodeContents(first.querySelector('code'));
    selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString();
    document.execCommand = command => {
      assert.equal(command, 'copy');
      assert.equal(document.querySelector('textarea').value, parsed[0].source);
      return true;
    };
    button.click();
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.equal(button.dataset.state, 'success');
    assert.equal(document.activeElement, button);
    assert.equal(selection.toString(), selected);
    assert.equal(document.querySelector('textarea'), null);
    document.execCommand = () => false;
    button.click();
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.equal(button.dataset.state, 'error');
    assert.equal(dom.window.getComputedStyle(first.querySelector('.code-icon-error')).display, 'block');
    assert.equal(dom.window.getComputedStyle(first.querySelector('.code-status')).clipPath, 'none');
    assert.equal(button.disabled, false);
    assert.equal(document.querySelector('textarea'), null);
    assert.equal(networkAttempts, 0);
    assert.deepEqual(errors, []);
  } finally { dom.window.close(); }

  const disabled = new JSDOM(html); // Script execution is disabled by default.
  try {
    assert.deepEqual([...disabled.window.document.querySelectorAll('pre > code')].map(code => code.textContent),
      parsed.map(item => item.source));
    assert.ok([...disabled.window.document.querySelectorAll('.code-toolbar')].every(toolbar => toolbar.hidden));
    assert.equal(disabled.window.document.querySelector('code .hljs-keyword'), null);
  } finally { disabled.window.close(); }
  console.log('Real DOM: inline runtime parsing, highlighting, copy events, fallback cleanup, and JavaScript-disabled source pass offline.');
}
