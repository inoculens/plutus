'use strict';
// Asset colors for the hero allocation ring. Each ring segment is one asset;
// its color comes from the accounts that hold it:
//   1. accounts with a color set: the most used color wins; a tie picks one
//      of the tied colors by a stable hash, so the ring never flickers
//      between repaints;
//   2. no account colored: a color that belongs to the name — a known brand
//      or asset word in the account name (Binance, Bitcoin, Gold, …), then
//      the asset's own brand color (BTC orange, EUR blue, …), then a generic
//      word (Savings, Pension, …), then a vivid hue derived from the account
//      name itself (the same name always gets the same color);
//   3. automatic colors are nudged apart so neighbouring assets never look
//      alike. A color the owner picked is never changed.
// Everything here is static lookup + arithmetic: no network, no AI.

// Brand / asset colors, tuned to read clearly on matte black.
var ALLOC_TICKER_COLORS = {
  BTC: '#F7931A', WBTC: '#F7931A', ETH: '#7B8CF5', WETH: '#7B8CF5', STETH: '#7B8CF5',
  SOL: '#A35CFF', USDT: '#26C29A', USDC: '#3B8EEA', DAI: '#F5AC37', BNB: '#F3BA2F',
  XRP: '#4BA3F0', ADA: '#3D6FF2', DOGE: '#D4B23C', DOT: '#E6007A', AVAX: '#E84142',
  LINK: '#4C7BF0', MATIC: '#8F5BEA', POL: '#8F5BEA', LTC: '#7DA2DE', TRX: '#EB3A3E',
  ATOM: '#8C90B8', XMR: '#FF6A13', TON: '#1FA5EE', SHIB: '#FFA409', XLM: '#8E7CF2',
  NEAR: '#4FD1A1', ARB: '#2D9CDB', OP: '#FF2E41', SUI: '#4DA2FF', APT: '#3DD6B5',
  UNI: '#FF4FB8', AAVE: '#B877D9', ALGO: '#9AA0A6', XTZ: '#3C7DFF', PEPE: '#4DB33D',
  EUR: '#3D7BF5', USD: '#2FB57E', GBP: '#D9485F', CHF: '#E5484D', JPY: '#E8505B',
  RON: '#F2C744', PLN: '#E0475A', HUF: '#43A36B', CAD: '#E5484D', AUD: '#F5B841',
  XAU: '#E6B422', GOLD: '#E6B422', PAXG: '#E6B422', XAUT: '#E6B422',
  XAG: '#C3CAD5', SILVER: '#C3CAD5', XPT: '#B9C4CF',
  AAPL: '#B6BCC2', TSLA: '#E82127', NVDA: '#76B900', MSFT: '#22A6F0', GOOGL: '#4285F4',
  GOOG: '#4285F4', AMZN: '#FF9900', META: '#2F8BFB', NFLX: '#E50914', AMD: '#E9563B'
};

// Words that may appear in an account name. Longest match wins, so
// "crypto.com" beats "crypto" and "bitcoin cash" can be added later.
var ALLOC_NAME_COLORS = {
  bitcoin: '#F7931A', btc: '#F7931A', ethereum: '#7B8CF5', ether: '#7B8CF5', eth: '#7B8CF5',
  solana: '#A35CFF', tether: '#26C29A', cardano: '#3D6FF2', dogecoin: '#D4B23C',
  polkadot: '#E6007A', avalanche: '#E84142', chainlink: '#4C7BF0', litecoin: '#7DA2DE',
  monero: '#FF6A13', ripple: '#4BA3F0', polygon: '#8F5BEA',
  gold: '#E6B422', silver: '#C3CAD5', platinum: '#B9C4CF',
  euro: '#3D7BF5', dollar: '#2FB57E', pound: '#D9485F', franc: '#E5484D', yen: '#E8505B', leu: '#F2C744', lei: '#F2C744',
  binance: '#F3BA2F', coinbase: '#3D6DF5', kraken: '#8B5CF6', bybit: '#F7A600', bitget: '#1FC7D4',
  kucoin: '#23AF91', 'crypto.com': '#1199FA', gemini: '#2DD4D4', bitstamp: '#3FB86A', bitpanda: '#2FC386',
  metamask: '#F6851B', phantom: '#AB9FF2', trezor: '#3CB371', ledger: '#9AA3AD', exodus: '#8B6CF6',
  revolut: '#6B7BFF', wise: '#9FE870', n26: '#36A18B', paypal: '#2D8CFF', monzo: '#FF5A5F',
  'trading 212': '#33B5E5', trading212: '#33B5E5', etoro: '#66C430', degiro: '#18A0FB',
  'interactive brokers': '#E5484D', ibkr: '#E5484D', robinhood: '#33D05A', xtb: '#E5484D',
  vanguard: '#C4314B', fidelity: '#4AA564', schwab: '#2FA4E7', ing: '#FF6200'
};

// Generic words say less than the asset itself: they only count when the
// ticker has no color of its own ("Cash" in EUR stays euro blue).
var ALLOC_GENERIC_NAME_COLORS = {
  savings: '#4FB3A9', pension: '#A995E8', cash: '#5FB98E', wallet: '#78AEE0',
  emergency: '#F08A4B', retirement: '#A995E8', stocks: '#4C9AFF', crypto: '#8B6CF6'
};

function allocNormHex(hex) {
  var h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return /^[0-9a-fA-F]{6}$/.test(h) ? '#' + h.toUpperCase() : null;
}

// FNV-1a: small, fast and stable across browsers.
function allocHash(s) {
  var h = 0x811c9dc5;
  var str = String(s || '');
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul ? Math.imul(h, 0x01000193) : (h * 0x01000193) | 0;
  }
  return h >>> 0;
}

