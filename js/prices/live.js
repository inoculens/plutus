'use strict';
// Live price orchestration: fetchLivePrice (single symbol) and refreshAllPrices
// (batch). Both shapes are established contracts — extend, don't reshape.

var lastPriceErrors = {}; // sym -> short reason for the latest refreshAllPrices run (feeds the error-details popup)

function cachedFreshPrice(sym, cur) {
  var key = priceCacheKey(sym, cur);
  var c = priceCache[key];
  if (c && (Date.now() - c.at) < PRICE_CACHE_TTL_MS && isFinite(Number(c.price)) && Number(c.price) > 0) {
    return Number(c.price);
  }
  return null;
}

// One CoinGecko request for many symbols (ids=csv, vs=main[,usd]). Per-coin
// requests tripped the free-tier rate limit and caused the intermittent
// "unreachable" errors; a single batched call plus one outer retry is far
// more reliable. Resolves {prices, errors}; rejects only on total failure.
function fetchBatchPrices(syms, vs) {
  var cur = String(vs || '').toUpperCase();
  var curLow = cur.toLowerCase();
  var ids = syms.map(function (s) { return SYMBOL_MAP[String(s).toUpperCase()]; });
  var seenIds = dict();
  var uniqIds = [];
  ids.forEach(function (id) { if (id && !seenIds[id]) { seenIds[id] = true; uniqIds.push(id); } });
  var needUsd = curLow !== 'usd'; // bridge for mains CoinGecko doesn't quote (e.g. RON)
  var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
    uniqIds.map(function (id) { return encodeURIComponent(id); }).join(',') +
    '&vs_currencies=' + encodeURIComponent(curLow) + (needUsd ? ',usd' : '');
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  var done = function (prices, errors) { return { prices: prices, errors: errors }; };
  if (!capturedFetch) {
    var off = {}, offE = {};
    syms.forEach(function (s) {
      var c = priceCache[priceCacheKey(s, cur)];
      if (c && isFinite(Number(c.price)) && Number(c.price) > 0) off[s] = Number(c.price);
      else { off[s] = null; offE[s] = 'offline — no cached price'; }
    });
    return Promise.resolve(done(off, offE));
  }
  return fetchWithTimeout(capturedFetch, url).then(function (res) {
    if (!res.ok) throw new Error('price-http-' + res.status);
    return res.json();
  }).then(function (data) {
    var prices = {}, errors = {};
    var usdToCur = null;
    var usdToCurJobs = [];
    syms.forEach(function (s) {
      var id = SYMBOL_MAP[String(s).toUpperCase()];
      var p = data && data[id] && data[id][curLow];
      p = Number(p);
      if (isFinite(p) && p > 0) {
        prices[s] = p;
        priceCache[priceCacheKey(s, cur)] = { price: p, at: Date.now() };
        return;
      }
      if (needUsd) {
        var pu = data && data[id] && data[id].usd;
        pu = Number(pu);
        if (isFinite(pu) && pu > 0) {
          usdToCurJobs.push({ sym: s, usd: pu });
          return;
        }
      }
      prices[s] = null;
      errors[s] = 'no quote returned — try a manual override in Settings';
    });
    if (!usdToCurJobs.length) return done(prices, errors);
    return fetchSpotFxRate(todayStr(), 'USD', cur).then(function (r) {
      usdToCur = Number(r.rate);
      usdToCurJobs.forEach(function (j) {
        var v = j.usd * usdToCur;
        if (isFinite(v) && v > 0) {
          prices[j.sym] = v;
          priceCache[priceCacheKey(j.sym, cur)] = { price: v, at: Date.now() };
        } else {
          prices[j.sym] = null;
          errors[j.sym] = 'currency bridge failed — try a manual override in Settings';
        }
      });
      return done(prices, errors);
    }, function () {
      usdToCurJobs.forEach(function (j) {
        prices[j.sym] = null;
        errors[j.sym] = 'currency bridge unreachable (ECB) — try a manual override in Settings';
      });
      return done(prices, errors);
    });
  });
}

