// Read textContent before highlighting so copying preserves literal source.
(() => {
  function legacyCopy(text) {
    const active = document.activeElement;
    const selection = document.getSelection();
    const ranges = [];
    if (selection) {
      for (let i = 0; i < selection.rangeCount; ++i) ranges.push(selection.getRangeAt(i).cloneRange());
    }
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(field);
    try {
      field.select();
      return document.execCommand('copy');
    } finally {
      field.remove();
      if (active) active.focus({preventScroll: true});
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }

  async function copy(text) {
    try {
      if (globalThis.navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* Local file pages and denied permissions may need the fallback. */ }
    try { return legacyCopy(text); } catch { return false; }
  }

  for (const block of document.querySelectorAll('.md-code-block')) {
    const code = block.querySelector('pre > code');
    const button = block.querySelector('.code-copy');
    const status = block.querySelector('.code-status');
    const source = code.textContent;
    const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9).toLowerCase();
    // No guessing: unknown/unlabeled blocks and Mermaid source stay plain text.
    try {
      if (language && language !== 'mermaid' && globalThis.hljs?.getLanguage(language)) {
        code.innerHTML = hljs.highlight(source, {language, ignoreIllegals: true}).value;
        code.classList.add('hljs');
      }
    } catch { /* A failed highlighter must not prevent reading or copying. */ }

    block.querySelector('.code-toolbar').hidden = false;
    let reset;
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      clearTimeout(reset);
      button.disabled = true;
      button.dataset.state = 'idle';
      button.title = 'Copy code';
      status.textContent = '';
      const copied = await copy(source);
      button.disabled = false;
      button.dataset.state = copied ? 'success' : 'error';
      button.title = copied ? 'Code copied' : 'Copy failed';
      status.textContent = copied ? 'Code copied.' : 'Select and copy the code manually.';
      reset = setTimeout(() => {
        button.dataset.state = 'idle';
        button.title = 'Copy code';
        status.textContent = '';
      }, copied ? 2000 : 4000);
    });
  }
})();
