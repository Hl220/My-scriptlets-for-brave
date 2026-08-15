/*
  Standalone Element Picker — pixel-accurate replica of uBlock Origin's real
  picker dialog, built from the actual Firefox extension source:
    web_accessible_resources/epicker-ui.html
    css/epicker-ui.css + css/common.css + css/themes/default.css
    js/epicker-ui.js (renderRange, onDepthChanged, onSpecificityChanged)
    js/scriptlets/epicker.js (cosmeticFilterFromElement, candidate algorithm)

  Differences from the real extension (unavoidable outside the extension):
    - No Network filters section (needs the request-logging engine)
    - "Create" copies the filter to your clipboard instead of writing to
      uBO's own filter list (there is no filter list to write to)
    - No minimize button (kept the dialog to the parts you use)
*/
(function () {
  if (window.__epicker) { window.__epicker.disable(); return; }

  const state = {
    filters: [], elements: [], slot: 0, specIndex: 0, current: null,
    candidatesCache: new Map(), root: null, handler: null, scrollHandler: null,
    dragging: false, previewing: false, previewHidden: [],
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

  function selectorFromText(text) {
    const i = text.indexOf('##');
    return i === -1 ? text : text.slice(i + 2);
  }

  // ---- CSS, ported nearly verbatim from epicker-ui.css / common.css, scoped ----
  const CSS_TEXT = `
#ublock0-epicker {
  --surface-1: rgb(240 240 242); --surface-2: rgb(226 226 229); --surface-3: rgb(198 198 204);
  --border-1: rgb(184 184 192); --border-2: rgb(170 170 180);
  --ink-1: rgb(32 18 58); --ink-100: #fff; --ink-3: rgb(32 18 58 / 60%);
  --button-surface: rgb(198 198 204); --button-ink: var(--ink-1);
  --button-preferred-surface: rgb(34 93 176); --button-preferred-ink: #fff;
  --button-disabled-surface: var(--surface-3);
  --checkbox-checked-ink: var(--button-preferred-surface);
  --error-surface: #c00004;
  --elevation-up-surface: #000; --elevation-up1-opacity: 4%;
  --blue-50: 0 96 223;
  --font-size: 14px; --font-size-smaller: 13px; --button-border-radius: 5px;
  position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: var(--font-size);
  pointer-events: none;
  direction: ltr; unicode-bidi: isolate; text-transform: none; letter-spacing: normal;
}
#ublock0-epicker * { direction: ltr; unicode-bidi: isolate; text-transform: none !important; }
#ublock0-epicker.dark {
  --surface-1: rgb(27 27 35); --surface-2: rgb(47 47 59); --surface-3: rgb(69 69 85);
  --border-1: rgb(81 81 98); --border-2: rgb(93 93 110);
  --ink-1: rgb(226 226 229); --ink-100: #000; --ink-3: rgb(226 226 229 / 60%);
  --button-surface: rgb(69 69 85);
  --button-preferred-surface: rgb(137 170 247); --button-preferred-ink: #000;
  --error-surface: #ff5354;
  --elevation-up-surface: #fff; --elevation-up1-opacity: 12%;
}
#ublock0-epicker :focus { outline: none; }
#ublock0-epicker aside {
  background-color: var(--surface-1); border: 1px solid var(--border-2); box-sizing: border-box;
  cursor: default; display: flex; flex-direction: column;
  overflow-y: auto; position: fixed;
  color: var(--ink-1); box-shadow: 0 -4px 20px rgba(0,0,0,.3);
  pointer-events: auto; transition: none;
}
#ublock0-epicker aside.compact {
  right: 2px; bottom: 2px; width: auto; max-width: min(16rem, 100vw - 4px);
  min-width: min(16rem, 100vw - 4px); border-radius: 4px; box-shadow: 0 4px 20px rgba(0,0,0,.3);
}
#ublock0-epicker aside.compact > *:not(#windowbar) { display: none; }
#ublock0-epicker aside.expanded {
  left: 0; right: 0; bottom: 0; width: 100%; max-width: 100vw; box-sizing: border-box;
  border-radius: 5px 5px 0 0; border-bottom: none;
  max-height: 75vh; max-height: 75svh;
}
#ublock0-epicker aside.expanded > *:not(:first-child) { padding-left: 10px; padding-right: 10px; }
#ublock0-epicker aside > *:not(:first-child) { padding: 0 6px; }
#ublock0-epicker #windowbar { display: flex; }
#ublock0-epicker #windowbar #minimize,
#ublock0-epicker #windowbar #quit { height: 2em; width: 2em; cursor: pointer; flex-shrink: 0; }
#ublock0-epicker #windowbar #minimize:hover,
#ublock0-epicker #windowbar #quit:hover { background-color: var(--surface-2); }
#ublock0-epicker #windowbar #move {
  background-image: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAYAAAAECAYAAACtBE5DAAAAFElEQVQI12NgwAfKy8v/M5ANYLoBshgEyQo6H9UAAAAASUVORK5CYII=');
  cursor: grab; flex-grow: 1; opacity: 0.8; height: 2em;
}
#ublock0-epicker aside.moving #windowbar #move { cursor: grabbing; }
#ublock0-epicker #windowbar svg { fill: none; pointer-events: none; stroke: var(--ink-1); stroke-width: 3px; width: 100%; height: 100%; }
#ublock0-epicker #windowbar #minimize svg > rect { display: none; }
#ublock0-epicker aside.compact #windowbar #minimize svg > path { display: none; }
#ublock0-epicker aside.compact #windowbar #minimize svg > rect { display: initial; }
#ublock0-epicker .epk-section-title { font-weight: 600; font-size: 12px; margin: 8px 0 4px; }
#ublock0-epicker .epk-card-list { display: flex; flex-direction: column; gap: 4px; max-height: 30vh; overflow-y: auto; margin-bottom: 8px; }
#ublock0-epicker .epk-card {
  border: 1px solid var(--border-1); border-radius: 6px; padding: 6px 8px; cursor: pointer;
  background: var(--surface-2); font: 12px/1.4 monospace; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; display: flex; justify-content: space-between; gap: 8px;
}
#ublock0-epicker .epk-card:hover { filter: brightness(0.95); }
#ublock0-epicker .epk-card.active { border: 2px solid rgb(var(--blue-50)); background: var(--surface-3); }
#ublock0-epicker .epk-card .epk-card-meta { font-size: smaller; color: gray; flex-shrink: 0; }
#ublock0-epicker section { border: 0; box-sizing: border-box; display: inline-block; width: 100%; }
#ublock0-epicker section > div:first-child { border: 1px solid var(--surface-3); margin: 0; position: relative; border-radius: 3px; }
#ublock0-epicker section.invalidFilter > div:first-child { border-color: var(--error-surface); }
#ublock0-epicker .codeMirrorContainer { border: none; box-sizing: border-box; height: 4em; padding: 2px; width: 100%; }
#ublock0-epicker .codeMirrorContainer textarea {
  width: 100%; height: 100%; box-sizing: border-box; resize: none; border: none; background: transparent;
  color: var(--ink-1); font: 12px/1.4 monospace; padding: 2px;
}
#ublock0-epicker section .resultsetWidgets { display: flex; font-size: var(--font-size-smaller); align-items: flex-end; }
#ublock0-epicker #resultsetModifiers { align-items: flex-end; display: inline-flex; flex-grow: 1; justify-content: space-evenly; }
#ublock0-epicker #resultsetModifiers.hide > * { visibility: hidden; }
#ublock0-epicker .resultsetModifier { border: 0; pointer-events: auto; position: relative; width: 40%; }
#ublock0-epicker .resultsetModifier > span { align-items: flex-end; display: flex; height: 100%; pointer-events: none; width: 100%; }
#ublock0-epicker .resultsetModifier > span > span { margin: 2px 0; }
#ublock0-epicker .resultsetModifier > span > span:nth-of-type(1) {
  background-color: var(--checkbox-checked-ink); border-inline-end: 1px solid var(--surface-3);
  display: inline-block; flex-shrink: 0; height: 6px;
}
#ublock0-epicker .resultsetModifier > span > span:nth-of-type(2) {
  background-color: var(--checkbox-checked-ink);
  clip-path: polygon(calc(50% - 2px) 0%, 0% calc(100% - 6px), 0% 100%, 100% 100%, 100% calc(100% - 6px), calc(50% + 2px) 0%);
  display: inline-block; flex-shrink: 0; height: 20px; width: 20px;
}
#ublock0-epicker .resultsetModifier > span > span:nth-of-type(3) {
  background-color: var(--surface-3); border-inline-start: 1px solid var(--surface-3); display: inline-block; flex-grow: 1; height: 6px;
}
#ublock0-epicker .resultsetModifier input {
  border: 0; height: 100%; left: 0; margin: 0; opacity: 0; padding: 0; position: absolute; top: 0; width: 100%; cursor: pointer;
}
#ublock0-epicker #resultsetCount {
  align-items: center; background-color: var(--surface-3); color: var(--ink-1);
  display: inline-flex; justify-content: center; min-width: 2.2em; border-radius: 3px; padding: 2px 4px; margin-bottom: 2px;
}
#ublock0-epicker section.invalidFilter #resultsetCount { background-color: var(--error-surface); color: var(--ink-100); }
#ublock0-epicker #toolbar { display: flex; justify-content: space-between; margin-top: 6px; }
#ublock0-epicker #toolbar button { min-width: 5em; }
#ublock0-epicker button {
  align-items: center; appearance: none; border: 0; border-radius: var(--button-border-radius);
  background-color: var(--button-surface); color: var(--button-ink); display: inline-flex;
  font-size: max(calc(var(--font-size) * .875), 13px); justify-content: center; min-height: 32px;
  padding: 0 var(--font-size); position: relative; cursor: pointer; margin: 2px;
}
#ublock0-epicker button:hover { filter: brightness(0.95); }
#ublock0-epicker button.preferred { background-color: var(--button-preferred-surface); color: var(--button-preferred-ink); }
#ublock0-epicker button[disabled] { background-color: var(--button-disabled-surface); opacity: .5; pointer-events: none; }
#ublock0-epicker.preview #preview { background-color: var(--button-preferred-surface); color: var(--button-preferred-ink); }
#ublock0-epicker ul { margin: 4px 0 0 0; padding: 0; list-style-type: none; text-align: left; overflow: hidden; }

#ublock0-epicker #windowbar #theme-toggle { background: none; border: none; cursor: pointer; font-size: 14px; min-height: unset; padding: 2px 6px; margin: 0; flex-shrink: 0; }
#ublock0-epicker svg#sea { cursor: crosshair; box-sizing: border-box; height: 100%; left: 0; position: absolute; top: 0; width: 100%; pointer-events: none; }
#ublock0-epicker svg#sea > path:first-child { fill: rgba(0,0,0,0.5); fill-rule: evenodd; }
#ublock0-epicker svg#sea > path + path { stroke: #F00; stroke-width: 1px; fill: rgba(255,63,63,0.20); }
#ublock0-epicker.preview svg#sea > path { fill: rgba(0,0,0,0.10); }
#ublock0-epicker.preview svg#sea > path + path { stroke: none; fill: none; }
`;

  const styleTag = document.createElement('style');
  styleTag.textContent = CSS_TEXT;
  document.head.appendChild(styleTag);

  // ---- root markup, ported from epicker-ui.html ----
  const root = document.createElement('div');
  root.id = 'ublock0-epicker';
  root.lang = 'en';
  root.dir = 'ltr';
  root.translate = false;
  root.setAttribute('translate', 'no');
  root.classList.add('notranslate');
  if (state.theme === 'dark') root.classList.add('dark');
  root.innerHTML = `
<aside style="right:2px;bottom:2px;">
  <div id="windowbar">
    <div id="minimize" title="Minimize"><svg viewBox="0 0 64 64"><path d="M 16,48 H 48"/><rect x="16" y="16" height="32" width="32"/></svg></div>
    <div id="move"></div>
    <button id="theme-toggle" title="Toggle dark mode">${state.theme === 'dark' ? '\u2600\ufe0f' : '\ud83c\udf19'}</button>
    <div id="quit" title="Quit"><svg viewBox="0 0 64 64"><path d="M16 16L48 48M16 48L48 16"/></svg></div>
  </div>
  <section>
    <div>
      <div class="codeMirrorContainer"><textarea id="epk-filter-text" spellcheck="false"></textarea></div>
      <div class="resultsetWidgets">
        <span id="resultsetModifiers" class="hide">
          <span id="resultsetDepth" class="resultsetModifier">
            <span><span></span><span></span><span></span></span>
            <input type="range" min="0" max="0" value="0">
          </span>
          <span id="resultsetSpecificity" class="resultsetModifier">
            <span><span></span><span></span><span></span></span>
            <input type="range" min="0" max="0" value="0">
          </span>
        </span>
        <span id="resultsetCount"></span>
      </div>
    </div>
    <div id="toolbar">
      <div>
        <button id="pick" type="button">Pick</button>
        <button id="preview" type="button">Preview</button>
      </div>
      <button id="create" type="button" class="preferred">Create</button>
    </div>
  </section>
  <div class="epk-section-title">Elements at this point</div>
  <div id="epk-chain-list" class="epk-card-list"></div>
  <div class="epk-section-title">Cosmetic filters</div>
  <div id="epk-cand-list" class="epk-card-list"></div>
</aside>
<svg id="sea"><path d=""></path><path d=""></path></svg>
`;
  document.body.appendChild(root);
  state.root = root;

  // Force the aside to stay fully within the current viewport on spawn
  (function clampInitialPosition() {
    const asideEl = root.querySelector('aside');
    requestAnimationFrame(() => {
      const r = asideEl.getBoundingClientRect();
      if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) {
        asideEl.style.right = 'auto';
        asideEl.style.bottom = 'auto';
        asideEl.style.left = Math.max(0, innerWidth - r.width - 2) + 'px';
        asideEl.style.top = Math.max(0, innerHeight - r.height - 2) + 'px';
      }
    });
  })();

  const aside = root.querySelector('aside');
  const filterBox = root.querySelector('#epk-filter-text');
  const seaPaths = root.querySelectorAll('#sea path');
  const section = root.querySelector('section');
  const createBtn = root.querySelector('#create');
  const countEl = root.querySelector('#resultsetCount');

  // ---- sea (spotlight) — carves a hole for EVERY element that matches the
  // current filter (not just the one you clicked), and never dims/highlights
  // the area behind the expanded panel so highlights don't fight the UI ----
  function updateSea() {
    const vw = innerWidth, vh = innerHeight;
    let clipBottom = vh;
    if (aside.classList.contains('expanded')) {
      clipBottom = aside.getBoundingClientRect().top;
    }
    if (clipBottom <= 0) {
      seaPaths[0].setAttribute('d', '');
      seaPaths[1].setAttribute('d', '');
      return;
    }

    let matches = [];
    const sel = selectorFromText(filterBox.value);
    if (sel) {
      try { matches = Array.from(document.querySelectorAll(sel)); } catch (e) { matches = []; }
    }
    if (matches.length === 0 && state.current) matches = [state.current];

    if (matches.length === 0) {
      seaPaths[0].setAttribute('d', '');
      seaPaths[1].setAttribute('d', '');
      return;
    }

    let holes = '';
    matches.forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const top = Math.max(r.top, 0);
      const bottom = Math.min(r.top + r.height, clipBottom);
      if (bottom <= top) return;
      holes += ` M${r.left},${top} V${bottom} H${r.left + r.width} V${top} Z`;
    });
    const outer = `M0,0 H${vw} V${clipBottom} H0 Z`;
    seaPaths[0].setAttribute('d', outer + holes);
    seaPaths[1].setAttribute('d', holes);
  }

  // ---- real Preview: hide matched elements, mirrors filterToDOMInterface.preview() ----
  function startPreview(sel) {
    let matches;
    try { matches = document.querySelectorAll(sel); } catch (e) { matches = []; }
    state.previewHidden = matches.length
      ? Array.from(matches).map(el => ({ el, prev: el.style.getPropertyValue('display'), prio: el.style.getPropertyPriority('display') }))
      : [];
    state.previewHidden.forEach(o => o.el.style.setProperty('display', 'none', 'important'));
    state.previewing = true;
    root.classList.add('preview');
    document.addEventListener('click', endPreviewOnClick, true);
  }
  function endPreview() {
    state.previewHidden.forEach(o => {
      if (o.prev) o.el.style.setProperty('display', o.prev, o.prio);
      else o.el.style.removeProperty('display');
    });
    state.previewHidden = [];
    state.previewing = false;
    root.classList.remove('preview');
    document.removeEventListener('click', endPreviewOnClick, true);
    updateSea();
  }
  function endPreviewOnClick(e) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    endPreview();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // ---- renderRange, ported verbatim ----
  function renderRange(id, value, invert) {
    const wrap = root.querySelector('#' + id);
    const input = wrap.querySelector('input');
    const max = parseInt(input.max, 10);
    if (typeof value !== 'number') value = parseInt(input.value, 10);
    if (invert) value = max - value;
    input.value = value;
    const slider = wrap.querySelector('span');
    const lside = slider.children[0];
    const thumb = slider.children[1];
    const sliderWidth = slider.offsetWidth || 100;
    const thumbWidth = thumb.offsetWidth || 20;
    const maxPercent = (sliderWidth - thumbWidth) / sliderWidth * 100;
    const widthPercent = max > 0 ? (value / max * maxPercent) : 0;
    lside.style.width = widthPercent + '%';
  }

  function currentCandidates() { return candidatesForSlot(state.slot); }
  function currentSelectorObj() {
    const c = currentCandidates();
    return c[state.specIndex] || c[0] || { selector: '', count: 0 };
  }
  function nameFor(filterStr) { return (filterStr || '').replace(/^##/, ''); }

  function renderCandidateList() {
    const list = root.querySelector('#epk-cand-list');
    list.innerHTML = '';
    const cands = currentCandidates();
    cands.forEach((c, i) => {
      const card = document.createElement('div');
      card.className = 'epk-card' + (i === state.specIndex ? ' active' : '');
      const s1 = document.createElement('span');
      s1.textContent = c.selector;
      s1.style.overflow = 'hidden';
      s1.style.textOverflow = 'ellipsis';
      const s2 = document.createElement('span');
      s2.className = 'epk-card-meta';
      s2.textContent = c.count + (c.count === 1 ? ' elem' : ' elems');
      card.appendChild(s1);
      card.appendChild(s2);
      card.addEventListener('click', () => {
        state.specIndex = i;
        renderRange('resultsetSpecificity', i, false);
        applyCandidateToBox();
        renderCandidateList();
      });
      list.appendChild(card);
    });
  }

  // Every element in the clicked chain, top = the element you tapped,
  // bottom = the outermost ancestor that holds the whole page.
  function renderChainList() {
    const list = root.querySelector('#epk-chain-list');
    list.innerHTML = '';
    state.filters.forEach((f, i) => {
      const card = document.createElement('div');
      card.className = 'epk-card' + (i === state.slot ? ' active' : '');
      const s1 = document.createElement('span');
      s1.textContent = nameFor(f);
      s1.style.overflow = 'hidden';
      s1.style.textOverflow = 'ellipsis';
      const s2 = document.createElement('span');
      s2.className = 'epk-card-meta';
      s2.textContent = i === 0 ? 'clicked' : (i === state.filters.length - 1 ? 'page root' : 'ancestor');
      card.appendChild(s1);
      card.appendChild(s2);
      card.addEventListener('click', () => setSlot(i));
      list.appendChild(card);
    });
  }

  function applyCandidateToBox() {
    filterBox.value = currentSelectorObj().selector;
    onFilterTextChanged();
  }

  function onFilterTextChanged() {
    const text = filterBox.value.trim();
    const sel = selectorFromText(text);
    let n = 0, bad = false;
    if (sel) {
      try { n = document.querySelectorAll(sel).length; } catch (e) { bad = true; }
    } else bad = true;
    section.classList.toggle('invalidFilter', bad || n === 0);
    countEl.textContent = bad ? 'E' : String(n);
    createBtn.toggleAttribute('disabled', bad || n === 0);
    if (!bad && !state.previewing) updateSea();
  }

  function setSlot(slot) {
    state.slot = Math.max(0, Math.min(state.filters.length - 1, slot));
    const cands = candidatesForSlot(state.slot);
    // Default to the broadest match (index 0) so same-class siblings
    // highlight automatically, without needing to touch the slider.
    state.specIndex = 0;
    root.querySelector('#resultsetDepth input').max = String(Math.max(0, state.filters.length - 1));
    renderRange('resultsetDepth', state.slot, true);
    root.querySelector('#resultsetSpecificity input').max = String(Math.max(0, cands.length - 1));
    renderRange('resultsetSpecificity', state.specIndex, false);
    root.querySelector('#resultsetModifiers').classList.remove('hide');
    applyCandidateToBox();
    renderCandidateList();
    renderChainList();
    updateSea();
  }

  function select(el) {
    if (state.previewing) endPreview();
    state.current = el;
    const built = filtersFrom(el);
    state.filters = built.filters;
    state.elements = built.elements;
    state.candidatesCache = new Map();
    setSlot(0);
    setExpanded(true); // auto-expand once something is actually picked
  }

  // ---- compact (small windowbar-only bar) vs expanded (full dialog) ----
  function resetPosition() {
    aside.style.left = '';
    aside.style.right = '';
    aside.style.top = '';
    aside.style.bottom = '';
  }
  function setExpanded(expanded) {
    state.expanded = expanded;
    resetPosition(); // always start each mode fresh — a leftover position
                      // from the other mode is what caused the sheet to
                      // render off-screen / highlighting to clip too early
    aside.classList.toggle('expanded', expanded);
    aside.classList.toggle('compact', !expanded);
    updateSea();
  }
  setExpanded(false); // start compact: just the pick/move/quit bar

  // ---- wiring ----
  root.querySelector('#quit').addEventListener('click', disable);
  root.querySelector('#minimize').addEventListener('click', () => setExpanded(!state.expanded));
  root.querySelector('#pick').addEventListener('click', () => {
    if (state.previewing) endPreview();
    state.current = null;
    root.querySelector('#resultsetModifiers').classList.add('hide');
    filterBox.value = '';
    countEl.textContent = '';
    section.classList.remove('invalidFilter');
    root.querySelector('#epk-cand-list').innerHTML = '';
    root.querySelector('#epk-chain-list').innerHTML = '';
    setExpanded(false); // drop to compact bar so the page is tappable again
  });
  root.querySelector('#preview').addEventListener('click', () => {
    if (state.previewing) { endPreview(); return; }
    const sel = selectorFromText(filterBox.value);
    if (sel) startPreview(sel);
  });
  root.querySelector('#create').addEventListener('click', (e) => {
    const sel = selectorFromText(filterBox.value);
    if (!sel) return;
    copyText(location.hostname + '##' + sel);
    const btn = e.currentTarget;
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = old; }, 1200);
  });
  root.querySelector('#theme-toggle').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('epk-theme', state.theme);
    root.classList.toggle('dark', state.theme === 'dark');
    root.querySelector('#theme-toggle').textContent = state.theme === 'dark' ? '\u2600\ufe0f' : '\ud83c\udf19';
  });

  filterBox.addEventListener('input', onFilterTextChanged);

  root.querySelector('#resultsetDepth input').addEventListener('input', (e) => {
    const max = parseInt(e.target.max, 10);
    const raw = parseInt(e.target.value, 10);
    setSlot(max - raw);
  });
  root.querySelector('#resultsetSpecificity input').addEventListener('input', (e) => {
    state.specIndex = parseInt(e.target.value, 10);
    renderRange('resultsetSpecificity', state.specIndex, false);
    applyCandidateToBox();
    renderCandidateList();
  });

  // ---- drag (#move), mirrors aside.moving behavior ----
  (function setupDrag() {
    const handle = root.querySelector('#move');
    let startX, startY, startLeft, startTop;
    function pointFrom(e) {
      return e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
    }
    function onDown(e) {
      const p = pointFrom(e);
      const rect = aside.getBoundingClientRect();
      startX = p.x; startY = p.y; startLeft = rect.left; startTop = rect.top;
      if (state.expanded) {
        aside.style.bottom = 'auto'; // let top-based dragging take over from docked-bottom
      } else {
        aside.style.right = 'auto'; aside.style.bottom = 'auto';
      }
      aside.classList.add('moving');
      state.dragging = true;
      document.addEventListener('mousemove', onMoveDrag, true);
      document.addEventListener('touchmove', onMoveDrag, true);
      document.addEventListener('mouseup', onUp, true);
      document.addEventListener('touchend', onUp, true);
      e.preventDefault(); e.stopPropagation();
    }
    function onMoveDrag(e) {
      const p = pointFrom(e);
      const h = aside.offsetHeight;
      const maxTop = Math.max(0, innerHeight - h);
      const top = Math.min(maxTop, Math.max(0, startTop + (p.y - startY)));
      aside.style.top = top + 'px';
      if (!state.expanded) {
        const w = aside.offsetWidth;
        const maxLeft = Math.max(0, innerWidth - w);
        const left = Math.min(maxLeft, Math.max(0, startLeft + (p.x - startX)));
        aside.style.left = left + 'px';
      }
      updateSea(); // live-update the highlight clip as the sheet moves
      e.preventDefault();
    }
    function onUp() {
      state.dragging = false;
      aside.classList.remove('moving');
      document.removeEventListener('mousemove', onMoveDrag, true);
      document.removeEventListener('touchmove', onMoveDrag, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('touchend', onUp, true);
    }
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
  })();

  state.handler = function (e) {
    if (root.contains(e.target)) return;
    if (state.dragging || state.previewing) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    select(e.target);
    return false;
  };
  document.addEventListener('click', state.handler, true);

  state.scrollHandler = function () { updateSea(); };
  window.addEventListener('scroll', state.scrollHandler, true);
  window.addEventListener('resize', state.scrollHandler, true);

  function disable() {
    if (state.previewing) endPreview();
    document.removeEventListener('click', state.handler, true);
    window.removeEventListener('scroll', state.scrollHandler, true);
    window.removeEventListener('resize', state.scrollHandler, true);
    root.remove();
    styleTag.remove();
    delete window.__epicker;
  }
  state.disable = disable;
})();
