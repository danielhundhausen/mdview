(() => {
  if (location.protocol !== 'http:') return;
  // Keep the saved HTML usable as a standalone file, but serve relative assets
  // from the Markdown directory when viewing the live HTTP preview.
  const base = document.querySelector('base');
  base.href = location.origin + '/files' + new URL(base.href).pathname;
  const revision = document.querySelector('meta[name="mdview-revision"]').content;
  const key = 'mdview-scroll:' + location.pathname;
  document.addEventListener('DOMContentLoaded', () => {
    // Saved pages use their absolute file URL to override the asset <base>.
    // In watch mode, keep heading, outline, and Markdown fragments on /preview.
    for (const link of document.querySelectorAll('a[data-mdview-fragment]')) {
      link.href = location.origin + location.pathname + location.search + (link.hash || '#');
    }
    const toc = document.querySelector('.toc');
    if (toc && saved && typeof saved.tocOpen === 'boolean') toc.open = saved.tocOpen;
  }, {once: true});
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(key));
    sessionStorage.removeItem(key);
  } catch (_) { /* Storage can be disabled by browser settings. */ }
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    history.scrollRestoration = 'manual';
    // Images and asynchronous Mermaid rendering can increase the page height
    // after load. Keep restoring until the requested position becomes possible.
    let active = true;
    const restore = () => {
      if (!active) return;
      window.scrollTo(saved.x, saved.y);
    };
    const observer = new ResizeObserver(restore);
    const stop = () => {
      active = false;
      observer.disconnect();
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
      window.removeEventListener('pointerdown', stop);
    };
    window.addEventListener('wheel', stop, {passive: true});
    window.addEventListener('touchstart', stop, {passive: true});
    window.addEventListener('keydown', stop);
    window.addEventListener('pointerdown', stop);
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body);
      restore();
    }, {once: true});
    window.addEventListener('load', () => {
      restore();
      setTimeout(stop, 5000);
    }, {once: true});
  }
  // A recursive timeout prevents overlapping requests when the server is busy.
  async function check() {
    try {
      const response = await fetch(location.origin + '/revision', {cache: 'no-store'});
      if (response.ok && (await response.text()).trim() !== revision) {
        try {
          sessionStorage.setItem(key, JSON.stringify({x: window.scrollX, y: window.scrollY,
            tocOpen: document.querySelector('.toc')?.open}));
        } catch (_) { /* Native reload scroll restoration remains available. */ }
        location.reload();
        return;
      }
    } catch (_) { /* Keep the current page readable after the watcher stops. */ }
    setTimeout(check, 500);
  }
  document.addEventListener('DOMContentLoaded', () => setTimeout(check, 500), {once: true});
})();
