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
    input: 'Inline $x^2$\n\n```math\ny^2\n```\n',
  });
  script = readFileSync(output, 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/g)
    .map(block => block.replace(/^<script type="module">|<\/script>$/g, ''))
    .find(block => block.includes('md-math'));
} finally { rmSync(directory, {recursive: true}); }
assert.ok(script, 'math adapter script is emitted');

function inlineMath(text, display = false) {
  const attributes = new Set();
  return {
    textContent: text, innerHTML: '',
    classList: {contains: name => display && name === 'md-math-display'},
    setAttribute(name) { attributes.add(name); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
  };
}

function figure(text) {
  const nodes = {
    code: {textContent: text},
    details: {open: true},
    '.math-status': {hidden: false, textContent: 'Initial status'},
    '.math-canvas': {hidden: true, innerHTML: ''},
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

async function run(inline, figures, missingRuntime = false) {
  const rendered = [];
  const mathjax = {
    startup: {adaptor: {outerHTML: node => node}},
  };
  // Like the real runtime, tex2svg only appears once startup resolves.
  mathjax.startup.promise = Promise.resolve().then(() => {
    mathjax.tex2svg = (source, options) => {
      rendered.push({source, display: options.display});
      if (source === 'invalid') throw Error('TeX parse error');
      return '<svg data-tex="' + source + '"></svg>';
    };
  });
  const context = {
    document: {
      querySelectorAll(selector) {
        return selector === '.md-math' ? inline : figures;
      },
    },
    MathJax: missingRuntime ? undefined : mathjax,
    console: {warn() {}},
  };
  await vm.runInNewContext('(async () => {' + script + '})()', context, {timeout: 1000});
  return rendered;
}

const good = inlineMath('x^2');
const display = inlineMath('\\alpha', true);
const bad = inlineMath('invalid');
const block = figure('y^2');
const badBlock = figure('invalid');
const rendered = await run([good, display, bad], [block, badBlock]);
assert.deepEqual(rendered.map(r => [r.source, r.display]),
  [['x^2', false], ['\\alpha', true], ['invalid', false], ['y^2', true], ['invalid', true]]);
assert.equal(good.innerHTML, '<svg data-tex="x^2"></svg>');
assert.equal(good.hasAttribute('data-rendered'), true);
assert.equal(bad.innerHTML, '');
assert.equal(bad.textContent, 'invalid');
assert.equal(block.nodes['.math-canvas'].hidden, false);
assert.equal(block.nodes['.math-canvas'].innerHTML, '<svg data-tex="y^2"></svg>');
assert.equal(block.nodes.details.open, false);
assert.equal(block.nodes['.math-status'].hidden, true);
assert.equal(badBlock.nodes['.math-canvas'].hidden, true);
assert.equal(badBlock.nodes.details.open, true);
assert.match(badBlock.nodes['.math-status'].textContent, /Could not render/);

const orphan = inlineMath('z^2');
const disconnected = figure('z^2');
await run([orphan], [disconnected], true);
assert.equal(orphan.innerHTML, '');
assert.equal(orphan.textContent, 'z^2');
assert.equal(disconnected.nodes['.math-canvas'].hidden, true);
assert.equal(disconnected.nodes.details.open, true);
assert.match(disconnected.nodes['.math-status'].textContent, /initialize MathJax/);
console.log('Math adapter: inline, display, block, TeX errors, and missing-runtime fallback pass.');
