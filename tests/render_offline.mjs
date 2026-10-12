// Optional integration test: real Mermaid in a DOM/SVG emulator, no browser control.
// Install jsdom and svgdom in a temporary directory; pass its path as argument 5.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const [program, fixture, output, dependencies] = process.argv.slice(2).map(path => resolve(path));
mkdirSync(output, {recursive: true});
const require = createRequire(join(dependencies, 'package.json'));
const {JSDOM, ResourceLoader, VirtualConsole} = require('jsdom');
const {createSVGWindow} = await import(pathToFileURL(require.resolve('svgdom')));
const htmlPath = join(output, 'opentelemetry.html');
execFileSync(program, ['--no-open', '-o', htmlPath, fixture]);
let networkAttempts = 0;
const warnings = [];
class NoNetwork extends ResourceLoader {
  fetch(url) { networkAttempts++; throw Error('Network disabled: ' + url); }
}
const virtualConsole = new VirtualConsole();
virtualConsole.on('warn', (...args) => warnings.push(args.map(String).join(' ')));
virtualConsole.on('jsdomError', e => warnings.push(e.message));
const svgWindow = createSVGWindow();
const svgRoot = svgWindow.document.documentElement;
const media = {matches: false, addEventListener(event, callback) { this.callback = callback; }};
const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), {
  url: pathToFileURL(htmlPath).href,
  runScripts: 'dangerously', pretendToBeVisual: true,
  resources: new NoNetwork(), virtualConsole,
  beforeParse(window) {
    window.matchMedia = () => media;
    window.structuredClone = structuredClone;
    window.fetch = () => { networkAttempts++; throw Error('Network disabled'); };
    window.XMLHttpRequest.prototype.open = () => { networkAttempts++; throw Error('Network disabled'); };
    // SVG font metrics and geometry are supplied by svgdom rather than a browser.
    window.SVGElement.prototype.getBBox = function () {
      svgRoot.innerHTML = this.outerHTML;
      const clone = svgRoot.firstChild;
      const css = window.getComputedStyle(this);
      const fontSize = css.fontSize.endsWith('px') ? parseFloat(css.fontSize) : 16;
      clone.setAttribute('font-size', String(fontSize));
      clone.style.fontSize = fontSize + 'px';
      clone.setAttribute('font-family', 'Open Sans');
      // svgdom does not resolve relative SVG length units; convert em values.
      for (const element of [clone, ...clone.querySelectorAll('*')]) {
        for (const name of ['x','y','dx','dy']) {
          const value = element.getAttribute(name);
          if (value && /^-?[\d.]+em$/.test(value)) element.setAttribute(name, String(parseFloat(value) * fontSize));
        }
      }
      return clone.getBBox();
    };
    window.SVGElement.prototype.getComputedTextLength = function () { return this.getBBox().width; };
    window.SVGElement.prototype.getBoundingClientRect = function () {
      const b = this.getBBox();
      return {x:b.x, y:b.y, width:b.width, height:b.height,
              left:b.x, top:b.y, right:b.x+b.width, bottom:b.y+b.height};
    };
  },
});
const adapter = dom.window.document.querySelector('script[type="module"]').textContent;
const start = performance.now();
await dom.window.eval('(async () => {' + adapter + '})()');
const elapsed = performance.now() - start;
const figures = [...dom.window.document.querySelectorAll('.md-diagram')];
assert.equal(figures.length, 2);
const diagrams = [];
for (const [index, figure] of figures.entries()) {
  assert.ok(figure.hasAttribute('data-rendered'), figure.querySelector('.diagram-status').textContent + '\n' + warnings.join('\n'));
  const svg = figure.querySelector('svg');
  for (const path of svg.querySelectorAll('.node>path.outer-path')) {
    if (!/^M0,.*? a/.test(path.getAttribute('d'))) continue;
    assert.match(path.parentElement.querySelector('.label').getAttribute('transform'), /^translate\(0,/);
  }
  const file = join(output, 'diagram-' + (index + 1) + '.svg');
  writeFileSync(file, svg.outerHTML.replaceAll(dom.window.location.href + '#', '#'));
  diagrams.push({file, nodes:svg.querySelectorAll('.node').length,
    edges:svg.querySelectorAll('.flowchart-link').length,
    groups:svg.querySelectorAll('.cluster').length, viewBox:svg.getAttribute('viewBox')});
}
assert.equal(networkAttempts, 0);
const report = {backend:'Mermaid 12.1.0 in jsdom, SVG geometry/font metrics from svgdom',
  theme:'light', networkAttempts, renderMs:Math.round(elapsed), diagrams, warnings};
writeFileSync(join(output, 'rendered-light.html'), dom.serialize());

// Exercise the real library again after a dark-theme change.
for (const [name,value] of Object.entries({'--paper':'#202522','--fg':'#e9e7df',
  '--line':'#3c433c','--surface':'#2a302b','--accent':'#e9ac8e'}))
  dom.window.document.documentElement.style.setProperty(name, value);
media.matches = true;
await media.callback();
for (const [index, figure] of figures.entries()) {
  assert.ok(figure.hasAttribute('data-rendered'), warnings.join('\n'));
  writeFileSync(join(output, 'diagram-' + (index + 1) + '-dark.svg'),
    figure.querySelector('svg').outerHTML.replaceAll(dom.window.location.href + '#', '#'));
}
assert.equal(networkAttempts, 0);
report.darkThemePassed = true;
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
dom.window.close();
