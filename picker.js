/*
  Standalone Element Picker — faithful port of uBlock Origin's picker logic,
  now with a UI layout closer to the real uBO dialog: editable filter text,
  side-by-side depth/specificity sliders, a drag handle, and dark mode.
*/
(function () {
  if (window.__epicker) { window.__epicker.disable(); return; }

  const state = {
    filters: [], elements: [], slot: 0, specIndex: 0, current: null,
    candidatesCache: new Map(), panel: null, handler: null, scrollHandler: null,
    highlighted: [], manualText: null, dragging: false,
    theme: localStorage.getItem('epk-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  };
  window.__epicker = state;

  function safeQSA(node, sel) {
    if (!node) return [];
    try { return node.querySelectorAll(sel); } catch (e) { return []; }
  }

  // ---- per-element selector segment, ported from cosmeticFilterFromElement ----
  function segmentFor(elem) {
    let selector = '';
    let v = typeof elem.id === 'string' && CSS.escape(elem.id);
    if (v) selector = '#' + v;

    v = elem.classList;
    if (v) {
      let i = v.length || 0;
      while (i--) selector += '.' + CSS.escape(v.item(i));
    }

    const tagName = CSS.escape(elem.localName);

    if (selector === '') {
      const attributes = [];
      if (tagName === 'a') {
        v = elem.getAttribute('href');
        if (v) {
          v = v.trim().replace(/\?.*$/, '');
          if (v.length) attributes.push({ k: 'href', v: v });
        }
      } else if (tagName === 'iframe' || tagName === 'img') {
        v = elem.getAttribute('src');
        if (v && v.length !== 0) {
          v = v.trim();
          if (v.startsWith('data:')) {
            const pos = v.indexOf(',');
            if (pos !== -1) v = v.slice(0, pos + 1);
          } else if (v.startsWith('blob:')) {
            try { const u = new URL(v.slice(5)); u.pathname = ''; v = 'blob:' + u.href; } catch (e) {}
          }
          attributes.push({ k: 'src', v: v.slice(0, 256) });
        } else {
          v = elem.getAttribute('alt');
          if (v && v.length !== 0) attributes.push({ k: 'alt', v: v });
        }
      }
      let attr;
      while ((attr = attributes.pop())) {
        if (attr.v.length === 0) continue;
        const w = attr.v.replace(/([^\\])"/g, '$1\\"');
        v = elem.getAttribute(attr.k);
        if (attr.v === v) selector += `[${attr.k}="${w}"]`;
        else if (v.startsWith(attr.v)) selector += `[${attr.k}^="${w}"]`;
        else selector += `[${attr.k}*="${w}"]`;
      }
    }

    const parentNode = elem.parentNode;
    if (selector === '' || safeQSA(parentNode, ':scope > ' + selector).length > 1) {
      selector = tagName + selector;
    }
    if (safeQSA(parentNode, ':scope > ' + selector).length > 1) {
      let i = 1, e = elem;
      while (e.previousSibling !== null) {
        e = e.previousSibling;
        if (typeof e.localName === 'string' && e.localName === elem.localName) i++;
      }
      selector += `:nth-of-type(${i})`;
    }
    return selector;
  }

  function filtersFrom(first) {
    const filters = [];
    const elements = [];
    let elem = first;
    while (elem && elem !== document.body && elem.nodeType === 1) {
      filters.push('##' + segmentFor(elem));
      elements.push(elem);
      elem = elem.parentNode;
    }
    if (filters.length !== 0) {
      const selector = filters[filters.length - 1].slice(2);
      if (safeQSA(document.body, selector).length > 1) {
        filters.push('##body');
        elements.push(document.body);
      }
    }
    return { filters, elements };
  }

  function pathsForSlot(slot, filters) {
    const specificities = [0b0000, 0b0010, 0b0011, 0b1000, 0b1010, 0b1100, 0b1110, 0b1111];
    const needBody = true;
    const candidates = [];
    for (const specificity of specificities) {
      const paths = [];
      for (let i = slot; i < filters.length; i++) {
        let filter = filters[i].slice(2);
        if ((specificity & 0b0001) === 0) {
          filter = filter.replace(/:nth-of-type\(\d+\)/, '');
          if (filter.charAt(0) === '#' && ((specificity & 0b1000) === 0 || i === slot)) {
            const pos = filter.search(/[^\\]\./);
            if (pos !== -1) filter = filter.slice(pos + 1);
          }
        }
        if ((specificity & 0b0010) === 0) {
          const match = /^\[([^^*$=]+)[\^*$]?=.+\]$/.exec(filter);
          if (match !== null) filter = `[${match[1]}]`;
        }
        if (filter.charAt(0) === '#') {
          filter = filter.replace(/([^\\])\..+$/, '$1');
        }
        if (paths.length !== 0) filter += ' > ';
        paths.unshift(filter);
        if ((specificity & 0b1000) === 0 || filter.startsWith('#')) break;
      }
      if ((specificity & 0b1100) === 0b1000) {
        let i = 0;
        while (i < paths.length - 1) {
          if (/^[a-z0-9]+ > $/.test(paths[i + 1])) {
            if (paths[i].endsWith(' > ')) paths[i] = paths[i].slice(0, -2);
            paths.splice(i + 1, 1);
          } else i += 1;
        }
      }
      if (needBody && paths.length !== 0 && paths[0].startsWith('#') === false &&
          paths[0].startsWith('body ') === false && (specificity & 0b1100) !== 0) {
        paths.unshift('body > ');
      }
      candidates.push(paths);
    }
    return candidates;
  }

  function optimizeCandidates(candidates) {
    const results = [];
    for (const paths of candidates) {
      let count = Number.MAX_SAFE_INTEGER;
      let selector = '';
      for (let i = 0, n = paths.length; i < n; i++) {
        const s = paths.slice(n - i - 1).join('');
        let elems;
        try { elems = document.querySelectorAll(s); } catch (e) { continue; }
        if (elems.length < count) { selector = s; count = elems.length; }
      }
      if (selector === '') continue;
      results.push({ selector: '##' + selector, count });
    }
    const seen = new Set();
    const uniq = results.filter(r => !seen.has(r.selector) && seen.add(r.selector));
    uniq.sort((a, b) => (b.count - a.count) || (a.selector.length - b.selector.length));
    return uniq;
  }

  function candidatesForSlot(slot) {
    if (state.candidatesCache.has(slot)) return state.candidatesCache.get(slot);
    const optimized = optimizeCandidates(pathsForSlot(slot, state.filters));
    state.candidatesCache.set(slot, optimized);
    return optimized;
  }

  function nameFor(filterStr) { return (filterStr || '').replace(/^##/, ''); }
  function selectorFromText(text) {
    const i = text.indexOf('##');
    return i === -1 ? text : text.slice(i + 2);
  }

  // ---- highlight ----
  function clearMatchHighlights() {
    state.highlighted.forEach(el => {
      el.style.outline = el.__epkOldOutline || '';
      el.style.outlineOffset = '';
    });
    state.highlighted = [];
  }
  function applyMatchHighlights(sel, excludeEl) {
    clearMatchHighlights();
    let matches;
    try { matches = document.querySelectorAll(sel); } catch (e) { return 0; }
    matches.forEach(el => {
      if (el === excludeEl) return;
      el.__epkOldOutline = el.style.outline;
      el.style.outline = '2px dashed #f5a623';
      el.style.outlineOffset = '-2px';
    });
    state.highlighted = Array.from(matches).filter(el => el !== excludeEl);
    return matches.length;
  }

  const spotlight = document.createElement('div');
  spotlight.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #e6432c;' +
    'border-radius:2px;box-shadow:0 0 0 9999px rgba(0,0,0,.45);transition:all 120ms ease;' +
    'display:none;box-sizing:border-box;';
  document.documentElement.appendChild(spotlight);

  const nameLabel = document.createElement('div');
  nameLabel.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;background:#e6432c;color:#fff;' +
    'font:12px/1.4 monospace;padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;' +
    'max-width:90vw;overflow:hidden;text-overflow:ellipsis;';
  document.documentElement.appendChild(nameLabel);

  function positionSpotlight() {
    const el = state.elements[state.slot] || state.current;
    if (!el) { spotlight.style.display = 'none'; nameLabel.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    spotlight.style.display = 'block';
    spotlight.style.left = r.left + 'px';
    spotlight.style.top = r.top + 'px';
    spotlight.style.width = r.width + 'px';
    spotlight.style.height = r.height + 'px';

    nameLabel.style.display = 'block';
    nameLabel.textContent = nameFor(state.filters[state.slot]);
    const above = r.top > 22;
    nameLabel.style.left = Math.max(0, r.left) + 'px';
    nameLabel.style.top = (above ? r.top - 20 : r.bottom + 2) + 'px';
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // ---- theme ----
  const THEMES = {
    light: { bg: '#fff', fg: '#222', sub: '#666', border: '#ddd', panelShadow: '0 4px 20px rgba(0,0,0,.2)',
      chipBg: '#fff', chipBorder: '#ddd', codeBg: '#111', codeFg: '#0f0', trackBg: '#eee' },
    dark: { bg: '#1e1f22', fg: '#e8e8e8', sub: '#9a9a9a', border: '#3a3b3e', panelShadow: '0 4px 24px rgba(0,0,0,.6)',
      chipBg: '#2a2b2e', chipBorder: '#444', codeBg: '#000', codeFg: '#5cff5c', trackBg: '#333' },
  };
  function theme() { return THEMES[state.theme]; }

  // ---- panel ----
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:2147483647;border-radius:10px;padding:12px;' +
    'width:320px;max-height:85vh;overflow-y:auto;font-family:sans-serif;font-size:13px;' +
    'border:1px solid;transition:background 150ms,color 150ms;';
  document.body.appendChild(panel);
  state.panel = panel;

  function currentCandidates() { return candidatesForSlot(state.slot); }
  function currentSelectorObj() {
    const c = currentCandidates();
    return c[state.specIndex] || c[c.length - 1] || { selector: '', count: 0 };
  }
  function fullFilterText() {
    const sel = currentSelectorObj().selector;
    return sel ? location.hostname + sel : '';
  }

  function applyPreviewFromText(text) {
    const sel = selectorFromText(text);
    const n = sel ? applyMatchHighlights(sel, state.elements[state.slot]) : 0;
    const cnt = panel.querySelector('#epk-count');
    if (cnt) cnt.textContent = n + ' element' + (n === 1 ? '' : 's') + ' match';
  }

  function applyPreview() {
    state.manualText = null;
    const box = panel.querySelector('#epk-filter-text');
    if (box) box.value = fullFilterText();
    applyPreviewFromText(fullFilterText());
  }

  function themeCss(t) {
    return 'background:' + t.bg + ';color:' + t.fg + ';border-color:' + t.border + ';box-shadow:' + t.panelShadow + ';';
  }

  function render() {
    const t = theme();
    panel.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:2147483647;border-radius:10px;padding:12px;' +
      'width:320px;max-height:85vh;overflow-y:auto;font-family:sans-serif;font-size:13px;' +
      'border:1px solid;transition:background 150ms,color 150ms;' + themeCss(t);

    const header =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<strong style="font-size:14px;">Element Picker</strong>' +
      '<div style="display:flex;gap:4px;align-items:center;">' +
      '<button id="epk-theme" title="Toggle dark mode" style="background:none;border:1px solid ' + t.border +
      ';border-radius:6px;font-size:13px;cursor:pointer;color:' + t.fg + ';padding:2px 6px;">' +
      (state.theme === 'dark' ? '\u2600\ufe0f' : '\ud83c\udf19') + '</button>' +
      '<button id="epk-close" style="background:none;border:none;font-size:16px;cursor:pointer;color:' + t.sub + ';">\u2715</button>' +
      '</div></div>';

    if (!state.current) {
      panel.innerHTML = header + '<p style="color:' + t.sub + ';text-align:center;padding:12px 0;">Tap an element on the page to inspect it</p>';
      panel.querySelector('#epk-close').addEventListener('click', disable);
      panel.querySelector('#epk-theme').addEventListener('click', toggleTheme);
      return;
    }

    let html = header;

    html += '<textarea id="epk-filter-text" spellcheck="false" rows="2" style="width:100%;box-sizing:border-box;' +
      'font-family:monospace;font-size:12px;background:' + t.codeBg + ';color:' + t.codeFg + ';' +
      'border:1px solid ' + t.border + ';border-radius:6px;padding:6px;resize:vertical;margin-bottom:6px;"></textarea>';

    html += '<div id="epk-count" style="font-size:11px;color:' + t.sub + ';margin-bottom:10px;"></div>';

    html += '<div style="display:flex;gap:10px;margin-bottom:4px;">' +
      '<div style="flex:1;"><div style="font-weight:600;font-size:11px;">Depth</div>' +
      '<div style="font-size:10px;color:' + t.sub + ';">element \u2192 ancestor</div></div>' +
      '<div style="flex:1;"><div style="font-weight:600;font-size:11px;">Specificity</div>' +
      '<div style="font-size:10px;color:' + t.sub + ';">broad \u2192 narrow</div></div></div>';

    html += '<div style="display:flex;gap:10px;margin-bottom:10px;">' +
      '<input id="epk-depth" type="range" min="0" max="' + Math.max(0, state.filters.length - 1) +
      '" value="' + state.slot + '" style="flex:1;">' +
      '<input id="epk-spec" type="range" min="0" max="' + Math.max(0, currentCandidates().length - 1) +
      '" value="' + state.specIndex + '" style="flex:1;"></div>';

    html += '<div style="font-weight:600;margin-bottom:4px;font-size:12px;">Elements at this point</div>' +
      '<div id="epk-chain" style="display:flex;gap:4px;overflow-x:auto;padding-bottom:8px;margin-bottom:8px;white-space:nowrap;"></div>';

    html += '<div style="display:flex;align-items:stretch;gap:6px;">' +
      '<button id="epk-preview" style="flex:1;padding:8px 4px;background:' + t.chipBg + ';color:' + t.fg +
      ';border:1px solid ' + t.border + ';border-radius:6px;cursor:pointer;font-size:12px;">Preview</button>' +
      '<div id="epk-drag" title="Drag to move" style="flex:1.4;border-radius:6px;cursor:move;' +
      'background:repeating-linear-gradient(45deg,' + t.trackBg + ',' + t.trackBg + ' 3px,transparent 3px,transparent 6px);' +
      'display:flex;align-items:center;justify-content:center;color:' + t.sub + ';font-size:14px;">\u2725</div>' +
      '<button id="epk-copy" style="flex:1;padding:8px 4px;background:#e6432c;color:#fff;border:none;' +
      'border-radius:6px;cursor:pointer;font-size:12px;">Copy</button>' +
      '<button id="epk-pick" style="flex:1;padding:8px 4px;background:' + t.chipBg + ';color:' + t.fg +
      ';border:1px solid ' + t.border + ';border-radius:6px;cursor:pointer;font-size:12px;">Pick</button>' +
      '<button id="epk-quit" style="flex:1;padding:8px 4px;background:' + t.chipBg + ';color:' + t.fg +
      ';border:1px solid ' + t.border + ';border-radius:6px;cursor:pointer;font-size:12px;">Quit</button>' +
      '</div>';

    panel.innerHTML = html;
    panel.querySelector('#epk-close').addEventListener('click', disable);
    panel.querySelector('#epk-theme').addEventListener('click', toggleTheme);
    panel.querySelector('#epk-quit').addEventListener('click', disable);
    panel.querySelector('#epk-pick').addEventListener('click', () => {
      clearMatchHighlights();
      state.current = null;
      positionSpotlight();
      render();
    });
    panel.querySelector('#epk-preview').addEventListener('click', () => {
      const box = panel.querySelector('#epk-filter-text');
      applyPreviewFromText(box.value);
    });
    panel.querySelector('#epk-copy').addEventListener('click', (e) => {
      const box = panel.querySelector('#epk-filter-text');
      copyText(box.value);
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1200);
    });

    const chain = panel.querySelector('#epk-chain');
    state.filters.forEach((f, i) => {
      const chip = document.createElement('button');
      chip.textContent = nameFor(f).slice(0, 20);
      const active = i === state.slot;
      chip.style.cssText = 'flex:0 0 auto;padding:4px 8px;border-radius:12px;border:1px solid ' +
        (active ? '#e6432c' : t.chipBorder) + ';background:' + (active ? '#e6432c' : t.chipBg) +
        ';color:' + (active ? '#fff' : t.fg) + ';font-size:11px;cursor:pointer;';
      chip.addEventListener('click', () => setSlot(i));
      chain.appendChild(chip);
    });

    panel.querySelector('#epk-depth').addEventListener('input', (e) => setSlot(+e.target.value));
    panel.querySelector('#epk-spec').addEventListener('input', (e) => {
      state.specIndex = +e.target.value;
      applyPreview();
    });

    const filterBox = panel.querySelector('#epk-filter-text');
    filterBox.value = fullFilterText();
    filterBox.addEventListener('input', () => {
      state.manualText = filterBox.value;
      applyPreviewFromText(filterBox.value);
    });

    setupDrag(panel.querySelector('#epk-drag'));
    applyPreviewFromText(filterBox.value);
  }

  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('epk-theme', state.theme);
    render();
  }

  function setupDrag(handle) {
    let startX, startY, startLeft, startTop;
    function pointFrom(e) {
      return e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
    }
    function onDown(e) {
      const p = pointFrom(e);
      const rect = panel.getBoundingClientRect();
      startX = p.x; startY = p.y; startLeft = rect.left; startTop = rect.top;
      panel.style.right = 'auto';
      state.dragging = true;
      document.addEventListener('mousemove', onMoveDrag, true);
      document.addEventListener('touchmove', onMoveDrag, true);
      document.addEventListener('mouseup', onUp, true);
      document.addEventListener('touchend', onUp, true);
      e.preventDefault();
      e.stopPropagation();
    }
    function onMoveDrag(e) {
      const p = pointFrom(e);
      const dx = p.x - startX, dy = p.y - startY;
      panel.style.left = Math.max(0, startLeft + dx) + 'px';
      panel.style.top = Math.max(0, startTop + dy) + 'px';
      e.preventDefault();
    }
    function onUp() {
      state.dragging = false;
      document.removeEventListener('mousemove', onMoveDrag, true);
      document.removeEventListener('touchmove', onMoveDrag, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('touchend', onUp, true);
    }
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
  }

  function setSlot(i) {
    state.slot = i;
    const cands = candidatesForSlot(i);
    state.specIndex = cands.length - 1;
    positionSpotlight();
    render();
  }

  function select(el) {
    clearMatchHighlights();
    state.current = el;
    const built = filtersFrom(el);
    state.filters = built.filters;
    state.elements = built.elements;
    state.candidatesCache = new Map();
    state.slot = 0;
    const cands = candidatesForSlot(0);
    state.specIndex = cands.length - 1;
    positionSpotlight();
    render();
  }

  state.handler = function (e) {
    if (panel.contains(e.target)) return;
    if (state.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    select(e.target);
    return false;
  };
  document.addEventListener('click', state.handler, true);

  state.scrollHandler = function () { positionSpotlight(); };
  window.addEventListener('scroll', state.scrollHandler, true);
  window.addEventListener('resize', state.scrollHandler, true);

  function disable() {
    clearMatchHighlights();
    document.removeEventListener('click', state.handler, true);
    window.removeEventListener('scroll', state.scrollHandler, true);
    window.removeEventListener('resize', state.scrollHandler, true);
    if (panel.parentNode) panel.remove();
    spotlight.remove();
    nameLabel.remove();
    delete window.__epicker;
  }
  state.disable = disable;

  render();
})();
