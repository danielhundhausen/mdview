const inline = [...document.querySelectorAll('.md-math')];
const figures = [...document.querySelectorAll('.md-math-block')];
function figureUnavailable(figure, message) {
  figure.removeAttribute('data-rendered');
  figure.querySelector('.math-canvas').hidden = true;
  figure.querySelector('details').open = true;
  const status = figure.querySelector('.math-status');
  status.textContent = message; status.hidden = false;
}
try {
  const mathjax = globalThis.MathJax;
  if (!mathjax?.startup?.promise) throw new Error('Bundled MathJax runtime unavailable');
  // tex2svg is only installed once startup finishes, so check after awaiting it.
  await mathjax.startup.promise;
  if (!mathjax.tex2svg || !mathjax.startup.adaptor)
    throw new Error('Bundled MathJax runtime unavailable');
  const render = (source, display) =>
    mathjax.startup.adaptor.outerHTML(mathjax.tex2svg(source, {display}));
  for (const element of inline) {
    try {
      element.innerHTML = render(element.textContent, element.classList.contains('md-math-display'));
      element.setAttribute('data-rendered', '');
    } catch (error) {
      element.removeAttribute('data-rendered');
      console.warn('mdview: math failed', error);
    }
  }
  for (const figure of figures) {
    try {
      const canvas = figure.querySelector('.math-canvas');
      canvas.innerHTML = render(figure.querySelector('code').textContent, true);
      canvas.hidden = false;
      if (!figure.hasAttribute('data-rendered')) figure.querySelector('details').open = false;
      figure.setAttribute('data-rendered', '');
      figure.querySelector('.math-status').hidden = true;
    } catch (error) {
      figureUnavailable(figure, 'Could not render this mathematics. Check the source below.');
      console.warn('mdview: math block failed', error);
    }
  }
} catch (error) {
  figures.forEach(figure => figureUnavailable(figure, 'Could not initialize MathJax. Source is shown below.'));
  console.warn('mdview: MathJax runtime unavailable', error);
}
