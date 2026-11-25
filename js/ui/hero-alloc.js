'use strict';
// Hero allocation: the compact ring inside the Total balance panel (home
// stays one calm panel).

function allocationData(st, dtrades, visibleIds) {
  var method = st.settings.costMethod;
  var pf = null;
  try { pf = computePortfolio(dtrades, livePrices, method); } catch (e) { pf = null; }
  var bySym = {};
  var skipCash = {};
  try { skipCash = cashAccountIds(st); } catch (e) { skipCash = {}; }
  if (pf && pf.byAccount) {
    Object.keys(pf.byAccount).forEach(function (accId) {
      if (visibleIds && visibleIds.indexOf(accId) === -1) return; // honor the asset filter
      if (skipCash[accId]) return; // cash joins below as balance slices, never engine rows
      pf.byAccount[accId].forEach(function (p, sym) {
        var key = p.symbol;
        if (p.marketValue === null) {
          // unknown price: count cost as fallback so allocation still shows something?
          return;
        }
        bySym[key] = (bySym[key] || 0) + p.marketValue;
      });
    });
  }
  var total = 0;
  // Cash ledgers join the ring as balance slices (same totals as the hero).
  try {
    var cIds = cashAccountIds(st);
    var dAll = dtrades || [];
    Object.keys(cIds).forEach(function (aid) {
      if (visibleIds && visibleIds.indexOf(aid) === -1) return;
      var hasAny = dAll.some(function (t) { return transferInvolvesAccount(t, aid); });
      if (!hasAny) return;
      var cb = cashBalance(dAll, aid, st.settings.mainCurrency);
      var key = String(cb.ticker || '').toUpperCase();
      if (!key || !isFinite(cb.main)) return;
      bySym[key] = (bySym[key] || 0) + cb.main;
    });
  } catch (e) { /* ignore */ }
  Object.keys(bySym).forEach(function (k) { total += bySym[k]; });
  // Empty accounts never display: below half a cent prints as €0.00, so it
  // reads as content in the ring legend. Totals are unaffected (dust ≈ 0).
  var arr = Object.keys(bySym)
    .filter(function (k) { return Math.abs(bySym[k]) >= 0.005; })
    .map(function (k) { return { symbol: k, value: bySym[k], pct: total > 0 ? (bySym[k] / total) * 100 : 0 }; });
  arr.sort(function (a, b) { return b.value - a.value; });
  return { items: arr, total: total };
}