function fetchLivePrice(symbol, vs, kind) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = priceDefaultVs(vs);
  cur = String(cur).trim().toUpperCase();
  if (MAIN_CURRENCIES.indexOf(cur) === -1 && ['USDC', 'USDT', 'DAI'].indexOf(cur) === -1) cur = 'EUR';
  var curLow = String(cur).toLowerCase();
  // (2) Fresh cache (60s) avoids network.
  var key = priceCacheKey(sym, cur);
  var now = Date.now();
  var cached = priceCache[key];
  // (1) Manual override wins — no market network. A legacy bare number is
  // denominated in the requested fiat (old behavior); a fiat-tagged override
  // converts at the CURRENT rate (it stands in for the live price), and
  // resolves unknown — never mislabeled — when conversion fails.
  var ovEntry = null;
  try { ovEntry = priceOverrideEntry(sym, kind); } catch (e) { ovEntry = null; }
  if (ovEntry !== null) {
    if (!ovEntry.vs || ovEntry.vs === cur) return Promise.resolve(ovEntry.price);
    var ovCached = priceCache[key];
    return fetchSpotFxRate(todayStr(), ovEntry.vs, cur).then(function (r) {
      var v = ovEntry.price * Number(r.rate);
      if (!isFinite(v) || v <= 0) {
        if (ovCached && isFinite(Number(ovCached.price)) && Number(ovCached.price) > 0) return Number(ovCached.price);
        return null;
      }
      priceCache[key] = { price: v, at: Date.now() };
      return v;
    }, function () {
      if (ovCached && isFinite(Number(ovCached.price)) && Number(ovCached.price) > 0) return Number(ovCached.price);
      return null;
    });
  }
  var kd = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  if (kd === 'stock') return fetchStockPrice(sym, cur);
  if (kd === 'commodity') return fetchCommodityPrice(sym, cur);
  // Cash in the display fiat is worth 1 by definition — no network, no
  // override needed (a manual override above still wins when set).
  if (kd === 'cash' && sym === cur) {
    priceCache[key] = { price: 1, at: Date.now() };
    return Promise.resolve(1);
  }
  if (kd === 'custom' || kd === 'cash') return Promise.resolve(null);
  // (3a) Unknown ticker: null immediately, never throws, no network.
  var id = SYMBOL_MAP[sym];
  if (!id) return Promise.resolve(null);
  var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
    encodeURIComponent(id) + '&vs_currencies=' + encodeURIComponent(curLow);
  // Hermetic async: capture fetch at call time so a later stub restore
  // cannot clobber this operation's continuation.
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) {
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Promise.resolve(Number(cached.price));
    return Promise.resolve(null);
  }
  var preferredExchangePrice = prefersExchangePrice(sym) ? fetchCryptoFallbackPrice(sym, cur, capturedFetch) : null;
  return fetchWithTimeout(capturedFetch, url).then(function (res) {
    if (!res.ok) throw new Error('price-http-' + res.status);
    return res.json();
  }).then(function (data) {
    var p = data && data[id] && data[id][curLow];
    p = Number(p);
    if (isFinite(p) && p > 0) {
      if (preferredExchangePrice) {
        return preferredExchangePrice.then(function (exchangePrice) {
          exchangePrice = Number(exchangePrice);
          if (isFinite(exchangePrice) && exchangePrice > 0) {
            priceCache[key] = { price: exchangePrice, at: Date.now() };
            return exchangePrice;
          }
          priceCache[key] = { price: p, at: Date.now() };
          return p;
        }, function () {
          priceCache[key] = { price: p, at: Date.now() };
          return p;
        });
      }
      priceCache[key] = { price: p, at: Date.now() };
      return p;
    }
    // Unsupported vs_currency (e.g. RON is absent from CoinGecko's list):
    // bridge via the USD pivot — USD price times live USD->main FX.
    // Cached-or-null fallback preserved below on any failure.
    if (curLow !== 'usd') {
      return fetchLivePrice(sym, 'USD').then(function (pu) {
        pu = Number(pu);
        if (!isFinite(pu) || pu <= 0) {
          if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
          return null;
        }
        return fetchSpotFxRate(todayStr(), 'USD', cur).then(function (r) {
          var bridged = pu * Number(r.rate);
          if (!isFinite(bridged) || bridged <= 0) {
            if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
            return null;
          }
          priceCache[key] = { price: bridged, at: Date.now() };
          return bridged;
        }, function () {
          if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
          return null;
        });
      });
    }
    if (curLow === 'usd') throw new Error('price-missing');
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
    return null;
  }).then(null, function () {
    // CoinGecko error / 429 / bad payload: independent exchange fallbacks,
    // then last cached or null. Never throws.
    return (preferredExchangePrice || fetchCryptoFallbackPrice(sym, cur, capturedFetch)).then(function (fallbackPrice) {
      fallbackPrice = Number(fallbackPrice);
      if (!isFinite(fallbackPrice) || fallbackPrice <= 0) {
        if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
        return null;
      }
      priceCache[key] = { price: fallbackPrice, at: Date.now() };
      return fallbackPrice;
    });
  });
}

