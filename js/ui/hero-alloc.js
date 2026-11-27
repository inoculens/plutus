'use strict';
// Hero allocation: the compact ring inside the Total balance panel (home
// stays one calm panel).

function allocationData(st, dtrades, visibleIds) {
  var method = st.settings.costMethod;
  var pf = null;
  try { pf = computePortfolio(dtrades, livePrices, method); } catch (e) { pf = null; }
  var bySym = {};
  // Per asset: which accounts hold it and how much (drives segment colors).
  var accVal = {};
  function credit(key, accId, v) {
    if (!accVal[key]) accVal[key] = {};
    accVal[key][accId] = (accVal[key][accId] || 0) + v;
  }
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
        credit(key, accId, p.marketValue);
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
      credit(key, aid, cb.main);
    });
  } catch (e) { /* ignore */ }
  // Pending income joins its asset's slice (the hero total counts it too);
  // an entry without a known value is left out, never counted as 0.
  try {
    (st.accounts || []).forEach(function (owner) {
      if (!owner || !owner.id || (visibleIds && visibleIds.indexOf(owner.id) === -1)) return;
      accountStakeRewards(owner).forEach(function (reward) {
        var val = debtPositionValuation(reward, st.settings.mainCurrency, livePrices, null, owner);
        if (!val.known || val.value === null || !(val.value > 0)) return;
        var key = String(reward.assetTicker || '').toUpperCase();
        bySym[key] = (bySym[key] || 0) + val.value;
        credit(key, owner.id, val.value);
      });
    });
  } catch (e) { /* the ring never breaks the hero */ }
  Object.keys(bySym).forEach(function (k) { total += bySym[k]; });
  // Accounts of the same asset share its segment color, holding or not.
  var accById = {};
  (st.accounts || []).forEach(function (a) { if (a && a.id) accById[a.id] = a; });
  function holders(key) {
    var vals = accVal[key] || {};
    var seen = {};
    var list = [];
    Object.keys(vals).forEach(function (id) {
      var a = accById[id];
      if (!a) return;
      seen[id] = true;
      list.push({ name: a.name, color: a.color, value: Math.abs(vals[id]) });
    });
    (st.accounts || []).forEach(function (a) {
      if (!a || seen[a.id] || String(a.ticker || '').toUpperCase() !== String(key).toUpperCase()) return;
      if (visibleIds && visibleIds.indexOf(a.id) === -1) return;
      list.push({ name: a.name, color: a.color, value: 0 });
    });
    return list;
  }
  // Empty accounts never display: below half a cent prints as €0.00, so it
  // reads as content in the ring legend. Totals are unaffected (dust ≈ 0).
  var arr = Object.keys(bySym)
    .filter(function (k) { return Math.abs(bySym[k]) >= 0.005; })
    .map(function (k) { return { symbol: k, value: bySym[k], pct: total > 0 ? (bySym[k] / total) * 100 : 0, accounts: holders(k) }; });
  arr.sort(function (a, b) { return b.value - a.value; });
  return { items: arr, total: total };
}

// Ring geometry (viewBox 0 0 120 120). Segments are annular sectors with
// rounded corners and parallel gaps; the hovered one slides out a little.
var HERO_RING = { cx: 60, cy: 60, outer: 55, inner: 41, corner: 2.6, gap: 1.4, pop: 3 };

// The asset the owner points at (mouse) or pinned (tap / click). Kept
// across repaints so a price refresh never drops the highlight.
var heroAllocActive = null;
var heroAllocPinned = false;
var heroAllocOutsideWired = false;

function heroRingPoint(r, a) {
  var g = HERO_RING;
  return (g.cx + r * Math.cos(a)).toFixed(3) + ' ' + (g.cy + r * Math.sin(a)).toFixed(3);
}

// One rounded sector from angle a0 to a1 (radians, clockwise from top).
// The path is the sector inset by the corner radius; a same-color stroke of
// twice that radius with round joins grows it back with rounded corners.
function heroRingSegmentPath(a0, a1) {
  var g = HERO_RING;
  var rc = g.corner;
  var ro = g.outer - rc, ri = g.inner + rc;
  var d = rc + g.gap / 2; // distance from the radial edge: keeps gaps parallel
  var ao0 = a0 + Math.asin(Math.min(1, d / ro)), ao1 = a1 - Math.asin(Math.min(1, d / ro));
  var ai0 = a0 + Math.asin(Math.min(1, d / ri)), ai1 = a1 - Math.asin(Math.min(1, d / ri));
  if (ai1 < ai0) { var mi = (a0 + a1) / 2; ai0 = ai1 = mi; }
  if (ao1 < ao0) { var mo = (a0 + a1) / 2; ao0 = ao1 = mo; }
  var largeO = (ao1 - ao0) > Math.PI ? 1 : 0;
  var largeI = (ai1 - ai0) > Math.PI ? 1 : 0;
  return 'M' + heroRingPoint(ro, ao0) +
    ' A' + ro + ' ' + ro + ' 0 ' + largeO + ' 1 ' + heroRingPoint(ro, ao1) +
    ' L' + heroRingPoint(ri, ai1) +
    ' A' + ri + ' ' + ri + ' 0 ' + largeI + ' 0 ' + heroRingPoint(ri, ai0) + ' Z';
}

