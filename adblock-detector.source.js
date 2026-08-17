/*
 * Ad / Anti-Adblock / Popunder Source Scanner
 * ---------------------------------------------
 * Bookmarklet that inspects the CURRENT page (raw HTML source, inline
 * scripts, external script URLs, meta tags, storage, and live DOM) for
 * known anti-adblock detection code, popunder/redirect ad networks,
 * content-locker gates, and obfuscated payloads. Renders a bottom-sheet
 * report in a Shadow DOM so it can't be broken by the host page's CSS,
 * and can export findings as uBlock Origin / AdGuard filter rules.
 *
 * Everything runs read-only in your own browser tab. It never sends
 * anything anywhere; "Copy filters" just puts text on your clipboard.
 */
(function () {
  'use strict';

  // Re-invoking the bookmarklet on the same page just toggles the panel.
  if (window.__adScanApi) {
    window.__adScanApi.toggle();
    return;
  }

  // ---------------------------------------------------------------------
  // 1. SIGNATURE DATABASE
  //    Each entry: { name, re, severity }. severity: 3=high 2=medium 1=info
  // ---------------------------------------------------------------------
  const SIGNATURES = {
    'Anti-adblock detection': [
      { name: 'Code Help Pro / "chp-ads-block-detector" (WP plugin)', re: /["'(]([^"')]*chp-ads-block-detector[^"')]*)["')]/i, severity: 3 },
      { name: 'BlockAdBlock / FuckAdBlock library', re: /\b(fuckadblock|blockadblock|block_adblock)\b/i, severity: 3 },
      { name: 'Generic "adblock detect(or)" script/class', re: /adblock[-_]?detect(or)?/i, severity: 2 },
      { name: 'Sourcepoint anti-adblock / consent wall', re: /sourcepoint|sp_message_container|sp-prod\.net|msg\.sp-tag\.com/i, severity: 2 },
      { name: 'Monetag publisher verification tag', re: /<meta[^>]+name=["']monetag["']/i, severity: 2 },
      { name: '"please disable your ad blocker" prompt text', re: /(disable|turn off|please\s+disable)[^.<]{0,30}(ad\s?block)/i, severity: 2 },
      { name: 'Bait element used to sniff adblock (adsbox/textads/etc.)', re: /class=["'][^"']*(adsbox|textads|banner_ad|ad-placement-sniff)[^"']*["']/i, severity: 1 },
    ],
    'Popunder / redirect ad networks': [
      { name: 'PropellerAds / Monetag', re: /propellerads|propellerclick|monetag/i, severity: 3 },
      { name: 'PopAds', re: /popads\.net/i, severity: 3 },
      { name: 'PopCash', re: /popcash\.net/i, severity: 3 },
      { name: 'Adsterra', re: /adsterra|highperformanceformat\.com/i, severity: 3 },
      { name: 'ExoClick', re: /exoclick|exosrv\.com/i, severity: 2 },
      { name: 'JuicyAds', re: /juicyads/i, severity: 2 },
      { name: 'Clickadu', re: /clickadu/i, severity: 2 },
      { name: 'Adcash', re: /adcash/i, severity: 2 },
      { name: 'HilltopAds', re: /hilltopads/i, severity: 2 },
      { name: 'MGID', re: /mgid\.com/i, severity: 1 },
      { name: 'Zeydoo', re: /zeydoo/i, severity: 2 },
      { name: 'Generic ad-zone query param (?zoneid=)', re: /[?&]zone_?id=/i, severity: 1 },
    ],
    'Content lockers / "click to continue" gates': [
      { name: 'Generic content-locker / continue gate text', re: /content[-_]?locker|click here to continue/i, severity: 2 },
      { name: 'Known shortener/locker domains', re: /adf\.ly|linkvertise\.com|shrinkme\.io|shorte\.st|ouo\.io|exe\.io|gplinks\.in/i, severity: 2 },
      { name: 'Bot-check / "please wait" gate (informational)', re: /just a moment|checking your browser|please wait while we verify/i, severity: 1 },
    ],
    'Push-notification ad spam': [
      { name: 'Push-ad network', re: /push\.house|megapu\.sh/i, severity: 2 },
    ],
    'Obfuscated / suspicious payloads': [
      { name: 'Packed JS (Dean Edwards packer)', re: /eval\(function\(p,a,c,k,e,d?\)/i, severity: 2 },
      { name: 'document.write(unescape(...)) injector', re: /document\.write\(unescape\(/i, severity: 2 },
      { name: 'Base64 payload piped straight into eval', re: /eval\(atob\(/i, severity: 2 },
    ],
  };

  const SUSPICIOUS_STORAGE_KEY_RE = /^(pu_|_pop|popns|zoneid|smartpop|ysmm)/i;
  const SAFE_IFRAME_HOST_RE = /google\.com|gstatic\.com|recaptcha|doubleclick\.net\/pagead|facebook\.com\/tr|googletagmanager\.com/i;

  // Unique fingerprint embedded in this tool's own source. If you host this
  // script (jsdelivr, a userscript, a <script src> loader, etc.) it will
  // otherwise legitimately match its own "adblock-detect" style signatures -
  // the file IS about detecting adblock-detectors. Any source containing
  // this exact marker is excluded from scanning before signatures run.
  const SELF_MARKER = '__ADSCAN_SELF_' + 'f21x9k' + '__';

  // ---------------------------------------------------------------------
  // 2. GATHER SOURCES  (this is the "view-source:" replacement)
  //    view-source: URLs can't be opened/fetched from injected JS, so
  //    instead we fetch the page's own URL (same-origin -> no CORS
  //    issue) to get the raw HTML exactly as the server sent it, then
  //    add inline scripts, external script URLs (+ same-origin bodies
  //    where fetchable), and the <head> for meta tags.
  // ---------------------------------------------------------------------
  async function gatherSources() {
    const sources = [];

    try {
      const res = await fetch(location.href, { credentials: 'same-origin' });
      sources.push({ label: 'raw HTML (view-source equivalent)', url: location.href, text: await res.text() });
    } catch (e) {
      sources.push({ label: 'live DOM (fetch of raw source failed)', url: location.href, text: document.documentElement.outerHTML });
    }

    document.querySelectorAll('script:not([src])').forEach((s, i) => {
      if (s.textContent.trim()) sources.push({ label: 'inline script #' + i, url: null, text: s.textContent });
    });

    const scriptEls = Array.from(document.querySelectorAll('script[src]'));
    for (const s of scriptEls) {
      const src = s.src;
      sources.push({ label: 'external script URL', url: src, text: src });
      try {
        if (new URL(src).origin === location.origin) {
          const r = await fetch(src);
          sources.push({ label: 'external script body (same-origin)', url: src, text: await r.text() });
        }
      } catch (e) { /* cross-origin or blocked by CORS - URL itself was already scanned */ }
    }

    sources.push({ label: 'document head (meta tags)', url: null, text: document.head.innerHTML });
    return sources.filter((s) => s.text.indexOf(SELF_MARKER) === -1);
  }

  // ---------------------------------------------------------------------
  // 3. SCAN
  // ---------------------------------------------------------------------
  function scanSources(sources) {
    const findings = [];
    const seen = new Set();
    for (const category of Object.keys(SIGNATURES)) {
      for (const sig of SIGNATURES[category]) {
        for (const src of sources) {
          const m = src.text.match(sig.re);
          if (!m) continue;
          const key = category + '|' + sig.name;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            category,
            name: sig.name,
            severity: sig.severity,
            evidence: (m[1] || m[0]).slice(0, 140),
            from: src.url || src.label,
          });
        }
      }
    }
    return findings;
  }

  function scanStorage() {
    const hits = [];
    try {
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (SUSPICIOUS_STORAGE_KEY_RE.test(k)) hits.push(k);
        }
      }
    } catch (e) { /* storage may be blocked */ }
    return hits;
  }

  function scanHiddenIframes() {
    const hits = [];
    document.querySelectorAll('iframe').forEach((f) => {
      if (!f.src) return;
      const r = f.getBoundingClientRect();
      const style = getComputedStyle(f);
      const tiny = r.width <= 2 && r.height <= 2;
      const offscreen = parseInt(style.left) < -1000 || parseInt(style.top) < -1000;
      if ((tiny || offscreen) && !SAFE_IFRAME_HOST_RE.test(f.src)) hits.push(f.src);
    });
    return hits;
  }

  function checkWindowOpenHooked() {
    try { return !/\[native code\]/.test(window.open.toString()); }
    catch (e) { return false; }
  }

  const DOMAIN_LIKE_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

  // Derives a folder-scoped rule for first-party matches that came with a
  // real asset path (e.g. a plugin's own JS/img folder) instead of ever
  // blocking the whole site. Heuristic: keep everything up to the last
  // "/" in the matched path, wildcard the rest.
  function firstPartyPathRule(pageHost, evidence) {
    if (!evidence) return null;
    let path = evidence.replace(/^https?:\/\/[^/]+/i, '');
    if (path.charAt(0) !== '/') return null;
    const dir = path.slice(0, path.lastIndexOf('/'));
    return dir ? '||' + pageHost + dir + '/*' : null;
  }

  // Builds uBlock Origin / AdGuard-syntax rules, split into three honest
  // tiers instead of one blunt domain list:
  //   1. Confirmed third-party ad/tracker domains -> safe to block outright.
  //   2. First-party matches with a derivable asset path -> folder-scoped
  //      block (kills the script, leaves the rest of the site alone).
  //   3. First-party matches with no blockable resource (e.g. a bare meta
  //      tag) -> informational only; these need a cosmetic/annoyance-list
  //      fix, not a network rule.
  function toFilterRules(findings) {
    const pageHost = location.hostname;
    const domainRules = new Set();
    const pathRules = new Set();
    const infoOnly = [];

    findings.forEach((f) => {
      const evidenceIsDomain = DOMAIN_LIKE_RE.test(f.evidence) && f.evidence.toLowerCase() !== pageHost.toLowerCase();
      if (evidenceIsDomain) { domainRules.add(f.evidence.toLowerCase()); return; }

      let sourceHost = null;
      if (f.from) { try { sourceHost = new URL(f.from).hostname; } catch (e) {} }

      if (sourceHost && sourceHost !== pageHost) { domainRules.add(sourceHost); return; }

      const pathRule = firstPartyPathRule(pageHost, f.evidence);
      if (pathRule) { pathRules.add(pathRule); return; }

      infoOnly.push(f);
    });

    const lines = [];
    if (domainRules.size) {
      lines.push('! Third-party ad/tracker domains - safe to block, does not affect ' + pageHost);
      Array.from(domainRules).sort().forEach((d) => lines.push('||' + d + '^'));
    }
    if (pathRules.size) {
      lines.push('');
      lines.push('! First-party assets on ' + pageHost + ' - folder-scoped, review before using');
      Array.from(pathRules).sort().forEach((r) => lines.push(r));
    }
    if (infoOnly.length) {
      lines.push('');
      lines.push('! Informational only - no blockable network resource, page would break if ' + pageHost + ' were blocked.');
      lines.push('! Enable "Adblock Warning Removal List" (Annoyances) in your ad blocker for these instead:');
      infoOnly.forEach((f) => lines.push('!  - ' + f.name));
    }
    return lines.join('\n') || '! No blockable third-party domains found in this scan.';
  }

  // ---------------------------------------------------------------------
  // 4. UI  (Shadow DOM bottom sheet, mobile-first)
  // ---------------------------------------------------------------------
  const SEV_COLOR = { 3: '#ff4d4f', 2: '#faad14', 1: '#8c8c8c' };
  const SEV_LABEL = { 3: 'HIGH', 2: 'MED', 1: 'INFO' };

  function buildUI() {
    const host = document.createElement('div');
    host.id = '__ad_scan_host__';
    host.style.cssText = 'all:initial;position:fixed;left:0;right:0;bottom:0;z-index:2147483647;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'closed' });

    root.innerHTML = `
      <style>
        * { box-sizing:border-box; font-family:-apple-system,Roboto,Segoe UI,sans-serif; }
        .tab { position:fixed; right:14px; bottom:14px; background:#1a1a1a; color:#fff;
               padding:10px 16px; border-radius:24px; font-size:14px; font-weight:600;
               box-shadow:0 2px 10px rgba(0,0,0,.35); display:flex; align-items:center; gap:8px; }
        .dot { width:8px; height:8px; border-radius:50%; background:#52c41a; }
        .dot.hit { background:#ff4d4f; }
        .sheet { position:fixed; left:0; right:0; bottom:0; max-height:75vh; background:#161616;
                 color:#eee; border-radius:16px 16px 0 0; box-shadow:0 -4px 24px rgba(0,0,0,.5);
                 display:flex; flex-direction:column; transform:translateY(100%);
                 transition:transform .25s ease; }
        .sheet.open { transform:translateY(0); }
        .hdr { display:flex; align-items:center; justify-content:space-between; padding:14px 16px;
               border-bottom:1px solid #2a2a2a; }
        .hdr h1 { font-size:15px; margin:0; }
        .hdr button { background:#2a2a2a; color:#eee; border:none; border-radius:8px;
                      padding:6px 10px; font-size:13px; }
        .body { overflow-y:auto; padding:8px 16px 16px; }
        .cat { margin-top:14px; }
        .cat h2 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:#999;
                  margin:0 0 6px; }
        .row { padding:8px 0; border-bottom:1px solid #232323; }
        .row .top { display:flex; align-items:center; gap:8px; }
        .badge { font-size:10px; font-weight:700; padding:1px 6px; border-radius:4px; color:#111; }
        .name { font-size:13.5px; }
        .from { font-size:11.5px; color:#888; margin-top:3px; word-break:break-all; }
        .evi { font-size:11.5px; color:#6fcf97; margin-top:3px; word-break:break-all; font-family:monospace; }
        .empty { color:#888; font-size:13px; padding:10px 0; }
        .footer { display:flex; gap:8px; padding:10px 16px 16px; border-top:1px solid #2a2a2a; }
        .footer button { flex:1; background:#2a2a2a; color:#eee; border:none; border-radius:10px;
                          padding:10px; font-size:13px; font-weight:600; }
        .footer button.primary { background:#2f7cf6; }
        .note { font-size:11.5px; color:#888; padding:0 16px 10px; }
      </style>
      <div class="tab" id="tab"><span class="dot" id="dot"></span><span id="tabLabel">Scanning…</span></div>
      <div class="sheet" id="sheet">
        <div class="hdr">
          <h1 id="title">Ad / Anti-Adblock Scan</h1>
          <div>
            <button id="rescan">Rescan</button>
            <button id="close">Close</button>
          </div>
        </div>
        <div class="body" id="body"></div>
        <div class="note" id="note"></div>
        <div class="footer">
          <button id="copyFilters">Copy filter rules</button>
          <button id="copyJson" class="primary">Copy JSON report</button>
        </div>
      </div>
    `;

    const els = {
      tab: root.getElementById('tab'),
      dot: root.getElementById('dot'),
      tabLabel: root.getElementById('tabLabel'),
      sheet: root.getElementById('sheet'),
      body: root.getElementById('body'),
      note: root.getElementById('note'),
      close: root.getElementById('close'),
      rescan: root.getElementById('rescan'),
      copyFilters: root.getElementById('copyFilters'),
      copyJson: root.getElementById('copyJson'),
    };

    let open = false;
    function setOpen(v) { open = v; els.sheet.classList.toggle('open', open); }
    els.tab.addEventListener('click', () => setOpen(!open));
    els.close.addEventListener('click', () => setOpen(false));

    return { host, els, setOpen, get open() { return open; } };
  }

  function render(ui, data) {
    const { findings, storageHits, iframeHits, hooked } = data;
    const total = findings.length + storageHits.length + iframeHits.length + (hooked ? 1 : 0);

    ui.els.dot.classList.toggle('hit', total > 0);
    ui.els.tabLabel.textContent = total > 0 ? total + ' finding' + (total === 1 ? '' : 's') : 'Nothing found';

    const byCat = {};
    findings.forEach((f) => { (byCat[f.category] = byCat[f.category] || []).push(f); });

    let html = '';
    if (total === 0) {
      html = '<div class="empty">No known anti-adblock, popunder, or locker signatures found in the current source.</div>';
    } else {
      for (const cat of Object.keys(byCat)) {
        html += '<div class="cat"><h2>' + esc(cat) + ' (' + byCat[cat].length + ')</h2>';
        byCat[cat].forEach((f) => {
          html += '<div class="row"><div class="top">' +
            '<span class="badge" style="background:' + SEV_COLOR[f.severity] + '">' + SEV_LABEL[f.severity] + '</span>' +
            '<span class="name">' + esc(f.name) + '</span></div>' +
            '<div class="from">' + esc(String(f.from).slice(0, 100)) + '</div>' +
            '<div class="evi">' + esc(f.evidence) + '</div></div>';
        });
        html += '</div>';
      }
      if (iframeHits.length) {
        html += '<div class="cat"><h2>Hidden / off-screen iframes (' + iframeHits.length + ')</h2>';
        iframeHits.forEach((src) => { html += '<div class="row"><div class="from">' + esc(src) + '</div></div>'; });
        html += '</div>';
      }
      if (storageHits.length) {
        html += '<div class="cat"><h2>Suspicious storage keys (' + storageHits.length + ')</h2>';
        storageHits.forEach((k) => { html += '<div class="row"><div class="name">' + esc(k) + '</div></div>'; });
        html += '</div>';
      }
      if (hooked) {
        html += '<div class="cat"><h2>Behavioral</h2><div class="row">' +
          '<div class="name">window.open() has been overridden (not native code) — a script is intercepting popup calls.</div></div></div>';
      }
    }
    ui.els.body.innerHTML = html;
    ui.els.note.textContent = 'Cross-origin scripts are checked by URL only (content unreadable due to CORS). Same-origin scripts and the raw page source are fully scanned.';

    ui.els.copyJson.onclick = () => copy(JSON.stringify(data, null, 2));
    ui.els.copyFilters.onclick = () => copy(toFilterRules(findings) || '# no external domains matched');
  }

  function copy(text) {
    navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {});
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------
  // 5. RUN
  // ---------------------------------------------------------------------
  async function run(ui) {
    ui.els.tabLabel.textContent = 'Scanning…';
    const sources = await gatherSources();
    const findings = scanSources(sources);
    const storageHits = scanStorage();
    const iframeHits = scanHiddenIframes();
    const hooked = checkWindowOpenHooked();
    render(ui, { findings, storageHits, iframeHits, hooked, page: location.href, scannedAt: new Date().toISOString() });
  }

  const ui = buildUI();
  window.__adScanApi = {
    toggle: () => ui.setOpen(!ui.open),
    rescan: () => run(ui),
  };
  ui.els.rescan.addEventListener('click', () => run(ui));
  run(ui).then(() => ui.setOpen(true));
})();
