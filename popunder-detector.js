/**
 * Popunder Ad Detector & Filter Rule Generator
 * ---------------------------------------------
 * Two complementary detection modes:
 *
 *  LIVE  - hooks window.open / blur / anchor.click to catch popunders
 *          as they fire. Misses anything that initialized before the
 *          bookmarklet ran (very common - see README notes below).
 *
 *  SCAN  - inspects the page as it currently sits: known ad-network
 *          <script> tags, and full-viewport invisible overlay elements
 *          (the actual mechanism behind most "click anywhere" popunder
 *          hijacks). Not timing-dependent, so it catches what LIVE
 *          misses on an already-loaded page.
 *
 * Click the bookmarklet once per page to activate. Click again to
 * toggle the panel open/closed (does not re-hook or re-scan).
 */
(function () {
  'use strict';

  if (window.__popunderDetector) {
    window.__popunderDetector.togglePanel();
    return;
  }

  // =========================================================
  // CONFIG - tweak these
  // =========================================================
  const CONFIG = {
    BLOCK_BY_DEFAULT: true,          // stop window.open popups from actually opening
    DEDUPE: true,                    // collapse repeat hits into a counter
    PANEL_POSITION: 'bottom-right',  // 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
    MAX_LOG: 200,                    // cap on stored detections
    AUTOSCAN_ON_ACTIVATE: true,      // run a static scan immediately on activation
    OVERLAY_MIN_COVERAGE: 0.85,      // fraction of viewport an element must cover to count as "full screen"
    OVERLAY_MAX_OPACITY: 0.15,       // opacity ceiling to count as "invisible"
  };

  // Best-effort, NOT exhaustive - these networks rotate domains constantly.
  const KNOWN_AD_DOMAINS = [
    'popads.net', 'popcash.net', 'propellerads.com', 'propellerclick.com',
    'adcash.com', 'exoclick.com', 'juicyads.com', 'clickadu.com',
    'adsterra.com', 'hilltopads.net', 'evadav.com', 'richads.com',
    'trafficjunky.com', 'smartyads.com', 'clickaine.com', 'mgid.com',
    'popmyads.com', 'adnium.com', 'onclickmega.com', 'adskeeper.co.uk',
  ];

  const state = { detections: [], blocking: CONFIG.BLOCK_BY_DEFAULT, panelOpen: true };

  // =========================================================
  // Generic helpers
  // =========================================================
  function domainFromUrl(url) {
    if (!url) return null;
    try { return new URL(url, location.href).hostname; }
    catch (e) { return null; }
  }

  function callerDomainFromStack(stack) {
    if (!stack) return null;
    for (const line of stack.split('\n')) {
      const m = line.match(/(https?:\/\/[^\s()]+):\d+:\d+/);
      if (m && !m[1].includes('popunder-detector')) return domainFromUrl(m[1]);
    }
    return null;
  }

  function cssSelectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (typeof el.className === 'string' && el.className.trim()) {
      return el.tagName.toLowerCase() + '.' + CSS.escape(el.className.trim().split(/\s+/)[0]);
    }
    let sel = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      sel += `:nth-of-type(${sibs.indexOf(el) + 1})`;
    }
    return sel;
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
    document.body.removeChild(ta);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // =========================================================
  // Detection store
  // =========================================================
  function addDetection(entry) {
    // entry: { source: 'live'|'scan', type, label, meta, rules: [], el? }
    if (CONFIG.DEDUPE) {
      const key = entry.source + '::' + entry.type + '::' + entry.label;
      const existing = state.detections.find(d => d._key === key);
      if (existing) {
        existing.count++;
        existing.time = new Date().toLocaleTimeString();
        renderPanel();
        return;
      }
      entry._key = key;
    }
    entry.count = 1;
    entry.time = new Date().toLocaleTimeString();
    state.detections.unshift(entry);
    if (state.detections.length > CONFIG.MAX_LOG) state.detections.length = CONFIG.MAX_LOG;
    renderPanel();
    updateBadge();
  }

  // =========================================================
  // LIVE mode - hook 1: window.open (primary vector when it fires in time)
  // =========================================================
  let lastOpenTime = 0;
  const nativeOpen = window.open;
  window.open = function (url, name, specs) {
    lastOpenTime = Date.now();
    const targetDomain = domainFromUrl(url) || (url === undefined ? 'about:blank' : String(url));
    const callerDomain = callerDomainFromStack(new Error().stack);
    const rules = [];
    if (domainFromUrl(url)) rules.push(`||${domainFromUrl(url)}^$popup`);
    if (callerDomain && callerDomain !== location.hostname) rules.push(`||${callerDomain}^`);
    if (rules.length === 0) rules.push('! could not resolve a domain for this hit');
    addDetection({ source: 'live', type: 'window.open', label: targetDomain, meta: `caller: ${callerDomain || 'unknown'}`, rules });
    if (state.blocking) { console.warn('[Popunder Detector] blocked window.open ->', url); return null; }
    return nativeOpen.apply(window, arguments);
  };

  // LIVE mode - hook 2: blur right after an open (push-under)
  const nativeBlur = window.blur;
  window.blur = function () {
    if (Date.now() - lastOpenTime < 500) {
      const callerDomain = callerDomainFromStack(new Error().stack);
      addDetection({
        source: 'live', type: 'push-under (blur)', label: location.hostname,
        meta: `caller: ${callerDomain || 'unknown'}`,
        rules: callerDomain ? [`||${callerDomain}^`] : ['! could not resolve a domain for this hit'],
      });
    }
    return nativeBlur.apply(window, arguments);
  };

  // LIVE mode - hook 3: synthetic click on a hidden target=_blank anchor
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.target === '_blank' && this.href) {
      const rect = this.getBoundingClientRect();
      const hidden = rect.width === 0 || rect.height === 0 || getComputedStyle(this).display === 'none';
      if (hidden) {
        const callerDomain = callerDomainFromStack(new Error().stack);
        const targetDomain = domainFromUrl(this.href);
        addDetection({
          source: 'live', type: 'synthetic anchor click', label: targetDomain || this.href,
          meta: `caller: ${callerDomain || 'unknown'}`,
          rules: targetDomain ? [`||${targetDomain}^$popup`] : ['! could not resolve a domain for this hit'],
        });
      }
    }
    return nativeAnchorClick.apply(this, arguments);
  };

  // =========================================================
  // SCAN mode - inspects the page as it currently sits, no timing dependency
  // =========================================================
  function scanScripts() {
    document.querySelectorAll('script[src]').forEach(s => {
      const d = domainFromUrl(s.src);
      if (d && KNOWN_AD_DOMAINS.some(k => d === k || d.endsWith('.' + k))) {
        addDetection({
          source: 'scan', type: 'known ad-network script', label: d,
          meta: 'matched curated domain list - see KNOWN_AD_DOMAINS',
          rules: [`||${d}^$popup`, `||${d}^`],
        });
      }
    });
    document.querySelectorAll('script:not([src])').forEach(s => {
      const text = s.textContent || '';
      if (/atob\(/.test(text) && /(eval\(|document\.write\()/.test(text)) {
        addDetection({
          source: 'scan', type: 'obfuscated inline script', label: location.hostname,
          meta: 'atob() + eval()/document.write() pattern - manual review recommended',
          rules: ['! obfuscated inline script - inspect manually, no safe auto-rule'],
        });
      }
    });
  }

  function scanOverlays() {
    const vw = window.innerWidth, vh = window.innerHeight;
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.pointerEvents === 'none') return;
      if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
      const rect = el.getBoundingClientRect();
      const coversViewport = rect.width >= vw * CONFIG.OVERLAY_MIN_COVERAGE && rect.height >= vh * CONFIG.OVERLAY_MIN_COVERAGE;
      if (!coversViewport) return;
      const opacity = parseFloat(cs.opacity);
      const invisible = cs.visibility !== 'hidden' && opacity <= CONFIG.OVERLAY_MAX_OPACITY;
      const z = parseInt(cs.zIndex, 10) || 0;
      if (!invisible && z <= 1000) return;

      el.style.setProperty('outline', '3px dashed red', 'important');
      el.style.setProperty('background', 'rgba(255,0,0,0.15)', 'important');

      const selector = cssSelectorFor(el);
      addDetection({
        source: 'scan', type: 'hidden overlay', label: selector,
        meta: `${cs.position}, opacity ${cs.opacity}, z-index ${cs.zIndex || 'auto'} - outlined red on page`,
        rules: [`${location.hostname}##${selector}`],
        el,
      });
    });
  }

  function scanPage() {
    scanScripts();
    scanOverlays();
    flashBadgeText('scan done');
  }

  // =========================================================
  // Panel UI - Shadow DOM isolated
  // =========================================================
  const host = document.createElement('div');
  host.id = 'popunder-detector-host';
  host.style.cssText = `all:initial; position:fixed; z-index:2147483647; ${positionCSS()}`;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });

  function positionCSS() {
    switch (CONFIG.PANEL_POSITION) {
      case 'bottom-left': return 'left:12px; bottom:12px;';
      case 'top-right': return 'right:12px; top:12px;';
      case 'top-left': return 'left:12px; top:12px;';
      default: return 'right:12px; bottom:12px;';
    }
  }

  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: -apple-system, Roboto, sans-serif; }
      .badge { width:52px; height:52px; border-radius:50%; background:#1a1a2e; color:#0ef;
        border:2px solid #0ef; display:flex; align-items:center; justify-content:center;
        font-size:14px; font-weight:bold; box-shadow:0 2px 10px rgba(0,0,0,.4); cursor:pointer; text-align:center; }
      .panel { display:none; width:min(360px, 90vw); max-height:70vh; overflow-y:auto;
        background:#14141f; color:#e6e6f0; border:1px solid #333; border-radius:10px;
        margin-bottom:8px; font-size:13px; box-shadow:0 4px 20px rgba(0,0,0,.5); }
      .panel.open { display:block; }
      .hdr { padding:10px 12px; display:flex; justify-content:space-between; align-items:center;
        border-bottom:1px solid #2a2a3a; position:sticky; top:0; background:#14141f; }
      .hdr b { color:#0ef; }
      .btn { background:#22223a; color:#e6e6f0; border:1px solid #3a3a55; border-radius:6px;
        padding:6px 10px; font-size:12px; cursor:pointer; }
      .btn:active { background:#33335a; }
      .row { padding:10px 12px; border-bottom:1px solid #22222f; }
      .tag { display:inline-block; font-size:10px; font-weight:700; padding:1px 6px; border-radius:4px; margin-right:6px; }
      .tag.live { background:#3a1f1f; color:#ff8080; }
      .tag.scan { background:#1f2f3a; color:#7fd1ff; }
      .dom { color:#ff6b6b; font-weight:600; word-break:break-all; }
      .meta { color:#888; font-size:11px; margin:2px 0 6px; }
      .rule { background:#0a0a12; border:1px solid #2a2a3a; border-radius:6px; padding:6px 8px;
        font-family:monospace; font-size:11.5px; margin:4px 0; word-break:break-all; }
      .empty { padding:16px 12px; color:#888; text-align:center; }
      .rowbtns { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
      .footer { padding:8px 12px; display:flex; gap:6px; flex-wrap:wrap; border-top:1px solid #2a2a3a;
        position:sticky; bottom:0; background:#14141f; }
      .toggle { display:flex; align-items:center; gap:6px; font-size:12px; }
    </style>
    <div class="panel" id="panel">
      <div class="hdr"><span><b>Popunder Detector</b></span><button class="btn" id="closeBtn">Close</button></div>
      <div id="list"><div class="empty">Scanning page...</div></div>
      <div class="footer">
        <button class="btn" id="scanBtn">Scan page</button>
        <button class="btn" id="copyAllBtn">Copy all rules</button>
        <label class="toggle"><input type="checkbox" id="blockToggle" checked> Block live</label>
        <button class="btn" id="deactivateBtn">Deactivate</button>
      </div>
    </div>
    <div class="badge" id="badge">0</div>
  `;

  const $panel = shadow.getElementById('panel');
  const $list = shadow.getElementById('list');
  const $badge = shadow.getElementById('badge');

  shadow.getElementById('badge').addEventListener('click', togglePanel);
  shadow.getElementById('closeBtn').addEventListener('click', togglePanel);
  shadow.getElementById('scanBtn').addEventListener('click', scanPage);
  shadow.getElementById('copyAllBtn').addEventListener('click', () => {
    const all = state.detections.flatMap(d => d.rules);
    copyText([...new Set(all)].join('\n'));
    flashBadgeText('copied');
  });
  shadow.getElementById('deactivateBtn').addEventListener('click', deactivate);
  shadow.getElementById('blockToggle').addEventListener('change', e => { state.blocking = e.target.checked; });

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    $panel.classList.toggle('open', state.panelOpen);
  }
  function updateBadge() { $badge.textContent = String(state.detections.length); }
  function flashBadgeText(txt) {
    const old = $badge.textContent;
    $badge.textContent = txt;
    setTimeout(() => $badge.textContent = old, 900);
  }

  function renderPanel() {
    if (state.detections.length === 0) {
      $list.innerHTML = '<div class="empty">Nothing caught yet. Try "Scan page", or click around normally.</div>';
      return;
    }
    $list.innerHTML = state.detections.map((d, i) => `
      <div class="row">
        <span class="tag ${d.source}">${d.source.toUpperCase()}</span>
        <div class="dom">${escapeHtml(d.label)}${d.count > 1 ? ` ×${d.count}` : ''}</div>
        <div class="meta">${escapeHtml(d.type)} · ${escapeHtml(d.meta || '')} · ${d.time}</div>
        ${d.rules.map(r => `<div class="rule">${escapeHtml(r)}</div>`).join('')}
        <div class="rowbtns">
          <button class="btn copy-one" data-i="${i}">Copy rule</button>
          ${d.el ? `<button class="btn hide-one" data-i="${i}">Hide now</button>` : ''}
        </div>
      </div>
    `).join('');
    shadow.querySelectorAll('.copy-one').forEach(btn => {
      btn.addEventListener('click', () => {
        copyText(state.detections[+btn.dataset.i].rules.join('\n'));
        btn.textContent = 'Copied'; setTimeout(() => btn.textContent = 'Copy rule', 1000);
      });
    });
    shadow.querySelectorAll('.hide-one').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = state.detections[+btn.dataset.i];
        if (d.el) d.el.style.setProperty('display', 'none', 'important');
        btn.textContent = 'Hidden'; btn.disabled = true;
      });
    });
  }

  function deactivate() {
    window.open = nativeOpen;
    window.blur = nativeBlur;
    HTMLAnchorElement.prototype.click = nativeAnchorClick;
    host.remove();
    delete window.__popunderDetector;
    console.info('[Popunder Detector] deactivated, native functions restored.');
  }

  window.__popunderDetector = { togglePanel, deactivate, scanPage, state };

  renderPanel();
  updateBadge();
  if (CONFIG.AUTOSCAN_ON_ACTIVATE) setTimeout(scanPage, 250);
  console.info('[Popunder Detector] active - badge is bottom-right.');
})();
