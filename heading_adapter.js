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
  let markerReady = false, markerGeometry = '', markerPoint = null;
  function positionMarker() {
    if (!toc.open) {
      nav.classList.remove('toc-motion');
      markerReady = false;
      markerPoint = null;
      nav.style.setProperty('--toc-mark-opacity', '0');
      return;
    }
    // Highlight the link's whole row, not its text ink: the block box is a
    // plain rectangle however many lines the label wraps over, so the raised
    // marker stays a clean slip of paper for single- and multi-line rows.
    // Coordinates include the outline's own scroll offset on narrow screens.
    const row = current.getBoundingClientRect(), bounds = nav.getBoundingClientRect();
    if (!row.width || !row.height) return;
    const geometry = [row.left - bounds.left + nav.scrollLeft,
      row.top - bounds.top + nav.scrollTop, row.width, row.height];
    const key = geometry.join(',');
    if (key !== markerGeometry) {
      if (markerReady && markerPoint) {
        // Travel time grows gently with distance: a one-row hop lands almost
        // at once, a jump across the outline still arrives without swooping.
        const travel = Math.hypot(geometry[0] - markerPoint[0],
          geometry[1] - markerPoint[1]);
        const duration = Math.round(Math.min(320, Math.max(180, 170 + travel * .45)));
        nav.style.setProperty('--toc-mark-duration', duration + 'ms');
      }
      ['x', 'y', 'width', 'height'].forEach((name, index) => {
        nav.style.setProperty('--toc-mark-' + name, geometry[index] + 'px');
      });
      markerGeometry = key;
      markerPoint = [geometry[0], geometry[1]];
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

  // Keep the current row inside whichever box scrolls the outline: the sticky
  // sidebar on wide screens, the capped list itself on narrow ones. Only that
  // box moves; scrollIntoView would also drag the page away from the reader.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function reveal(link) {
    const box = [nav, toc.parentElement].find(element =>
      element && element.scrollHeight > element.clientHeight + 1);
    if (!box) return;
    const row = link.getBoundingClientRect(), view = box.getBoundingClientRect();
    // Leave a couple of neighbouring rows in sight, so the highlight never
    // rides the very edge of the scrolled outline.
    const pad = Math.min(64, box.clientHeight * .25);
    let delta = 0;
    if (row.top < view.top + pad) delta = row.top - view.top - pad;
    else if (row.bottom > view.bottom - pad) delta = row.bottom - view.bottom + pad;
    if (Math.abs(delta) < 1) return;
    box.scrollTo({top: box.scrollTop + delta,
      behavior: reducedMotion.matches ? 'auto' : 'smooth'});
  }

  let current = null, revealed = null, pending = false;
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
    // Follow only a new section or a reopened outline, so a reader browsing
    // the list by hand is not pulled back on every scroll frame.
    if (!toc.open) revealed = null;
    else if (revealed !== current) {
      reveal(current);
      revealed = current;
    }
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