// Public entry. Plain tickers resolve exactly as before. Kind-qualified keys
// (STOCK:W, CRYPTO:W -- see "Price identity") are resolved per kind so two
// assets sharing a ticker are fetched, cached and returned separately; the
// result stays one flat object, qualified entries keyed by their KIND:SYM.
function refreshAllPrices(symbols, vs, kinds) {
  var plain = [];
  var groups = {}; // kind -> [sym]
  var qualified = false;
  (symbols || []).forEach(function (s) {
    var up = String(s === undefined || s === null ? '' : s).toUpperCase();
    var parts = splitPriceKey(up);
    if (!parts) { plain.push(s); return; }
    qualified = true;
    if (!groups[parts.kind]) groups[parts.kind] = [];
    if (groups[parts.kind].indexOf(parts.sym) === -1) groups[parts.kind].push(parts.sym);
  });
  if (!qualified) return refreshAllPricesCore(symbols, vs, kinds);
  var merged = {};
  var mergedErrors = {};
  // Sequential: each core run reports its errors through lastPriceErrors.
  var chain = plain.length
    ? refreshAllPricesCore(plain, vs, kinds).then(function (out) {
        Object.keys(out).forEach(function (k) { merged[k] = out[k]; });
        Object.keys(lastPriceErrors).forEach(function (k) { mergedErrors[k] = lastPriceErrors[k]; });
      })
    : Promise.resolve();
  Object.keys(groups).forEach(function (kind) {
    chain = chain.then(function () {
      return refreshAllPricesCore(groups[kind], vs, function () { return kind; }).then(function (out) {
        var errs = lastPriceErrors;
        groups[kind].forEach(function (sym) {
          var key = kind.toUpperCase() + ':' + sym;
          if (Object.prototype.hasOwnProperty.call(out, sym)) merged[key] = out[sym];
          if (errs && errs[sym]) mergedErrors[key] = errs[sym];
        });
      });
    });
  });
  return chain.then(function () { lastPriceErrors = mergedErrors; return merged; });
}

