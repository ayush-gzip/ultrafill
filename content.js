// UltraFill: fit the main video to its player box so wide screens have no side bars.
// Elastic mode never crops: it scales the picture to the box, then an SVG displacement
// filter squeezes the center back to its true shape and pushes the stretch to the edges.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const MIN_BOX_FRACTION = 0.6; // only touch main players, not small inline videos
  const LABELS = { elastic: 'Elastic', stretch: 'Stretch', zoom: 'Zoom', off: 'Off' };
  const MAP_SAMPLES = 1024;
  const MAX_MAPS = 8;
  const SETTLE_MS = 200;

  let mode = 'elastic';
  let nextId = 1;
  let nextMap = 1;
  let rafPending = false;
  let styleEl = null;
  let svgEl = null;
  let toastEl = null;
  let toastTimer = 0;
  const tracked = new Map(); // video -> { id, sig, box, filter, settled, timer }
  const rules = new Map(); // id -> css declarations
  // shape key -> filter id. A map is in units of the element box, so any video of the same
  // shape at any size can use it: fullscreen in and out reuses maps and builds nothing.
  const maps = new Map();

  // Runs after layout and before paint, so a new size never shows a frame with the old fit.
  const ro = new ResizeObserver(run);

  function contain(w, h, aspect) {
    return w / h > aspect ? { w: h * aspect, h } : { w, h: w / aspect };
  }

  function svgNode(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  // An SPA can remove our nodes; put the same ones back so their rules and maps stay valid.
  function ensureDom() {
    if (!styleEl) styleEl = document.createElement('style');
    if (!styleEl.isConnected) (document.head || document.documentElement).append(styleEl);
    if (!svgEl) svgEl = svgNode('svg', { 'aria-hidden': 'true', style: 'position:absolute;width:0;height:0;pointer-events:none' });
    if (!svgEl.isConnected) (document.body || document.documentElement).append(svgEl);
  }

  function setRule(t, css) {
    if (css) rules.set(t.id, css);
    else rules.delete(t.id);
    ensureDom();
    styleEl.textContent = [...rules].map(([id, c]) => `video[data-uf="${id}"]{${c}}`).join('\n');
  }

  function dropFilter(t) {
    t.filter = '';
    t.settled = false;
    clearTimeout(t.timer);
  }

  // Output x shows source u(x), with x and u from -1 to 1 across the picture.
  // c = horizontal scale / vertical scale. Slope c over the center cancels the extra
  // width, so the center |x| <= a keeps its true shape; past a, a quadratic takes the
  // edges back to u(1) = 1, so the edges take all the stretch.
  function curve(x, c, a) {
    const ax = Math.abs(x);
    const u = ax <= a ? c * ax : c * ax + ((1 - c) / (1 - a) ** 2) * (ax - a) ** 2;
    return Math.sign(x) * u;
  }

  // c = horizontal scale / vertical scale, r = element width / picture width (r > 1 when
  // the picture letterboxes inside the element). Returns the id of a <filter> in box units.
  function buildMap(c, r) {
    const a = (0.5 * (2 - c)) / c;
    const shift = new Float64Array(MAP_SAMPLES); // as a fraction of the element width
    let max = 0;
    for (let i = 0; i < MAP_SAMPLES; i++) {
      const x = Math.max(-1, Math.min(1, (((i + 0.5) / MAP_SAMPLES) * 2 - 1) * r));
      shift[i] = (curve(x, c, a) - x) / (2 * r);
      max = Math.max(max, Math.abs(shift[i]));
    }
    const scale = 2.02 * max;

    // Chrome runs every color that enters a filter through the display's tone curve
    // (128 arrives as ~117), which skews a color-coded map and moves the picture.
    // Alpha is never color corrected, so the map is coded in alpha and feColorMatrix
    // moves it to R. G is a fixed 0.5: no vertical shift.
    // willReadFrequently keeps the canvas on the CPU: toDataURL on a GPU canvas stalls ~30ms.
    const canvas = document.createElement('canvas');
    canvas.width = MAP_SAMPLES;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(MAP_SAMPLES, 1);
    for (let i = 0; i < MAP_SAMPLES; i++) img.data[i * 4 + 3] = Math.round((0.5 + shift[i] / scale) * 255);
    ctx.putImageData(img, 0, 0);

    const id = `uf-m-${nextMap++}`;
    const filter = svgNode('filter', { id, x: 0, y: 0, width: 1, height: 1, primitiveUnits: 'objectBoundingBox', 'color-interpolation-filters': 'sRGB' });
    filter.append(
      svgNode('feImage', { href: canvas.toDataURL(), preserveAspectRatio: 'none', result: 'a' }),
      svgNode('feColorMatrix', { in: 'a', type: 'matrix', values: '0 0 0 1 0  0 0 0 0 0.5  0 0 0 0 0  0 0 0 0 1', result: 'map' }),
      svgNode('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G' }),
    );
    ensureDom();
    svgEl.append(filter);
    return id;
  }

  function filterFor(v, t, ratio, aspect) {
    const c = +Math.min(ratio, 1.95).toFixed(3); // the curve folds back at c = 2
    const r = +(v.offsetWidth / contain(v.offsetWidth, v.offsetHeight, aspect).w).toFixed(3);
    const key = `${c} ${r}`;
    let id = maps.get(key);
    if (!id && t.filter && !t.settled) {
      // Still resizing (a fullscreen animation): keep the current map, it stretches with
      // the box. Build the new one when the size holds still.
      clearTimeout(t.timer);
      t.timer = setTimeout(() => { t.settled = true; t.sig = ''; schedule(); }, SETTLE_MS);
      return t.filter;
    }
    t.settled = false;
    if (id) {
      maps.delete(key); // move to the end: the oldest entry goes first
    } else {
      id = buildMap(c, r);
      const inUse = new Set([...tracked.values()].map((x) => x.filter));
      for (const [k, old] of maps) {
        if (maps.size < MAX_MAPS) break;
        if (inUse.has(old)) continue;
        maps.delete(k);
        svgEl.querySelector(`#${old}`)?.remove();
      }
    }
    maps.set(key, id);
    t.filter = id;
    return id;
  }

  // The player box: the video element itself when it letterboxes inside its own box
  // (Netflix, Crunchyroll), else the first ancestor that covers the picture (YouTube).
  function findBox(v, r0, d0) {
    if (r0.width - d0.w > 2 || r0.height - d0.h > 2) return v;
    for (let a = v.parentElement; a; a = a.parentElement) {
      const r = a.getBoundingClientRect();
      if (r.width >= d0.w - 1 && r.height >= d0.h - 1) return a;
    }
    return v;
  }

  function fit(v, t) {
    const aspect = v.videoWidth / v.videoHeight;
    v.removeAttribute('data-uf');
    const r0 = v.getBoundingClientRect();
    const d = contain(r0.width, r0.height, aspect);
    const d0 = { x: r0.left + (r0.width - d.w) / 2, y: r0.top + (r0.height - d.h) / 2, w: d.w, h: d.h };

    const box = findBox(v, r0, d0);
    if (box !== t.box) {
      if (t.box && t.box !== v) ro.unobserve(t.box);
      if (box !== v) ro.observe(box);
      t.box = box;
    }
    const b = box === v ? r0 : box.getBoundingClientRect();
    if (b.width < innerWidth * MIN_BOX_FRACTION) return false;

    let sx = b.width / d0.w;
    let sy = b.height / d0.h;
    let x = b.left;
    let y = b.top;
    if (mode === 'zoom') {
      sx = sy = Math.max(sx, sy);
      x = b.left + (b.width - d0.w * sx) / 2;
      y = b.top + (b.height - d0.h * sy) / 2;
    } else if (sx / sy < 1.01) {
      return false; // no side bars: elastic and stretch only widen
    }
    if (Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return false;

    // Use the scale/translate properties so the page's own transform (Netflix centers
    // its video with one) still applies. Scale first, measure where the picture
    // landed, then translate it onto the target.
    setRule(t, `scale:${sx} ${sy} !important;translate:none !important;`);
    v.setAttribute('data-uf', t.id);
    const r1 = v.getBoundingClientRect();
    const tx = x - (r1.left + sx * (d0.x - r0.left));
    const ty = y - (r1.top + sy * (d0.y - r0.top));
    let css = `scale:${sx} ${sy} !important;translate:${tx}px ${ty}px !important;`;
    if (mode === 'elastic') {
      css += `filter:url(#${filterFor(v, t, sx / sy, aspect)}) !important;`;
    } else {
      dropFilter(t);
    }
    setRule(t, css);
    return true;
  }

  function clear(v, t) {
    v.removeAttribute('data-uf');
    if (rules.has(t.id)) setRule(t, null);
    dropFilter(t);
  }

  function sigOf(v, t) {
    const b = t.box && t.box !== v ? t.box : null;
    return [mode, v.videoWidth, v.videoHeight, v.offsetWidth, v.offsetHeight, v.offsetLeft, v.offsetTop,
      b?.offsetWidth, b?.offsetHeight, innerWidth, innerHeight, !!document.fullscreenElement].join();
  }

  function update(v, t) {
    if (!v.isConnected) {
      clear(v, t);
      ro.unobserve(v);
      if (t.box && t.box !== v) ro.unobserve(t.box);
      tracked.delete(v);
      return;
    }
    if (sigOf(v, t) === t.sig) return;
    const applied = mode !== 'off' && v.videoWidth > 0 && fit(v, t);
    if (!applied) clear(v, t);
    t.sig = sigOf(v, t);
  }

  function run() {
    for (const [v, t] of tracked) update(v, t);
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      run();
    });
  }

  function track(v) {
    if (tracked.has(v)) return;
    tracked.set(v, { id: nextId++, sig: '', box: null, filter: '', settled: false, timer: 0 });
    ro.observe(v);
    v.addEventListener('loadedmetadata', schedule);
    v.addEventListener('resize', schedule);
  }

  function scan() {
    if (styleEl) ensureDom();
    for (const v of document.getElementsByTagName('video')) track(v);
    schedule();
  }

  function toast(text) {
    const fs = document.fullscreenElement;
    const host = fs && !(fs instanceof HTMLVideoElement) ? fs : document.body;
    if (!host) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('style', 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'padding:8px 16px;border-radius:8px;background:rgba(0,0,0,.75);color:#fff;font:600 14px/1.2 system-ui,sans-serif;' +
        'pointer-events:none;transition:opacity .3s');
    }
    toastEl.textContent = `UltraFill: ${text}`;
    toastEl.style.opacity = '1';
    host.append(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 1200);
  }

  chrome.storage.sync.get({ mode: 'elastic' }, (s) => {
    mode = s.mode;
    scan();
    setInterval(scan, 1000);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.mode) return;
    mode = changes.mode.newValue;
    if ([...tracked.keys()].some((v) => v.videoWidth > 0)) toast(LABELS[mode] || mode);
    schedule();
  });

  addEventListener('resize', schedule);
  document.addEventListener('fullscreenchange', schedule);
})();
