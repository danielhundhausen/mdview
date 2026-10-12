// One modal viewer per document; move the SVG so IDs and marker references stay unique.
(() => {
  let dialog, canvas, controls, active, image, opener, overflow;
  let scale = 1, fitting = true;

  const width = svg => svg.viewBox.baseVal.width || 800;
  function preview(svg) {
    svg.style.width = '100%';
    svg.style.height = 'auto';
    svg.style.maxWidth = width(svg) + 'px';
  }

  function restore() {
    if (!active) return;
    preview(image);
    active.querySelector('.diagram-canvas').replaceChildren(image);
    document.documentElement.style.overflow = overflow;
    active = null; image = null;
    opener?.focus({preventScroll:true});
    opener = null;
  }

  function close() {
    restore();
    if (dialog?.open) dialog.close();
  }

  function zoom(value) {
    if (!image) return;
    scale = Math.min(4, Math.max(.01, value));
    image.style.width = width(image) * scale + 'px';
    image.style.maxWidth = 'none';
    controls.actual.textContent = Math.round(scale * 100) + '%';
    controls.out.disabled = scale <= .01;
    controls.in.disabled = scale >= 4;
  }

  function fit() {
    fitting = true;
    const css = getComputedStyle(canvas);
    const available = canvas.clientWidth - parseFloat(css.paddingLeft || 0) - parseFloat(css.paddingRight || 0);
    zoom(Math.min(1, Math.max(1, available) / width(image)));
  }

  function create() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'diagram-overlay';
    dialog.setAttribute('aria-labelledby', 'mdview-diagram-title');
    dialog.innerHTML = `
      <header class="diagram-overlay-header">
        <h2 id="mdview-diagram-title">Diagram</h2>
        <div class="diagram-overlay-controls" role="group" aria-label="Diagram controls">
          <button type="button" class="diagram-button" data-action="out" aria-label="Zoom out">−</button>
          <button type="button" class="diagram-button" data-action="actual" title="Show at 100 percent">100%</button>
          <button type="button" class="diagram-button" data-action="in" aria-label="Zoom in">+</button>
          <button type="button" class="diagram-button" data-action="fit">Fit width</button>
          <button type="button" class="diagram-button diagram-overlay-close" data-action="close" autofocus>Close ×</button>
        </div>
      </header>
      <div class="diagram-overlay-canvas" role="region" aria-label="Expanded diagram" tabindex="0"></div>`;
    document.body.append(dialog);
    canvas = dialog.querySelector('.diagram-overlay-canvas');
    controls = Object.fromEntries(['out','actual','in','fit','close'].map(name =>
      [name, dialog.querySelector(`[data-action="${name}"]`)]));
    controls.out.addEventListener('click', () => {fitting = false; zoom(scale / 1.25);});
    controls.in.addEventListener('click', () => {fitting = false; zoom(scale * 1.25);});
    controls.actual.addEventListener('click', () => {fitting = false; zoom(1);});
    controls.fit.addEventListener('click', fit);
    controls.close.addEventListener('click', close);
    dialog.addEventListener('cancel', event => {event.preventDefault(); close();});
    // Native close events are queued; ignore an old one after another diagram opens.
    dialog.addEventListener('close', () => {if (!dialog.open) restore();});
    dialog.addEventListener('click', event => {if (event.target === dialog) close();});
    addEventListener('resize', () => {if (dialog.open && fitting) fit();});
    // Put the SVG back in the document before printing it.
    addEventListener('beforeprint', close);
  }

  function open(figure, button) {
    if (!figure.hasAttribute('data-rendered')) return;
    close();
    create();
    const svg = figure.querySelector('.diagram-canvas svg');
    if (!svg) return;
    active = figure; image = svg; opener = button;
    overflow = document.documentElement.style.overflow;
    canvas.replaceChildren(image);
    dialog.showModal();
    document.documentElement.style.overflow = 'hidden';
    fit(); canvas.scrollTop = 0; canvas.scrollLeft = 0;
    controls.close.focus({preventScroll:true});
  }

  globalThis.mdviewDiagrams = {
    prepare(figure, svg) {
      const button = figure.querySelector('.diagram-expand');
      if (!button.dataset.ready) {
        button.addEventListener('click', () => open(figure, button));
        button.dataset.ready = 'true';
      }
      figure.querySelector('.diagram-toolbar').hidden = false;
      if (active === figure) {
        image = svg;
        canvas.replaceChildren(image);
        if (fitting) fit(); else zoom(scale);
      }
    },
    reset(figure) {
      if (active === figure) close();
      figure.querySelector('.diagram-toolbar').hidden = true;
    },
  };
})();