// Fractions → segment angles. Every slice keeps a visible minimum so a
// 0.1% dust holding still reads as a small rounded pill, not a hairline.
function heroRingAngles(fracs) {
  var g = HERO_RING;
  var n = fracs.length;
  var full = Math.PI * 2;
  var minA = (2 * (g.corner + g.gap / 2) + 2.2) / g.inner;
  if (n * minA >= full) minA = full / n;
  var small = 0, rest = 0;
  fracs.forEach(function (f) { if (f * full < minA) small++; else rest += f; });
  var free = full - small * minA;
  var out = [];
  var a = -Math.PI / 2;
  fracs.forEach(function (f) {
    var span = f * full < minA ? minA : (rest > 0 ? (f / rest) * free : minA);
    out.push([a, a + span]);
    a += span;
  });
  return out;
}

function heroAllocPctLabel(p) {
  if (!isFinite(p)) return '—';
  if (p >= 99.5) return '100%';
  if (p >= 10) return Math.round(p) + '%';
  if (p >= 0.1) return (Math.round(p * 10) / 10) + '%';
  return '<0.1%';
}

function heroAllocApply(host) {
  if (!host) return;
  var sym = heroAllocActive;
  var segs = host.querySelectorAll('.alloc-seg');
  var rows = host.querySelectorAll('.hero-alloc-legend li');
  var found = null;
  Array.prototype.forEach.call(segs, function (p) {
    var on = sym !== null && p.getAttribute('data-sym') === sym;
    if (on) found = p;
    p.classList.toggle('is-active', on);
  });
  if (sym !== null && !found) { heroAllocActive = null; heroAllocPinned = false; sym = null; }
  Array.prototype.forEach.call(rows, function (li) {
    li.classList.toggle('is-active', sym !== null && li.getAttribute('data-sym') === sym);
  });
  host.classList.toggle('has-active', sym !== null);
  var num = host.querySelector('.donut-num');
  var lab = host.querySelector('.donut-lab');
  if (!num || !lab) return;
  if (sym === null) {
    num.textContent = num.getAttribute('data-count');
    lab.textContent = lab.getAttribute('data-label');
    num.removeAttribute('data-long');
    num.removeAttribute('data-pct');
  } else {
    var pctTxt = heroAllocPctLabel(Number(found.getAttribute('data-pct')));
    num.textContent = pctTxt;
    num.setAttribute('data-pct', '1');
    if (pctTxt.length > 3) num.setAttribute('data-long', '1'); else num.removeAttribute('data-long');
    var s = String(sym);
    lab.textContent = s.length > 8 ? s.slice(0, 7) + '…' : s;
  }
}

function heroAllocSet(host, sym, pin) {
  if (pin) {
    if (heroAllocPinned && heroAllocActive === sym) { heroAllocPinned = false; heroAllocActive = null; }
    else { heroAllocPinned = true; heroAllocActive = sym; }
  } else {
    if (heroAllocPinned) return;
    heroAllocActive = sym;
  }
  heroAllocApply(host);
}

function heroAllocSymOf(el, host) {
  while (el && el !== host) {
    if (el.getAttribute && el.getAttribute('data-sym') !== null) return el.getAttribute('data-sym');
    el = el.parentNode;
  }
  return null;
}

