(() => {
  const toc = document.querySelector('.toc');
  if (!toc) return;

  // Apply the viewport default once. Resizing should not undo a reader's toggle.
  toc.open = !window.matchMedia('(max-width: 1000px)').matches;
  const entries = [...toc.querySelectorAll('a[data-heading-id]')].map(link => ({
    link, heading: document.getElementById(link.dataset.headingId),
  })).filter(entry => entry.heading);
  if (!entries.length) return;

  const nav = toc.querySelector('nav');
  const label = document.createRange();
  let markerReady = false, markerGeometry = '';
  function positionMarker() {
    if (!toc.open) {
      nav.classList.remove('toc-motion');
      markerReady = false;
      nav.style.setProperty('--toc-mark-opacity', '0');
      return;
    }
    // Follow the label's ink rather than filling the entire navigation row.
    // Coordinates include the outline's own scroll offset on narrow screens.
    label.selectNodeContents(current);
    const text = label.getBoundingClientRect(), bounds = nav.getBoundingClientRect();
    if (!text.width || !text.height) return;
    const geometry = [text.left - bounds.left + nav.scrollLeft - 6,
      text.top - bounds.top + nav.scrollTop - 2, text.width + 12, text.height + 4];
    const key = geometry.join(',');
    if (key !== markerGeometry) {
      ['x', 'y', 'width', 'height'].forEach((name, index) => {
        nav.style.setProperty('--toc-mark-' + name, geometry[index] + 'px');
      });
      markerGeometry = key;
    }
    nav.style.setProperty('--toc-mark-opacity', '1');
    if (!markerReady) {
      // Commit the initial position before enabling motion, avoiding a slide
      // from the corner when a page or previously collapsed outline first opens.
      nav.getBoundingClientRect();
      nav.classList.add('toc-motion');
      markerReady = true;
    }
  }

  let current = null, pending = false;
  function update() {
    pending = false;
    // Select the latest heading to pass a small reading margin near the top.
    // A binary search keeps long outlines inexpensive while scrolling.
    const margin = Math.min(96, window.innerHeight * .2);
    let low = 0, high = entries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (entries[middle].heading.getBoundingClientRect().top <= margin) low = middle + 1;
      else high = middle;
    }
    let index = Math.max(0, low - 1);
    // The final section may be too short to reach the reading margin.
    if (window.scrollY > 0 && window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - 2) index = entries.length - 1;
    const next = entries[index].link;
    if (current !== next) {
      current?.removeAttribute('aria-current');
      next.setAttribute('aria-current', 'location');
      current = next;
    }
    positionMarker();
  }
  function schedule() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(update);
  }
  window.addEventListener('scroll', schedule, {passive: true});
  window.addEventListener('resize', schedule);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('load', schedule, {once: true});
  toc.addEventListener('toggle', schedule);
  // Images, diagrams, and restoring the outline in watch mode can move headings.
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(schedule);
    observer.observe(document.querySelector('main'));
    observer.observe(toc);
  }
  update();
})();