function renderHeroAlloc(st) {
  var host = document.getElementById('hero-alloc');
  if (!host) return;
  var main = st.settings.mainCurrency;
  if (!st.accounts.length || !(st.trades || []).length) { host.hidden = true; host.innerHTML = ''; return; }
  var dtrades = convertTrades(st.trades, main);
  var vf = selectedTickers(st);
  var vIds = vf === null ? null : (st.accounts || [])
    .filter(function (a) { return vf.indexOf(String(a.ticker).toUpperCase()) !== -1; })
    .map(function (a) { return a.id; });
  var al = allocationData(st, dtrades, vIds);
  if (!al.items.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML = '';
  // Text first, ring last: legend sits left, circle pins to the very right.
  // Muted hues that skip red and green, which stay reserved for loss / gain.
  var palette = ['#e6e6e8', '#78aee0', '#4fb3a9', '#a995e8', '#dba94e', '#8a8a90'];
  var leg = document.createElement('ul');
  leg.className = 'hero-alloc-legend';
  al.items.forEach(function (it, i) {
    var li = document.createElement('li');
    var dot = document.createElement('span');
    dot.className = 'hero-alloc-dot';
    dot.style.background = palette[i % palette.length];
    li.appendChild(dot);
    var tx = document.createElement('span');
    tx.textContent = it.symbol + ' · ' + fmtPct(it.pct) + ' · ' + fmtMoney(it.value, main);
    li.appendChild(tx);
    leg.appendChild(li);
  });
  host.appendChild(leg);
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('class', 'donut-sm');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Allocation by asset');
  var cx = 60, cy = 60, r = 46, circ = 2 * Math.PI * r;
  var off = 0;
  al.items.forEach(function (it, i) {
    var frac = it.pct / 100;
    var c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', palette[i % palette.length]);
    c.setAttribute('stroke-width', '14');
    c.setAttribute('stroke-dasharray', (frac * circ) + ' ' + circ);
    c.setAttribute('stroke-dashoffset', String(-off * circ));
    c.setAttribute('stroke-linecap', 'butt');
    c.setAttribute('transform', 'rotate(-90 60 60)');
    svg.appendChild(c);
    off += frac;
  });
  // Hole number matches the legend rows: every displayed asset counts,
  // empty ones never do.
  var nAssets = al.items.length;
  svg.setAttribute('aria-label', 'Allocation: ' + nAssets + (nAssets === 1 ? ' asset' : ' assets'));
  var num = document.createElementNS(svgNS, 'text');
  num.setAttribute('x', cx);
  num.setAttribute('y', '60');
  num.setAttribute('text-anchor', 'middle');
  num.setAttribute('class', 'donut-num');
  num.textContent = String(nAssets);
  svg.appendChild(num);
  var lab = document.createElementNS(svgNS, 'text');
  lab.setAttribute('x', cx);
  lab.setAttribute('y', '79');
  lab.setAttribute('text-anchor', 'middle');
  lab.setAttribute('class', 'donut-lab');
  lab.textContent = nAssets === 1 ? 'ASSET' : 'ASSETS';
  svg.appendChild(lab);
  host.appendChild(svg);
  syncHeroAllocHeight();
}

// The legend never stretches its box: capped at six rows on desktop / three
// rows on phones (the seventh / fourth asset scrolls, never earlier) and
// never taller than the left amount block, so the hero cannot expand no matter how many assets exist.
// Re-synced on render + viewport and font changes because the amount scales
// with the viewport.
function syncHeroAllocHeight() {
  try {
    var host = document.getElementById('hero-alloc');
    if (!host || host.hidden) return;
    var hero = document.getElementById('hero');
    var main = hero ? hero.querySelector('.hero-main') : null;
    var leg = host.querySelector('.hero-alloc-legend');
    if (!main || !leg) return;
    var h = main.clientHeight;
    if (!(h > 0)) return;
    var cap = h;
    try {
      var narrow = false;
      try {
        if (typeof window !== 'undefined' && window.matchMedia) {
          narrow = window.matchMedia('(max-width: 720px)').matches;
        }
      } catch (eN) {}
      // Measure the rendered rows instead of estimating them from font
      // metrics: an estimate drifts per browser/font (it left six desktop
      // rows a few pixels short, so they scrolled). The cap ends exactly at
      // the last row that must fit, so the next one is what scrolls.
      var rows = narrow ? 3 : 6;
      var lis = leg.children;
      if (lis && lis.length > rows) {
        var lr = leg.getBoundingClientRect();
        var lastR = lis[rows - 1].getBoundingClientRect();
        var fit = lastR.bottom - lr.top + (leg.scrollTop || 0) + (leg.clientTop || 0);
        if (fit > 0 && fit < cap) cap = fit;
      }
    } catch (e2) { /* fall back to the measured block height */ }
    leg.style.maxHeight = cap + 'px';
    // Pin the ring to exact pixels as well: percentage heights resolve
    // against sibling-influenced layout and drift per content — pixels
    // cannot. Cleared on narrow screens where the stylesheet size applies.
    try {
      var wide = true;
      try {
        if (typeof window !== 'undefined' && window.matchMedia) {
          wide = window.matchMedia('(min-width: 721px)').matches;
        }
      } catch (e3) {}
      var ring = host.querySelector('.donut-sm');
      if (ring && ring.style) {
        if (wide && h > 0) {
          ring.style.width = h + 'px';
          ring.style.height = h + 'px';
        } else {
          ring.style.width = '';
          ring.style.height = '';
        }
      }
    } catch (e4) { /* ring keeps its stylesheet size */ }
  } catch (e) { /* ignore */ }
}