function wireHeroAlloc(host) {
  if (host.getAttribute('data-wired') === '1') return;
  host.setAttribute('data-wired', '1');
  // Mouse / pen: highlight follows the pointer. Touch has no hover, so a
  // tap pins the segment instead (handled by click below).
  host.addEventListener('pointerover', function (e) {
    if (e.pointerType === 'touch') return;
    var sym = heroAllocSymOf(e.target, host);
    if (sym !== null) heroAllocSet(host, sym, false);
  });
  host.addEventListener('pointerout', function (e) {
    if (e.pointerType === 'touch') return;
    var to = e.relatedTarget;
    var next = to && host.contains(to) ? heroAllocSymOf(to, host) : null;
    heroAllocSet(host, next, false);
  });
  host.addEventListener('click', function (e) {
    var sym = heroAllocSymOf(e.target, host);
    if (sym === null) { if (heroAllocPinned) { heroAllocPinned = false; heroAllocActive = null; heroAllocApply(host); } return; }
    heroAllocSet(host, sym, true);
  });
  host.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var sym = heroAllocSymOf(e.target, host);
    if (sym === null) return;
    e.preventDefault();
    heroAllocSet(host, sym, true);
  });
  host.addEventListener('focusin', function (e) {
    var sym = heroAllocSymOf(e.target, host);
    if (sym !== null && !heroAllocPinned) { heroAllocActive = sym; heroAllocApply(host); }
  });
  host.addEventListener('focusout', function (e) {
    if (heroAllocPinned) return;
    var to = e.relatedTarget;
    heroAllocActive = to && host.contains(to) ? heroAllocSymOf(to, host) : null;
    heroAllocApply(host);
  });
  if (!heroAllocOutsideWired && typeof document !== 'undefined' && document.addEventListener) {
    heroAllocOutsideWired = true;
    document.addEventListener('click', function (e) {
      if (!heroAllocPinned) return;
      var h = document.getElementById('hero-alloc');
      if (h && h.contains(e.target)) return;
      heroAllocPinned = false;
      heroAllocActive = null;
      heroAllocApply(h);
    });
  }
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
  wireHeroAlloc(host);
  // Segment colors follow the accounts (see js/ui/asset-colors.js).
  var colors = resolveAllocColors(al.items);
  // Text first, ring last: legend sits left, circle pins to the very right.
  var leg = document.createElement('ul');
  leg.className = 'hero-alloc-legend';
  al.items.forEach(function (it, i) {
    var li = document.createElement('li');
    li.setAttribute('data-sym', it.symbol);
    li.setAttribute('tabindex', '0');
    li.style.setProperty('--seg', colors[i]);
    var dot = document.createElement('span');
    dot.className = 'hero-alloc-dot';
    dot.style.background = colors[i];
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
  var g = HERO_RING;
  var segG = document.createElementNS(svgNS, 'g');
  segG.setAttribute('class', 'alloc-segs');
  var single = al.items.length === 1;
  var angles = single ? null : heroRingAngles(al.items.map(function (it) { return Math.max(0, it.pct) / 100; }));
  al.items.forEach(function (it, i) {
    var p = document.createElementNS(svgNS, 'path');
    if (single) {
      // One asset: a clean full ring, no seam.
      var rm = (g.outer + g.inner) / 2;
      p.setAttribute('d', 'M' + (g.cx + rm) + ' ' + g.cy + ' A' + rm + ' ' + rm + ' 0 1 1 ' + (g.cx - rm) + ' ' + g.cy +
        ' A' + rm + ' ' + rm + ' 0 1 1 ' + (g.cx + rm) + ' ' + g.cy);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', colors[i]);
      p.setAttribute('stroke-width', String(g.outer - g.inner));
    } else {
      var a = angles[i];
      p.setAttribute('d', heroRingSegmentPath(a[0], a[1]));
      p.setAttribute('fill', colors[i]);
      p.setAttribute('stroke', colors[i]);
      p.setAttribute('stroke-width', String(g.corner * 2));
      p.setAttribute('stroke-linejoin', 'round');
      var mid = (a[0] + a[1]) / 2;
      p.style.setProperty('--dx', (Math.cos(mid) * g.pop).toFixed(2) + 'px');
      p.style.setProperty('--dy', (Math.sin(mid) * g.pop).toFixed(2) + 'px');
    }
    p.setAttribute('class', 'alloc-seg');
    p.setAttribute('data-sym', it.symbol);
    p.setAttribute('data-pct', String(it.pct));
    segG.appendChild(p);
  });
  svg.appendChild(segG);
  // Hole number matches the legend rows: every displayed asset counts,
  // empty ones never do. Hovering a segment swaps it for that asset's share.
  var nAssets = al.items.length;
  svg.setAttribute('aria-label', 'Allocation: ' + nAssets + (nAssets === 1 ? ' asset' : ' assets'));
  var num = document.createElementNS(svgNS, 'text');
  num.setAttribute('x', g.cx);
  num.setAttribute('y', '58');
  num.setAttribute('text-anchor', 'middle');
  num.setAttribute('dominant-baseline', 'central');
  num.setAttribute('class', 'donut-num');
  num.setAttribute('data-count', String(nAssets));
  num.textContent = String(nAssets);
  svg.appendChild(num);
  var lab = document.createElementNS(svgNS, 'text');
  lab.setAttribute('x', g.cx);
  lab.setAttribute('y', '77');
  lab.setAttribute('text-anchor', 'middle');
  lab.setAttribute('dominant-baseline', 'central');
  lab.setAttribute('class', 'donut-lab');
  lab.setAttribute('data-label', nAssets === 1 ? 'ASSET' : 'ASSETS');
  lab.textContent = nAssets === 1 ? 'ASSET' : 'ASSETS';
  svg.appendChild(lab);
  host.appendChild(svg);
  heroAllocApply(host);
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
