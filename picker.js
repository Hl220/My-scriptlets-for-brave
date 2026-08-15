/*
  Standalone Element Picker (inspired by uBlock Origin's element picker)
  No hiding/zapping — pure selector inspection tool, with a uBO-style
  specificity slider and spotlight highlight.
*/
(function () {
  if (window.__epicker) {
    window.__epicker.disable();
    return;
  }

  const state = {
    current: null,
    stack: [],
    panel: null,
    handler: null,
    scrollHandler: null,
    highlighted: [],
    candidates: [],
    sliderIndex: 0,
  };
  window.__epicker = state;

  // ---------- selector helpers ----------

  function classSelector(el) {
    if (!el.classList.length) return '';
    return '.' + Array.from(el.classList).map(c => CSS.escape(c)).join('.');
  }

  function fullPath(el) {
    const parts = [];
    let node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let seg = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  function nearestIdAncestor(el) {
    let node = el.parentElement, depth = 0;
    while (node && depth < 6) {
      if (node.id) return node;
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  function elementName(el) {
    if (!el) return '';
    let name = el.tagName.toLowerCase();
    if (el.id) name += '#' + el.id;
    else if (el.classList.length) name += '.' + Array.from(el.classList).slice(0, 2).join('.');
    return name;
  }

  function rawCandidates(el) {
    const list = [];
    const tag = el.tagName.toLowerCase();
    const cls = classSelector(el);

    if (el.id) list.push('#' + CSS.escape(el.id));
    if (cls) {
      list.push(tag + cls);
      list.push(cls);
    }
    const anc = nearestIdAncestor(el);
    if (anc) list.push('#' + CSS.escape(anc.id) + ' ' + tag + cls);
    list.push(tag);
    list.push(fullPath(el));

    return Array.from(new Set(list.filter(Boolean)));
  }

  // Build candidates ordered from narrowest (fewest matches) to broadest
  // (most matches) — this is what the slider scrubs through, uBO-style.
  function buildCandidates(el) {
    const raw = rawCandidates(el);
    const scored = raw.map(sel => {
      let count = 0;
      try { count = document.querySelectorAll(sel).length; } catch (e) { count = Infinity; }
      return { value: sel, count };
    }).filter(c => c.count > 0);
    scored.sort((a, b) => a.count - b.count || a.value.length - b.value.length);
    return scored;
  }

  // ---------- highlight ----------

  function clearMatchHighlights() {
    state.highlighted.forEach(el => {
      el.style.outline = el.__epickerOldOutline || '';
      el.style.outlineOffset = '';
      el.style.background = el.__epickerOldBg || '';
    });
    state.highlighted = [];
  }

  function applyMatchHighlights(sel, excludeEl) {
    clearMatchHighlights();
    let matches;
    try { matches = document.querySelectorAll(sel); } catch (e) { return 0; }
    matches.forEach(el => {
      if (el === excludeEl) return;
      el.__epickerOldOutline = el.style.outline;
      el.__epickerOldBg = el.style.background;
      el.style.outline = '2px dashed #f5a623';
      el.style.outlineOffset = '-2px';
    });
    state.highlighted = Array.from(matches).filter(el => el !== excludeEl);
    return matches.length;
  }

  // spotlight box + name label for the actively picked element
  const spotlight = document.createElement('div');
  spotlight.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;' +
    'border:2px solid #e6432c;border-radius:2px;' +
    'box-shadow:0 0 0 9999px rgba(0,0,0,.45);' +
    'transition:all 120ms ease;display:none;box-sizing:border-box;';
  document.documentElement.appendChild(spotlight);

  const nameLabel = document.createElement('div');
  nameLabel.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;' +
    'background:#e6432c;color:#fff;font:12px/1.4 monospace;' +
    'padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;';
  document.documentElement.appendChild(nameLabel);

  function positionSpotlight() {
    const el = state.current;
    if (!el) { spotlight.style.display = 'none'; nameLabel.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    spotlight.style.display = 'block';
    spotlight.style.left = r.left + 'px';
    spotlight.style.top = r.top + 'px';
    spotlight.style.width = r.width + 'px';
    spotlight.style.height = r.height + 'px';

    nameLabel.style.display = 'block';
    nameLabel.textContent = elementName(el);
    const above = r.top > 22;
    nameLabel.style.left = Math.max(0, r.left) + 'px';
    nameLabel.style.top = (above ? r.top - 20 : r.bottom + 2) + 'px';
  }

  // ---------- clipboard ----------

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
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

  // ---------- panel ----------

  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:2147483647;background:#fff;' +
    'border:1px solid #ddd;border-radius:10px;padding:12px;box-shadow:0 4px 20px rgba(0,0,0,.2);' +
    'width:280px;max-height:80vh;overflow-y:auto;font-family:sans-serif;color:#222;font-size:13px;';
  document.body.appendChild(panel);
  state.panel = panel;

  function currentSelector() {
    const c = state.candidates[state.sliderIndex];
    return c ? c.value : '';
  }

  function applySliderPreview() {
    const sel = currentSelector();
    if (!sel) return;
    const count = applyMatchHighlights(sel, state.current);
    const disp = panel.querySelector('#epk-sel-text');
    const cnt = panel.querySelector('#epk-count');
    if (disp) disp.textContent = sel;
    if (cnt) cnt.textContent = (count) + ' element' + (count === 1 ? '' : 's') + ' match this selector';
  }

  function render() {
    const el = state.current;
    let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<strong style="font-size:14px;">Element Picker</strong>' +
      '<button id="epk-close" style="background:none;border:none;font-size:16px;cursor:pointer;color:#888;">\u2715</button></div>';

    if (!el) {
      html += '<p style="color:#888;text-align:center;padding:12px 0;">Tap an element on the page to inspect it</p>';
      panel.innerHTML = html;
      panel.querySelector('#epk-close').addEventListener('click', disable);
      return;
    }

    html += '<div style="background:#f7f7f7;border-radius:6px;padding:8px;margin-bottom:8px;">' +
      '<div style="font-family:monospace;font-weight:600;">' + elementName(el) + '</div>' +
      '</div>';

    html += '<div style="display:flex;gap:6px;margin-bottom:10px;">' +
      '<button id="epk-up" style="flex:1;padding:6px;background:#eee;border:none;border-radius:6px;cursor:pointer;">\u2191 Parent</button>' +
      '<button id="epk-down" style="flex:1;padding:6px;background:#eee;border:none;border-radius:6px;cursor:pointer;" ' +
      (state.stack.length ? '' : 'disabled') + '>\u2193 Child</button></div>';

    html += '<div style="font-weight:600;margin-bottom:2px;">Specificity</div>' +
      '<div style="font-size:11px;color:#888;margin-bottom:4px;">Narrow \u2190\u2192 Broad</div>' +
      '<input id="epk-slider" type="range" min="0" max="' + Math.max(0, state.candidates.length - 1) + '" ' +
      'value="' + state.sliderIndex + '" style="width:100%;margin-bottom:6px;">' +
      '<div id="epk-sel-text" style="font-family:monospace;font-size:12px;background:#111;color:#0f0;' +
      'padding:6px;border-radius:6px;overflow-x:auto;white-space:nowrap;margin-bottom:4px;"></div>' +
      '<div id="epk-count" style="font-size:11px;color:#666;margin-bottom:8px;"></div>' +
      '<button id="epk-copy" style="width:100%;padding:8px;background:#e6432c;color:#fff;border:none;' +
      'border-radius:6px;cursor:pointer;font-size:13px;">Copy Selector</button>';

    panel.innerHTML = html;
    panel.querySelector('#epk-close').addEventListener('click', disable);
    panel.querySelector('#epk-up').addEventListener('click', goUp);
    const downBtn = panel.querySelector('#epk-down');
    if (!downBtn.disabled) downBtn.addEventListener('click', goDown);

    const slider = panel.querySelector('#epk-slider');
    slider.addEventListener('input', () => {
      state.sliderIndex = +slider.value;
      applySliderPreview();
    });

    panel.querySelector('#epk-copy').addEventListener('click', (e) => {
      copyText(currentSelector());
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = 'Copy Selector'; }, 1200);
    });

    applySliderPreview();
  }

  function select(el) {
    clearMatchHighlights();
    state.current = el;
    state.stack = [];
    state.candidates = buildCandidates(el);
    state.sliderIndex = 0;
    positionSpotlight();
    render();
  }

  function goUp() {
    if (!state.current || !state.current.parentElement) return;
    state.stack.push(state.current);
    state.current = state.current.parentElement;
    clearMatchHighlights();
    state.candidates = buildCandidates(state.current);
    state.sliderIndex = 0;
    positionSpotlight();
    render();
  }

  function goDown() {
    if (!state.stack.length) return;
    state.current = state.stack.pop();
    clearMatchHighlights();
    state.candidates = buildCandidates(state.current);
    state.sliderIndex = 0;
    positionSpotlight();
    render();
  }

  // ---------- pick clicks on the page ----------

  state.handler = function (e) {
    if (panel.contains(e.target)) return;
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
