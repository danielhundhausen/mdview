const figures = [...document.querySelectorAll('.md-diagram')];
const media = matchMedia('(prefers-color-scheme: dark)');
const viewer = globalThis.mdviewDiagrams;
const source = f => f.querySelector('code').textContent;
function unavailable(f, message) {
  viewer?.reset(f);
  f.removeAttribute('data-rendered');
  f.querySelector('.diagram-canvas').hidden = true;
  f.querySelector('details').open = true;
  const status = f.querySelector('.diagram-status');
  status.textContent = message; status.hidden = false;
}
try {
  const mermaid = globalThis.mermaid;
  if (!mermaid) throw new Error('Bundled Mermaid runtime unavailable');
  let generation = 0;
  async function renderAll() {
    const css = getComputedStyle(document.documentElement);
    const color = name => css.getPropertyValue(name).trim();
    const paper = color('--paper'), ink = color('--fg'), line = color('--line');
    const surface = color('--surface'), accent = color('--accent');
    mermaid.initialize({startOnLoad:false, securityLevel:'strict',
      suppressErrorRendering:true, arrowMarkerAbsolute:true, theme:'base', fontFamily:'system-ui, sans-serif',
      htmlLabels:false, flowchart:{htmlLabels:false,curve:'basis'},
      secure:['secure','securityLevel','startOnLoad','suppressErrorRendering',
        'theme','themeVariables','themeCSS','fontFamily','htmlLabels','flowchart','dompurifyConfig','arrowMarkerAbsolute'],
      themeVariables:{darkMode:media.matches, background:paper,
        primaryColor:surface, primaryTextColor:ink, primaryBorderColor:accent,
        secondaryColor:paper, tertiaryColor:surface, lineColor:accent,
        textColor:ink, mainBkg:surface, nodeBorder:accent,
        clusterBkg:paper, clusterBorder:line, edgeLabelBackground:paper,
        actorBkg:surface, actorBorder:accent, actorTextColor:ink,
        actorLineColor:line, signalColor:ink, signalTextColor:ink,
        noteBkgColor:surface, noteBorderColor:line, noteTextColor:ink}});
    const current = ++generation;
    for (const [index, f] of figures.entries()) {
      try {
        const {svg} = await mermaid.render('mdview-diagram-' + current + '-' + index, source(f));
        const canvas = f.querySelector('.diagram-canvas');
        canvas.innerHTML = svg; canvas.hidden = false;
        const image = canvas.querySelector('svg');
        image.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
        image.querySelectorAll('.node>path.outer-path').forEach(path => {
          if (!/^M0,.*? a/.test(path.getAttribute('d'))) return;
          const label = path.parentElement.querySelector('.label');
          const position = label?.getAttribute('transform')?.match(/^translate\([^,]+,\s*(.+)\)$/);
          if (position) label.setAttribute('transform', 'translate(0, ' + position[1] + ')');
        });
        const width = image.viewBox.baseVal.width;
        image.style.width = '100%';
        image.style.height = 'auto';
        image.style.maxWidth = width > 0 ? width + 'px' : '100%';
        viewer?.prepare(f, image);
        if (!f.hasAttribute('data-rendered')) f.querySelector('details').open = false;
        f.setAttribute('data-rendered', '');
        f.querySelector('.diagram-status').hidden = true;
      } catch (error) {
        unavailable(f, 'Could not render this diagram. Check the source below.');
        console.warn('mdview: Mermaid diagram failed', error);
      }
    }
  }
  let queue = Promise.resolve();
  const schedule = () => {queue = queue.then(renderAll).catch(error => {
    figures.forEach(f => unavailable(f, 'Diagram preview unavailable. Source is shown below.'));
    console.warn('mdview: Mermaid rendering failed', error);
  }); return queue;};
  await schedule();
  media.addEventListener('change', schedule);
} catch (error) {
  figures.forEach(f => unavailable(f, 'Could not initialize Mermaid. Source is shown below.'));
  console.warn('mdview: Mermaid runtime unavailable', error);
}