function allocHexToHsl(hex) {
  var n = allocNormHex(hex) || '#888888';
  var r = parseInt(n.slice(1, 3), 16) / 255;
  var g = parseInt(n.slice(3, 5), 16) / 255;
  var b = parseInt(n.slice(5, 7), 16) / 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  var l = (mx + mn) / 2, h = 0, s = 0;
  if (mx !== mn) {
    var d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: h, s: s, l: l };
}

function allocHslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  var c = (1 - Math.abs(2 * l - 1)) * s;
  var x = c * (1 - Math.abs((h / 60) % 2 - 1));
  var m = l - c / 2;
  var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + rgb.map(function (v) {
    var t = Math.round((v + m) * 255).toString(16);
    return t.length === 1 ? '0' + t : t;
  }).join('').toUpperCase();
}

// A vivid hue from any text. Mid lightness + high saturation: never the
// washed pastels or the near-whites the old fixed palette produced.
function allocHashColor(text) {
  var h = allocHash(String(text || '').trim().toLowerCase());
  // Skip the loss red and gain green bands: a made-up color must never read
  // as a P&L signal. (Brand colors keep their own hue.)
  var span = 360 - 27 - 38;
  var hue = 12 + (h % span);              // starts past red (345–12)
  if (hue >= 128) hue += 38;              // jumps the green band (128–165)
  var sat = 0.68 + ((h >>> 9) % 15) / 100;   // 0.68–0.82
  var lig = 0.56 + ((h >>> 17) % 9) / 100;   // 0.56–0.64
  return allocHslToHex(hue, sat, lig);
}

function allocNameColor(name, table) {
  var words = table || ALLOC_NAME_COLORS;
  var n = ' ' + String(name || '').toLowerCase().replace(/[_\-]+/g, ' ') + ' ';
  var best = null, bestLen = 0;
  Object.keys(words).forEach(function (w) {
    if (w.length <= bestLen) return;
    // Whole words only: "eth" must not fire inside "method".
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])').test(n)) { best = words[w]; bestLen = w.length; }
  });
  return best;
}

// A color the owner picked stays theirs; only one so dark it would vanish
// into the black panel is lifted just enough to be seen.
function allocVisible(hex) {
  var c = allocHexToHsl(hex);
  if (c.l >= 0.3) return allocNormHex(hex);
  return allocHslToHex(c.h, c.s, 0.3);
}

function allocTooClose(a, b) {
  var x = allocHexToHsl(a), y = allocHexToHsl(b);
  var dl = Math.abs(x.l - y.l);
  if (x.s < 0.2 || y.s < 0.2) return x.s < 0.2 && y.s < 0.2 && dl < 0.12;
  var dh = Math.abs(x.h - y.h);
  if (dh > 180) dh = 360 - dh;
  return dh < 12 && dl < 0.12;
}

// items: [{ symbol, accounts: [{ name, color, value }] }] in ring order.
// Returns one '#RRGGBB' per item.
function resolveAllocColors(items) {
  var out = [];
  var auto = [];
  (items || []).forEach(function (it, idx) {
    var accs = (it && it.accounts) || [];
    var counts = {}, order = [];
    accs.forEach(function (a) {
      var c = allocNormHex(a && a.color);
      if (!c) return;
      if (!counts[c]) { counts[c] = 0; order.push(c); }
      counts[c]++;
    });
    if (order.length) {
      var top = 0;
      order.forEach(function (c) { if (counts[c] > top) top = counts[c]; });
      var tied = order.filter(function (c) { return counts[c] === top; }).sort();
      var pick = tied[allocHash(String(it.symbol) + '|' + tied.join(',')) % tied.length];
      out[idx] = allocVisible(pick);
      auto[idx] = false;
      return;
    }
    // Largest holding first: its name speaks for the asset.
    var byValue = accs.slice().sort(function (a, b) { return (b.value || 0) - (a.value || 0); });
    var c2 = null;
    for (var i = 0; i < byValue.length && !c2; i++) c2 = allocNameColor(byValue[i].name);
    if (!c2) c2 = ALLOC_TICKER_COLORS[String(it.symbol || '').toUpperCase()] || null;
    for (var j = 0; j < byValue.length && !c2; j++) c2 = allocNameColor(byValue[j].name, ALLOC_GENERIC_NAME_COLORS);
    if (!c2) c2 = allocHashColor((byValue[0] && byValue[0].name) || it.symbol);
    out[idx] = c2;
    auto[idx] = true;
  });
  // Keep automatic colors apart from every color already on the ring: try a
  // lighter / darker shade of the same hue first, then small hue steps, so
  // gold stays gold rather than jumping to an unrelated color.
  var steps = [[0, 0.14], [0, -0.14], [14, 0], [-14, 0], [14, 0.12], [-14, -0.12],
    [30, 0], [-30, 0], [60, 0], [-60, 0], [110, 0], [-110, 0], [180, 0]];
  for (var k = 0; k < out.length; k++) {
    if (!auto[k]) continue;
    var others = out.filter(function (c, j) { return j !== k && (j < k || !auto[j]); });
    var clash = function (c) { return others.some(function (o) { return allocTooClose(c, o); }); };
    if (!clash(out[k])) continue;
    var base = allocHexToHsl(out[k]);
    var sat = Math.max(base.s, 0.6), lig = Math.min(Math.max(base.l, 0.48), 0.64);
    for (var s = 0; s < steps.length; s++) {
      var cand = allocHslToHex(base.h + steps[s][0], sat, Math.min(0.76, Math.max(0.4, lig + steps[s][1])));
      if (!clash(cand)) { out[k] = cand; break; }
    }
  }
  return out;
}