function refreshAllPricesCore(symbols, vs, kinds) {
  var cur = priceDefaultVs(vs);
  var seen = {};
  var uniq = [];
  (symbols || []).forEach(function (s) {
    var sym = String(s || '').toUpperCase();
    if (!sym || seen[sym]) return;
    seen[sym] = true;
    uniq.push(sym);
  });
  function kindFor(sym) {
    if (!kinds) return undefined;
    if (typeof kinds === 'function') { try { return kinds(sym); } catch (e) { return undefined; } }
    if (typeof kinds === 'object') {
      if (Object.prototype.hasOwnProperty.call(kinds, sym)) return kinds[sym];
      var up = String(sym).toUpperCase();
      var ks = Object.keys(kinds);
      for (var i = 0; i < ks.length; i++) if (String(ks[i]).toUpperCase() === up) return kinds[ks[i]];
    }
    return undefined;
  }
  var out = {};
  var errors = {};
  var crypto = [];
  var stocks = [];
  var commodities = [];
  var ovConvJobs = [];
  uniq.forEach(function (sym) {
    // Manual override wins — no market network. Legacy bare numbers are
    // denominated in the requested fiat; fiat-tagged overrides convert at the
    // current rate (or resolve unknown when conversion fails — never
    // mislabeled).
    var ovE = null;
    try { ovE = priceOverrideEntry(sym, kindFor(sym)); } catch (e) { ovE = null; }
    if (ovE !== null) {
      if (!ovE.vs || ovE.vs === cur) { out[sym] = ovE.price; return; }
      ovConvJobs.push({ sym: sym, price: ovE.price, vs: ovE.vs });
      return;
    }
    var kd = (typeof kindFor(sym) === 'string') ? kindFor(sym).trim().toLowerCase() : '';
    if (kd === 'stock') { stocks.push(sym); return; }
    if (kd === 'commodity') {
      if (!hasCommoditySource(sym)) {
        out[sym] = null;
        errors[sym] = 'no live source mapped — add a manual override in Settings';
        return;
      }
      commodities.push(sym);
      return;
    }
    // Cash in the display fiat is worth 1 by definition — no network, no
    // override needed (an override above already won when set).
    if (kd === 'cash' && sym === String(cur).toUpperCase()) { out[sym] = 1; return; }
    if (kd === 'custom' || kd === 'cash') {
      out[sym] = null;
      errors[sym] = 'manual price only — add an override in Settings';
      return;
    }
    if (!SYMBOL_MAP[sym]) {
      out[sym] = null;
      errors[sym] = 'no live source mapped — add a manual override in Settings';
      return;
    }
    var fresh = cachedFreshPrice(sym, cur);
    if (fresh !== null) { out[sym] = fresh; return; }
    crypto.push(sym);
  });
  var jobs = [];
  if (ovConvJobs.length) {
    jobs.push(Promise.all(ovConvJobs.map(function (j) {
      return fetchSpotFxRate(todayStr(), j.vs, cur).then(function (r) {
        var v = j.price * Number(r.rate);
        if (isFinite(v) && v > 0) {
          out[j.sym] = v;
          priceCache[priceCacheKey(j.sym, cur)] = { price: v, at: Date.now() };
        } else {
          out[j.sym] = null;
          errors[j.sym] = 'manual override could not convert to ' + cur + ' — try a manual override in ' + cur + ' under Settings';
        }
        return true;
      }, function () {
        var c = priceCache[priceCacheKey(j.sym, cur)];
        if (c && isFinite(Number(c.price)) && Number(c.price) > 0) out[j.sym] = Number(c.price);
        else {
          out[j.sym] = null;
          errors[j.sym] = 'manual override unreachable in ' + cur + ' (ECB) — try a manual override in ' + cur + ' under Settings';
        }
        return false;
      });
    })).then(function () { /* mapped into out/errors above */ }));
  }
  if (crypto.length) {
    var cryptoFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
    var preferredExchangePrices = {};
    crypto.forEach(function (sym) {
      if (prefersExchangePrice(sym)) preferredExchangePrices[sym] = fetchCryptoFallbackPrice(sym, cur, cryptoFetch);
    });
    function useCryptoFallbacks(failureMessage) {
      return Promise.all(crypto.map(function (sym) {
        var preferred = preferredExchangePrices[sym];
        if (!preferred && isFinite(Number(out[sym])) && Number(out[sym]) > 0) return Promise.resolve();
        return (preferred || fetchCryptoFallbackPrice(sym, cur, cryptoFetch)).then(function (price) {
          if (isFinite(Number(price)) && Number(price) > 0) {
            out[sym] = Number(price);
            delete errors[sym];
            priceCache[priceCacheKey(sym, cur)] = { price: Number(price), at: Date.now() };
            return;
          }
          var c = priceCache[priceCacheKey(sym, cur)];
          if (c && isFinite(Number(c.price)) && Number(c.price) > 0) {
            out[sym] = Number(c.price);
            delete errors[sym];
          } else {
            out[sym] = null;
            errors[sym] = errors[sym] || failureMessage;
          }
        });
      }));
    }
    jobs.push(fetchBatchPrices(crypto, cur).then(function (res) {
      Object.keys(res.prices).forEach(function (k) { out[k] = res.prices[k]; });
      Object.keys(res.errors).forEach(function (k) { errors[k] = res.errors[k]; });
      return useCryptoFallbacks('no live exchange quote — try a manual override in Settings');
    }, function () {
      return useCryptoFallbacks('CoinGecko and live exchange requests failed');
    }));
  }
  if (stocks.length) {
    // First resolve verified tokenized-equity markets directly, independent
    // of Yahoo/proxy infrastructure. Only misses proceed to the batched CNBC
    // quote and the legacy Yahoo fallback.
    var stockFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
    var exchangeJobs = stocks.map(function (sym) {
      return fetchStockExchangeUsd(sym, stockFetch).then(function (usd) {
        if (!isFinite(Number(usd)) || Number(usd) <= 0) return;
        return convertStockQuote(sym, usd, 'USD', cur).then(function (price) {
          if (isFinite(Number(price)) && Number(price) > 0) out[sym] = Number(price);
        });
      });
    });
    jobs.push(Promise.all(exchangeJobs).then(function () {
      var missing = stocks.filter(function (sym) {
        return !(isFinite(Number(out[sym])) && Number(out[sym]) > 0);
      });
      return fetchBatchCnbc(missing, stockFetch).then(function (map) {
        var per = missing.map(function (sym) {
          var q = map && map[sym];
          var quote = q
            ? convertStockQuote(sym, q.price, q.currency, cur)
            : fetchStockYahoo(sym, cur, stockFetch);
          return quote.then(function (price) {
            if (isFinite(Number(price)) && Number(price) > 0) {
              out[sym] = Number(price);
              delete errors[sym];
              return;
            }
            var cachedStock = priceCache[priceCacheKey('STOCK:' + sym, cur)];
            if (cachedStock && isFinite(Number(cachedStock.price)) && Number(cachedStock.price) > 0) {
              out[sym] = Number(cachedStock.price);
              delete errors[sym];
            } else {
              out[sym] = null;
              errors[sym] = 'stock feed unreachable — try a manual override in Settings';
            }
          });
        });
        return Promise.all(per).then(function () { /* mapped into out/errors above */ });
      });
    }));
  }
  commodities.forEach(function (sym) {
    jobs.push(fetchLivePrice(sym, cur, 'commodity').then(function (p) {
      if (isFinite(Number(p)) && Number(p) > 0) out[sym] = Number(p);
      else { out[sym] = null; errors[sym] = 'commodity feed unreachable — try a manual override in Settings'; }
    }));
  });
  return Promise.all(jobs).then(function () { lastPriceErrors = errors; return out; });
}
