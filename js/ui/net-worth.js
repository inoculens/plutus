'use strict';
// Net worth history data: decides which accounts and dates the chart covers,
// fetches historical price and FX series (cached), and builds the series the
// chart component (net-worth-chart.js) draws.

function netWorthHistoryDate(timestamp) {
  var d = new Date(timestamp);
  var month = String(d.getMonth() + 1);
  var day = String(d.getDate());
  return d.getFullYear() + '-' + (month.length < 2 ? '0' : '') + month + '-' + (day.length < 2 ? '0' : '') + day;
}

function netWorthHistorySignature(st) {
  // chartPointsModel: bumped when saved chart points must be rebuilt. 2 drops
  // the saw-tooth points that earlier loads left interleaved in the store; 3
  // drops points valued with copied fiat rates (see fetchNetWorthHistoryRate).
  return JSON.stringify({
    debtSnapshotModel: 2,
    chartPointsModel: 3,
    accounts: st.accounts || [],
    trades: st.trades || [],
    priceOverrides: st.priceOverrides || {},
    mainCurrency: st.settings.mainCurrency,
    costMethod: st.settings.costMethod,
    accountFilter: st.settings.accountFilter
  });
}

function netWorthHistoryKinds(st) {
  var kinds = {};
  (st.accounts || []).forEach(function (account) {
    if (account && account.ticker && account.kind) kinds[String(account.ticker).toUpperCase()] = account.kind;
  });
  (st.trades || []).forEach(function (trade) {
    if (!trade || !trade.symbol) return;
    var account = accountById(st, trade.accountId);
    if (account && account.kind) kinds[String(trade.symbol).toUpperCase()] = account.kind;
  });
  (st.accounts || []).forEach(function (account) {
    accountBalancePositions(account).forEach(function (position) {
      var ticker = String(position.assetTicker || account.ticker || '').trim().toUpperCase();
      if (ticker) kinds[ticker] = position.assetKind || account.kind || 'crypto';
    });
  });
  return kinds;
}

function netWorthHistoryIncludedAccounts(st) {
  var filter = selectedTickers(st);
  var included = dict();
  (st.accounts || []).forEach(function (account) {
    if (!account || (filter !== null && filter.indexOf(String(account.ticker || '').toUpperCase()) === -1)) return;
    included[account.id] = true;
    groupMembers(st, account.id).forEach(function (member) { included[member.id] = true; });
  });
  return included;
}

function mergeNetWorthHistoryWindows(windows) {
  var sorted = (Array.isArray(windows) ? windows : []).filter(function (window) {
    return window && isFinite(Number(window.from)) &&
      (isFinite(Number(window.to)) || window.to === Infinity) &&
      Number(window.to) >= Number(window.from);
  }).map(function (window) {
    return { from: Number(window.from), to: window.to === Infinity ? Infinity : Number(window.to) };
  }).sort(function (a, b) {
    return a.from - b.from || a.to - b.to;
  });
  var merged = [];
  sorted.forEach(function (window) {
    var last = merged[merged.length - 1];
    if (!last || window.from > last.to) {
      merged.push({ from: window.from, to: window.to });
    } else if (window.to > last.to) {
      last.to = window.to;
    }
  });
  return merged;
}

// Return intervals in which the last reported total balance is positive.
// These intervals only decide when market history is needed; they never
// alter a balance or derive interest between snapshots.
function debtPositionPositiveBalanceWindows(position) {
  var snapshots = (position && Array.isArray(position.balanceSnapshots))
    ? position.balanceSnapshots.map(function (snapshot, index) {
      return { snapshot: snapshot, index: index, at: Date.parse(snapshot.reportedAt) };
    }).filter(function (item) { return isFinite(item.at); }).sort(function (a, b) {
      return a.at - b.at || a.index - b.index;
    })
    : [];
  var windows = [];
  snapshots.forEach(function (item, index) {
    if (!(Number(item.snapshot.amount) > 0)) return;
    var next = snapshots[index + 1];
    var end = next ? next.at : Infinity;
    if (end > item.at) windows.push({ from: item.at, to: end });
  });
  return mergeNetWorthHistoryWindows(windows);
}

function netWorthHistoryStart(st, included) {
  var earliest = Infinity;
  (st.trades || []).forEach(function (trade) {
    if (!trade || !included[trade.accountId] || typeof trade.date !== 'string') return;
    var timestamp = Date.parse(trade.date + 'T00:00:00');
    if (isFinite(timestamp) && timestamp < earliest) earliest = timestamp;
  });
  (st.accounts || []).forEach(function (account) {
    if (!account || !included[account.id]) return;
    accountBalancePositions(account).forEach(function (position) {
      (position.balanceSnapshots || []).forEach(function (snapshot) {
        var timestamp = Date.parse(snapshot.reportedAt);
        if (isFinite(timestamp) && timestamp < earliest) earliest = timestamp;
      });
    });
  });
  return isFinite(earliest) ? earliest : null;
}

var netWorthHistoryFetches = {};
var netWorthHistoryFailures = {};
var netWorthHistoryFetchBudget = { signature: '', remaining: 0 };
var NET_WORTH_LOADING_BANNER = 'Loading historical chart prices — the graph may be incomplete.';
var netWorthHistoryLoadingBannerShown = false;
var netWorthHistorySeriesCache = {};
// In-memory ceiling: a tab left open while ranges and symbols change would
// otherwise keep every series ever fetched. The oldest entries go first; they
// are re-derivable from the shared archive or the providers.
var NETWORTH_SERIES_CACHE_MAX = 200;
function netWorthSeriesCachePrune() {
  var keys = Object.keys(netWorthHistorySeriesCache);
  if (keys.length <= NETWORTH_SERIES_CACHE_MAX) return;
  keys.sort(function (a, b) {
    return (Number(netWorthHistorySeriesCache[a] && netWorthHistorySeriesCache[a].at) || 0) -
      (Number(netWorthHistorySeriesCache[b] && netWorthHistorySeriesCache[b].at) || 0);
  });
  keys.slice(0, keys.length - NETWORTH_SERIES_CACHE_MAX).forEach(function (k) { delete netWorthHistorySeriesCache[k]; });
}
var netWorthHistoryRateFetches = {};
var priceDataStartupPromise = Promise.resolve();

function netWorthHistorySeriesCovers(series, start, end) {
  if (!series || !Array.isArray(series.points) || !series.points.length) return false;
  var maxStale = (series.kind === 'crypto' ? 1.5 : 5) * 86400000;
  var maxLookahead = 36 * 60 * 60 * 1000;
  var previous = null;
  for (var i = 0; i < series.points.length; i++) {
    var point = series.points[i];
    if (!point || !isFinite(Number(point.at)) || !isFinite(Number(point.price)) || Number(point.price) <= 0) continue;
    var at = Number(point.at);
    if (at <= start) {
      previous = at;
      continue;
    }
    if (at > end) {
      if (previous === null) return at - start <= maxLookahead && at - end <= maxLookahead;
      break;
    }
    if (previous === null) {
      if (at - start > maxLookahead) return false;
    } else if (at - previous > maxStale) {
      return false;
    }
    previous = at;
  }
  return previous !== null && end - previous <= maxStale;
}

function netWorthHistoryCompleteSeries(series) {
  if (!series.error) return series;
  return {
    currency: series.currency,
    kind: series.kind,
    points: series.points
  };
}

function findReusableNetWorthHistorySeries(symbol, kind, currency, start, end) {
  var best = null;
  var bestSpan = Infinity;
  // Shared series are historical data; coverage and point gaps, not file age,
  // determine whether they can serve a requested interval.
  Object.keys(netWorthHistorySeriesCache).forEach(function (key) {
    var parts = key.split('|');
    if (parts.length !== 5 || parts[0] !== symbol || parts[1] !== kind || parts[2] !== currency) return;
    var cached = netWorthHistorySeriesCache[key];
    if (!cached || !cached.series || !cached.series.points || !cached.series.points.length ||
        !(Date.now() - cached.at < 5 * 60 * 1000 || cached.shared) ||
        cached.series.kind !== kind ||
        !netWorthHistorySeriesCovers(cached.series, start, end)) return;
    var span = Number(parts[4]) - Number(parts[3]);
    if (!isFinite(span)) span = Infinity;
    if (!best || span < bestSpan || (span === bestSpan && cached.at > best.at)) {
      best = cached;
      bestSpan = span;
    }
  });
  return best ? {
    at: best.at,
    shared: best.shared,
    series: netWorthHistoryCompleteSeries(best.series)
  } : null;
}

function netWorthHistoryCachedSeriesPoints(symbol, kind, currency) {
  var byTime = {};
  Object.keys(netWorthHistorySeriesCache).forEach(function (key) {
    var parts = key.split('|');
    if (parts.length !== 5 || parts[0] !== symbol || parts[1] !== kind || parts[2] !== currency) return;
    var cached = netWorthHistorySeriesCache[key];
    if (!cached || !cached.series || !Array.isArray(cached.series.points) ||
        !(Date.now() - cached.at < 5 * 60 * 1000 || cached.shared)) return;
    cached.series.points.forEach(function (point) {
      if (!point || !isFinite(Number(point.at)) || !isFinite(Number(point.price)) || Number(point.price) <= 0) return;
      var time = String(Number(point.at));
      var prior = byTime[time];
      if (!prior || Number(cached.at) >= Number(prior.cacheAt)) {
        byTime[time] = {
          point: {
            at: Number(point.at),
            price: Number(point.price),
            currency: String(point.currency || cached.series.currency || currency).toUpperCase()
          },
          cacheAt: Number(cached.at) || 0
        };
      }
    });
  });
  return Object.keys(byTime).map(function (time) { return byTime[time].point; })
    .sort(function (a, b) { return a.at - b.at; });
}

// Public daily crypto archive generated by GitHub Actions on the dedicated
// market-history branch. The browser fetches this static JSON directly from
// GitHub, avoiding third-party market-data APIs for covered long-range history.
var netWorthPublicArchivePromise = null;
function fetchPlutusDailyCryptoSeries(symbol, start, end) {
  if (typeof window === 'undefined' || !window.fetch) {
    return Promise.reject(new Error('Plutus market archive is unavailable'));
  }
  if (!netWorthPublicArchivePromise) {
    netWorthPublicArchivePromise = fetchWithTimeout(
      window.fetch.bind(window), 'https://raw.githubusercontent.com/inoculens/plutus/market-history/market-history/daily.json', 20000
    ).then(function (response) {
      if (!response || !response.ok) throw new Error('Plutus market archive HTTP ' + (response && response.status));
      return response.json();
    }).then(function (archive) {
      if (!archive || Number(archive.schema) !== 1 || !archive.assets || typeof archive.assets !== 'object') {
        throw new Error('Plutus market archive has an unsupported format');
      }
      return archive;
    }).then(null, function (error) {
      netWorthPublicArchivePromise = null;
      throw error;
    });
  }
  return netWorthPublicArchivePromise.then(function (archive) {
    var asset = archive.assets[String(symbol || '').toUpperCase()];
    var rows = asset && Array.isArray(asset.points) ? asset.points : [];
    var from = Number(start) - 2 * 86400000;
    var to = Number(end) + 2 * 86400000;
    var points = rows.filter(function (row) {
      return Array.isArray(row) && isFinite(Number(row[0])) &&
        isFinite(Number(row[1])) && Number(row[1]) > 0 &&
        Number(row[0]) >= from && Number(row[0]) <= to;
    }).map(function (row) {
      return { at: Number(row[0]), price: Number(row[1]), currency: 'USD' };
    });
    if (!points.length) throw new Error('Plutus archive has no daily history for ' + symbol);
    points.sort(function (a, b) { return a.at - b.at; });
    return { currency: 'USD', points: points, kind: 'crypto' };
  });
}

function fetchNetWorthHistorySeries(symbol, kind, main, start, end, onProgress) {
  var sym = String(symbol || '').toUpperCase();
  var currency = String(main || '').toUpperCase();
  var startSec = Math.floor(start / 1000);
  var endSec = Math.ceil(end / 1000);
  var queryStart = startSec;
  var queryEnd = endSec;
  if (end - start <= 7 * 86400000) {
    queryStart -= 3600;
    queryEnd += 3600;
  }
  var startDay = new Date(start).toISOString().slice(0, 10);
  var endDay = new Date(end).toISOString().slice(0, 10);
  var cacheKey = [sym, kind, currency, Math.floor(queryStart / 300), Math.floor(queryEnd / 300)].join('|');
  var cached = netWorthHistorySeriesCache[cacheKey];
  if (cached && (Date.now() - cached.at < 5 * 60 * 1000 || cached.shared) &&
      netWorthHistorySeriesCovers(cached.series, queryStart * 1000, queryEnd * 1000)) {
    return Promise.resolve(netWorthHistoryCompleteSeries(cached.series));
  }
  cached = findReusableNetWorthHistorySeries(sym, kind, currency, queryStart * 1000, queryEnd * 1000);
  if (cached) return Promise.resolve(cached.series);
  var cachedPoints = netWorthHistoryCachedSeriesPoints(sym, kind, currency);

  function report(provider, completed, total, chunk, phase, error, attempt) {
    if (typeof onProgress !== 'function') return;
    onProgress({
      phase: phase || 'download',
      symbol: sym,
      provider: provider,
      completed: completed,
      total: total,
      attempt: attempt || 1,
      error: error ? String(error.message || error) : '',
      assetStart: start,
      assetEnd: end,
      start: chunk ? chunk.start * 1000 : start,
      end: chunk ? chunk.end * 1000 : end
    });
  }
  function makeChunks(from, to, chunkDays) {
    var chunkSeconds = chunkDays * 86400;
    var chunks = [];
    for (var cursor = from; cursor < to;) {
      var chunkEnd = Math.min(to, cursor + chunkSeconds);
      chunks.push({ start: cursor, end: chunkEnd });
      cursor = chunkEnd;
    }
    return chunks;
  }
  function fetchChunks(chunks, provider, fetchChunk) {
    var points = cachedPoints.slice();
    var errors = [];
    var currencyCode = currency;
    function chunkCached(chunk) {
      return netWorthHistorySeriesCovers(
        { kind: kind, points: points },
        chunk.start * 1000,
        chunk.end * 1000
      );
    }
    function next(index) {
      if (index >= chunks.length) {
        if (!points.length) {
          return Promise.reject(new Error(errors.join('; ') || provider + ' returned no prices'));
        }
        var uniquePoints = {};
        points.forEach(function (point) {
          var pointCurrency = String(point.currency || currencyCode).toUpperCase();
          var key = String(point.at);
          if (!Object.prototype.hasOwnProperty.call(uniquePoints, key)) {
            uniquePoints[key] = {
              at: point.at,
              price: point.price,
              currency: pointCurrency
            };
          }
        });
        return Promise.resolve({
          currency: currencyCode,
          points: Object.keys(uniquePoints).map(function (key) { return uniquePoints[key]; }),
          error: errors.length ? errors.join('; ').slice(0, 800) : ''
        });
      }
      var chunk = chunks[index];
      if (chunkCached(chunk)) {
        report(provider, index + 1, chunks.length, chunk, 'cache');
        return next(index + 1);
      }
      report(provider, index, chunks.length, chunk);
      function fetchWithRetry(attempt) {
        return fetchChunk(chunk).then(function (result) {
          if (!result.points.length) throw new Error(provider + ' returned no prices for this chunk');
          result.points.sort(function (a, b) { return a.at - b.at; });
          var first = result.points[0].at;
          var last = result.points[result.points.length - 1].at;
          var tolerance = Math.min(48 * 60 * 60 * 1000, (chunk.end - chunk.start) * 250);
          if (chunk.end - chunk.start > 2 * 86400 &&
              (first > chunk.start * 1000 + tolerance || last < chunk.end * 1000 - tolerance)) {
            throw new Error(provider + ' returned partial history for this chunk');
          }
          return result;
        }).then(null, function (error) {
          if (attempt < 2) {
            report(provider, index, chunks.length, chunk, 'retry', error, attempt + 1);
            return new Promise(function (resolve) { setTimeout(resolve, 750); })
              .then(function () { return fetchWithRetry(attempt + 1); });
          }
          throw error;
        });
      }
      return fetchWithRetry(1).then(function (result) {
        points = points.concat(result.points);
        currencyCode = result.currency || currencyCode;
        report(provider, index + 1, chunks.length, chunk);
        return next(index + 1);
      }, function (error) {
        report(provider, index, chunks.length, chunk, 'download-error', error, 2);
        errors.push(provider + ' ' + new Date(chunk.start * 1000).toISOString().slice(0, 10) +
          ': ' + String(error && error.message ? error.message : error));
        return next(index + 1);
      });
    }
    return next(0);
  }
  var request;
  if (SYMBOL_MAP[sym]) {
    function fetchCoinGeckoSeries(vs) {
      var chunks = makeChunks(queryStart, queryEnd, 180);
      return fetchChunks(chunks, 'CoinGecko (' + vs.toUpperCase() + ')', function (chunk) {
        var url = 'https://api.coingecko.com/api/v3/coins/' + encodeURIComponent(SYMBOL_MAP[sym]) +
          '/market_chart/range?vs_currency=' + encodeURIComponent(vs.toLowerCase()) +
          '&from=' + chunk.start + '&to=' + chunk.end;
        // Try the browser's direct route first, then two independent CORS
        // relays. VPN exit nodes and regional IP ranges are sometimes
        // throttled or blocked by CoinGecko even when the API is healthy.
        // These relays are already allowed by the site's connect-src policy.
        var urls = [
          url,
          'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
          'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url)
        ];
        return fetchFirstJson(urls, window.fetch.bind(window)).then(function (data) {
          var prices = data && Array.isArray(data.prices) ? data.prices : [];
          var points = prices.filter(function (row) {
            return Array.isArray(row) && isFinite(Number(row[0])) && isFinite(Number(row[1])) && Number(row[1]) > 0;
          }).map(function (row) { return { at: Number(row[0]), price: Number(row[1]), currency: vs }; });
          return { currency: vs, points: points };
        });
      });
    }
    function fetchCoinbaseSeries() {
      if (COINBASE_SYMBOLS.indexOf(sym) === -1) return Promise.reject(new Error('long-range market data unavailable'));
      var fiat = currency === 'EUR' || currency === 'GBP' ? currency : 'USD';
      var chunkDays = 280;
      var chunks = [];
      var cursor = queryStart;
      while (cursor < queryEnd) {
        var chunkEnd = Math.min(queryEnd, cursor + chunkDays * 86400);
        chunks.push({ start: cursor, end: chunkEnd });
        cursor = chunkEnd;
      }
      return fetchChunks(chunks, 'Coinbase (' + fiat + ')', function (chunk) {
        var url = 'https://api.exchange.coinbase.com/products/' + encodeURIComponent(sym + '-' + fiat) +
          '/candles?start=' + encodeURIComponent(new Date(chunk.start * 1000).toISOString()) +
          '&end=' + encodeURIComponent(new Date(chunk.end * 1000).toISOString()) + '&granularity=86400';
        return fetchWithTimeout(window.fetch.bind(window), url).then(function (response) {
          if (!response.ok) throw new Error('market data HTTP ' + response.status);
          return response.json();
        }).then(function (rows) {
          var points = [];
          if (Array.isArray(rows)) {
            rows.forEach(function (row) {
            if (!Array.isArray(row) || !isFinite(Number(row[0])) || !isFinite(Number(row[4])) || Number(row[4]) <= 0) return;
              points.push({ at: Number(row[0]) * 1000, price: Number(row[4]), currency: fiat });
            });
          }
          return { currency: fiat, points: points };
        });
      }).then(function (series) {
        if (!series.points.length) throw new Error('market provider returned no prices');
        return series;
      });
    }
    function fetchYahooCryptoSeries(symbolCurrency) {
      var yahooCrypto = sym + '-' + symbolCurrency;
      var interval = end - start <= 7 * 86400000 ? '60m' : '1d';
      var chunks = interval === '60m' ? [{ start: queryStart, end: queryEnd }] : makeChunks(queryStart, queryEnd, 180);
      return fetchChunks(chunks, 'Yahoo Finance (' + symbolCurrency + ')', function (chunk) {
        var query = 'period1=' + chunk.start + '&period2=' + chunk.end + '&interval=' + interval;
        return fetchFirstJson(yahooProxyUrls(yahooCrypto, query), window.fetch.bind(window)).then(function (data) {
        var result = data && data.chart && data.chart.result && data.chart.result[0];
        if (!result) throw new Error('Yahoo Finance has no history for ' + yahooCrypto);
        var timestamps = result.timestamp || [];
        var quotes = result.indicators && result.indicators.quote && result.indicators.quote[0];
        var closes = quotes && quotes.close ? quotes.close : [];
        var resultCurrency = String((result.meta && result.meta.currency) || symbolCurrency).toUpperCase();
        var points = [];
        for (var i = 0; i < timestamps.length; i++) {
          var price = Number(closes[i]);
          if (isFinite(price) && price > 0) {
            points.push({ at: Number(timestamps[i]) * 1000, price: price, currency: resultCurrency });
          }
        }
        return { currency: resultCurrency, points: points };
        });
      });
    }
    function mergeSeries(first, second) {
      if (!first) return second;
      if (!second) return first;
      var pointsByKey = {};
      first.points.concat(second.points).forEach(function (point) {
        var pointCurrency = String(point.currency || first.currency || currency).toUpperCase();
        var key = String(point.at);
        if (!Object.prototype.hasOwnProperty.call(pointsByKey, key)) {
          pointsByKey[key] = {
            at: point.at,
            price: point.price,
            currency: pointCurrency
          };
        }
      });
      var errors = [];
      [first.error, second.error].forEach(function (error) {
        if (error && errors.indexOf(error) === -1) errors.push(error);
      });
      return {
        currency: first.currency || second.currency || currency,
        points: Object.keys(pointsByKey).map(function (key) { return pointsByKey[key]; }),
        error: errors.join('; ').slice(0, 800)
      };
    }
    function hasFullCoverage(series) {
      if (!series || !series.points.length) return false;
      series.points.sort(function (a, b) { return a.at - b.at; });
      var tolerance = 48 * 60 * 60 * 1000;
      var maxGap = 36 * 60 * 60 * 1000;
      if (series.points[0].at > start + tolerance ||
          series.points[series.points.length - 1].at < end - tolerance) return false;
      for (var i = 1; i < series.points.length; i++) {
        if (series.points[i].at - series.points[i - 1].at > maxGap) return false;
      }
      return true;
    }
    function completeCryptoHistory() {
      var combined = null;
      var coinGeckoCurrencies = currency === 'USD' ? ['USD'] : [currency, 'USD'];
      var yahooCurrencies = currency === 'EUR' || currency === 'GBP'
        ? [currency, 'USD'] : ['USD'];
      var providers = [];
      var preferStaticArchive = end - start > 7 * 86400000;
      // Long-range charts use Plutus' independently collected archive first.
      // Short ranges retain higher-resolution exchange/API data, but the
      // archive remains the final fallback when those services are blocked.
      if (preferStaticArchive) {
        providers.push(function () {
          return fetchPlutusDailyCryptoSeries(sym, queryStart * 1000, queryEnd * 1000);
        });
      }
      coinGeckoCurrencies.forEach(function (code) {
        providers.push(function () { return fetchCoinGeckoSeries(code); });
      });
      yahooCurrencies.forEach(function (code) {
        providers.push(function () { return fetchYahooCryptoSeries(code); });
      });
      if (COINBASE_SYMBOLS.indexOf(sym) !== -1) providers.push(fetchCoinbaseSeries);
      if (!preferStaticArchive) {
        providers.push(function () {
          return fetchPlutusDailyCryptoSeries(sym, queryStart * 1000, queryEnd * 1000);
        });
      }
      function nextProvider(index) {
        if (hasFullCoverage(combined)) {
          combined.error = '';
          return Promise.resolve(combined);
        }
        if (index >= providers.length) {
          if (combined && combined.points.length) return Promise.resolve(combined);
          return Promise.reject(new Error(combined && combined.error
            ? combined.error
            : 'No historical market data available for ' + sym));
        }
        return providers[index]().then(function (series) {
          combined = mergeSeries(combined, series);
          cachedPoints = cachedPoints.concat(series.points || []);
          return nextProvider(index + 1);
        }, function (error) {
          combined = mergeSeries(combined, { currency: currency, points: [], error: String(error.message || error) });
          return nextProvider(index + 1);
        });
      }
      return nextProvider(0);
    }
    request = completeCryptoHistory();
  } else if (kind === 'stock' || Object.prototype.hasOwnProperty.call(YAHOO_COMMODITY_MAP, sym)) {
    var yahoo = kind === 'stock' ? yahooSymbol(sym) : YAHOO_COMMODITY_MAP[sym];
    if (!yahoo) return Promise.resolve({ currency: currency, points: [], error: 'No market history for ' + sym });
    var interval = end - start <= 7 * 86400000 ? '60m' : '1d';
    var stockChunks = interval === '60m' ? [{ start: queryStart, end: queryEnd }] : makeChunks(queryStart, queryEnd, 180);
    request = fetchChunks(stockChunks, 'Yahoo Finance', function (chunk) {
      var query = 'period1=' + chunk.start + '&period2=' + chunk.end + '&interval=' + interval;
      return fetchFirstJson(yahooProxyUrls(yahoo, query), window.fetch.bind(window)).then(function (data) {
        var result = data && data.chart && data.chart.result && data.chart.result[0];
        if (!result) throw new Error('stock provider returned no prices');
        var stockUnit = normalizeQuoteUnit((result.meta && result.meta.currency) || 'USD', 1);
        var resultCurrency = stockUnit.currency;
        var timestamps = result.timestamp || [];
        var quotes = result.indicators && result.indicators.quote && result.indicators.quote[0];
        var closes = quotes && quotes.close ? quotes.close : [];
        var points = [];
        for (var i = 0; i < timestamps.length; i++) {
          var price = Number(closes[i]);
          if (isFinite(price) && price > 0) {
            points.push({ at: Number(timestamps[i]) * 1000, price: price / stockUnit.divisor, currency: resultCurrency });
          }
        }
        return { currency: resultCurrency, points: points };
      });
    });
  } else if (kind === 'commodity') {
    var stooq = stooqCommoditySymbol(sym);
    if (!stooq) return Promise.resolve({ currency: currency, points: [], error: 'No market history for ' + sym });
    var fromDay = startDay.replace(/-/g, '');
    var toDay = endDay.replace(/-/g, '');
    var stooqUrl = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(stooq) +
      '&d1=' + fromDay + '&d2=' + toDay + '&i=d';
    request = window.fetch(stooqUrl).then(function (response) {
      if (!response.ok) throw new Error('commodity provider HTTP ' + response.status);
      return response.text();
    }).then(function (csv) {
      var lines = String(csv || '').trim().split(/\r?\n/);
      var points = [];
      for (var i = 1; i < lines.length; i++) {
        var row = lines[i].split(',');
        var at = Date.parse(row[0] + 'T12:00:00Z');
        var price = Number(row[4]);
        if (isFinite(at) && isFinite(price) && price > 0) points.push({ at: at, price: price });
      }
      if (!points.length) throw new Error('commodity provider returned no prices');
      return { currency: 'USD', points: points };
    });
  } else {
    return Promise.resolve({ currency: currency, points: [], error: 'No market history for ' + sym });
  }

  return request.then(function (series) {
    series.points.sort(function (a, b) { return a.at - b.at; });
    series.kind = kind;
    if (series.points.length) {
      netWorthHistorySeriesCache[cacheKey] = { at: Date.now(), series: series };
      netWorthSeriesCachePrune();
      priceDataCacheRevision++;
      try { priceDataScheduleUpload(); } catch (e) { /* chart cache must not break rendering */ }
    }
    return series;
  }, function (error) {
    var series = {
      currency: currency,
      points: [],
      error: String(error && error.message ? error.message : error)
    };
    return series;
  });
}

function netWorthHistorySeriesPrice(series, at, main) {
  if (!series || !series.points || !series.points.length) return Promise.resolve(null);
  var points = series.points;
  var low = 0;
  var high = points.length - 1;
  while (low < high) {
    var mid = Math.ceil((low + high) / 2);
    if (points[mid].at <= at) low = mid;
    else high = mid - 1;
  }
  var picked = points[low];
  if (picked && picked.at > at) {
    if (picked.at - at > 36 * 60 * 60 * 1000) return Promise.resolve(null);
  } else if (!picked) {
    return Promise.resolve(null);
  } else {
    var maxStale = (series.kind === 'crypto' ? 1.5 : 5) * 86400000;
    if (at - picked.at > maxStale) return Promise.resolve(null);
  }
  var native = Number(picked.price);
  var from = String(picked.currency || series.currency || main).toUpperCase();
  var to = String(main).toUpperCase();
  if (!isFinite(native) || native <= 0) return Promise.resolve(null);
  if (from === to) return Promise.resolve(native);
  return fetchNetWorthHistoryRate(netWorthHistoryDate(at), from, to).then(function (rate) {
    if (!rate) return null;
    var converted = native * Number(rate.rate);
    return isFinite(converted) && converted > 0 ? converted : null;
  }, function () { return null; });
}

// Periods in which each symbol is actually HELD (qty > 0 after that day's
// trades), as [{from, to}] in ms. Chart prices are only needed inside these:
// a sold-out asset is valued at zero, and its live value comes from live
// prices, not history. Short gaps between holdings are merged so a quick
// sell/re-buy does not fragment downloads. Returns null when the ledger is
// too large to scan cheaply (caller then falls back to first trade -> end).
var NET_WORTH_HELD_GAP_MS = 14 * 86400000;
var NET_WORTH_HELD_MAX_DATES = 600;
var NET_WORTH_HELD_MAX_WORK = 50000;
// Longest stretch of chart valuation work before yielding to the browser.
var NET_WORTH_HISTORY_SLICE_MS = 12;
var netWorthHistoryHeldPeriodsCacheKey = '';
var netWorthHistoryHeldPeriodsCache = null;
var netWorthHistoryHeldPeriodsPending = {};
function netWorthHistoryHeldPeriods(st, included, main, signature) {
  var cacheKey = String(signature || '') + '|' + String(main).toUpperCase();
  if (netWorthHistoryHeldPeriodsCacheKey === cacheKey && netWorthHistoryHeldPeriodsCache) {
    return Promise.resolve(netWorthHistoryHeldPeriodsCache);
  }
  if (netWorthHistoryHeldPeriodsPending[cacheKey]) return netWorthHistoryHeldPeriodsPending[cacheKey];
  var allTrades = (st.trades || []).filter(function (trade) {
    return trade && typeof trade.date === 'string';
  });
  var dateMap = {};
  allTrades.forEach(function (trade) { dateMap[trade.date] = true; });
  var dates = Object.keys(dateMap).sort();
  if (!dates.length || dates.length > NET_WORTH_HELD_MAX_DATES ||
      dates.length * allTrades.length > NET_WORTH_HELD_MAX_WORK) return Promise.resolve(null);
  var heldBySymbol = {};
  var state = {};
  function finish() {
    Object.keys(state).forEach(function (symbol) {
      if (state[symbol] !== null) {
        (heldBySymbol[symbol] = heldBySymbol[symbol] || []).push({ from: state[symbol].from, to: Infinity });
      }
    });
    Object.keys(heldBySymbol).forEach(function (symbol) {
      var merged = [];
      heldBySymbol[symbol].forEach(function (period) {
        var last = merged[merged.length - 1];
        if (last && period.from - last.to <= NET_WORTH_HELD_GAP_MS) last.to = Math.max(last.to, period.to);
        else merged.push({ from: period.from, to: period.to });
      });
      heldBySymbol[symbol] = merged;
    });
    netWorthHistoryHeldPeriodsCacheKey = cacheKey;
    netWorthHistoryHeldPeriodsCache = heldBySymbol;
    delete netWorthHistoryHeldPeriodsPending[cacheKey];
    return heldBySymbol;
  }
  var promise = new Promise(function (resolve) {
    var index = 0;
    function processNextDate() {
      if (index >= dates.length) {
        resolve(finish());
        return;
      }
      var day = dates[index++];
      try {
        var portfolio = computePortfolio(convertTrades(allTrades.filter(function (trade) {
          return trade.date <= day;
        }), main), {}, st.settings.costMethod);
        var heldNow = {};
        Object.keys(included).forEach(function (accountId) {
          var rows = portfolio.byAccount[accountId];
          if (!rows) return;
          var accountKind = PRICE_KIND_BY_ACCOUNT[accountId] || 'crypto';
          rows.forEach(function (row, symbol) {
            if (Number(row.qtyHeld) > 0) {
              heldNow[priceKeyOf(String(symbol).toUpperCase(), accountKind)] = true;
            }
          });
        });
        Object.keys(heldNow).forEach(function (symbol) {
          if (state[symbol] === undefined) state[symbol] = null;
          if (state[symbol] === null) state[symbol] = { from: Date.parse(day + 'T00:00:00') };
        });
        Object.keys(state).forEach(function (symbol) {
          if (state[symbol] !== null && !heldNow[symbol]) {
            (heldBySymbol[symbol] = heldBySymbol[symbol] || []).push({
              from: state[symbol].from,
              to: Date.parse(day + 'T00:00:00') + 86400000
            });
            state[symbol] = null;
          }
        });
      } catch (error) {
        delete netWorthHistoryHeldPeriodsPending[cacheKey];
        resolve(null);
        return;
      }
      setTimeout(processNextDate, 0);
    }
    processNextDate();
  });
  netWorthHistoryHeldPeriodsPending[cacheKey] = promise;
  return promise;
}

function buildNetWorthHistory(st, main, range, onProgress, currentSnapshot, signature, isCurrent) {
  var included = netWorthHistoryIncludedAccounts(st);
  var earliest = netWorthHistoryStart(st, included);
  if (earliest === null) earliest = range.start;
  var start = Math.max(range.start, earliest);
  var end = Math.min(range.end, Date.now());
  if (!(end > start)) end = start + 1;
  var times = [];
  if (range.period === '1D') {
    // Whole hours plus the current moment: the same instants on every load,
    // so a later build replaces an earlier one point for point.
    var hour = 60 * 60 * 1000;
    for (var mark = Math.ceil(start / hour) * hour; mark < end; mark += hour) times.push(mark);
    times.push(end);
  } else {
    var sampleDay = new Date(start);
    sampleDay.setHours(0, 0, 0, 0);
    while (sampleDay.getTime() <= end) {
      var close = new Date(sampleDay.getTime());
      close.setHours(23, 59, 59, 999);
      if (close.getTime() >= start && close.getTime() <= end) times.push(close.getTime());
      sampleDay.setDate(sampleDay.getDate() + 1);
      sampleDay.setHours(0, 0, 0, 0);
    }
    if (!times.length || times[times.length - 1] < end) times.push(end);
  }

  var kinds = netWorthHistoryKinds(st);
  var symbols = {};
  var historyCashIds = cashAccountIds(st);
  var firstTradeBySymbol = {};
  var firstDebtBySymbol = {};
  var debtWindowsBySymbol = {};

  function noteHistorySymbol(rawSymbol, kind) {
    var symbol = String(rawSymbol || '').trim().toUpperCase();
    if (!symbol) return '';
    var normalizedKind = (typeof kind === 'string' && kind) ? kind : 'crypto';
    var identity = priceKeyOf(symbol, normalizedKind);
    symbols[identity] = normalizedKind;
    return identity;
  }

  (st.trades || []).forEach(function (trade) {
    if (!trade || !included[trade.accountId] || historyCashIds[trade.accountId]) return;
    var symbol = String((trade.symbol || trade.ticker) || '').toUpperCase();
    if (!symbol) return;
    var owner = accountById(st, trade.accountId);
    var kind = owner && owner.kind ? owner.kind : (kinds[symbol] || 'crypto');
    var identity = noteHistorySymbol(symbol, kind);
    if (trade.date && (!firstTradeBySymbol[identity] || trade.date < firstTradeBySymbol[identity])) {
      firstTradeBySymbol[identity] = trade.date;
    }
  });

  // Liabilities and pending stake rewards need market history even when their
  // owner account has never held a trade. Each position is priced by its own
  // denomination; fiat debt uses historical FX inside netWorthHistoryPointValue.
  (st.accounts || []).forEach(function (account) {
    if (!account || !included[account.id]) return;
    accountBalancePositions(account).forEach(function (position) {
      var ticker = String(position.assetTicker || account.ticker || '').trim().toUpperCase();
      var kind = String(position.assetKind || account.kind || 'crypto').trim().toLowerCase();
      if (!ticker || isCashKind(kind)) return;
      var identity = priceKeyOf(ticker, kind);
      var windows = debtPositionPositiveBalanceWindows(position);
      if (!windows.length) return;
      symbols[identity] = kind;
      if (!debtWindowsBySymbol[identity]) debtWindowsBySymbol[identity] = [];
      Array.prototype.push.apply(debtWindowsBySymbol[identity], windows);
      windows.forEach(function (window) {
        if (!isFinite(firstDebtBySymbol[identity]) || window.from < firstDebtBySymbol[identity]) firstDebtBySymbol[identity] = window.from;
      });
    });
  });
  var names = Object.keys(symbols);
  if (typeof onProgress === 'function') {
    onProgress({
      phase: 'start',
      symbols: names,
      totalAssets: names.length,
      start: start,
      end: end
    });
  }
  netWorthHistoryFetchBudget.remaining = Math.max(
    netWorthHistoryFetchBudget.remaining,
    Math.min(25000, times.length * Math.max(1, names.length + Object.keys(historyCashIds).length) + 100)
  );
  var seriesBySymbol = {};
  var nextSymbol = 0;
  var completedSymbols = {};
  return netWorthHistoryHeldPeriods(st, included, main, signature).then(function (heldPeriods) {
  if (typeof isCurrent === 'function' && !isCurrent()) return { points: [], stale: true };
  // Needed download windows per symbol, clipped to the requested range.
  // null periods (scan skipped) = legacy behaviour: first trade -> range end.
  var neededBySymbol = {};
  names.forEach(function (symbol) {
    var windows = [];
    function addClippedWindow(period) {
      if (!period) return;
      var from = Math.max(start, Number(period.from));
      var to = Math.min(end, period.to === Infinity ? end : Number(period.to));
      if (!isFinite(from) || !isFinite(to) || to < from) return;
      if (to === from) to = Math.min(end, from + 1);
      if (to >= from) windows.push({ from: from, to: to });
    }
    var firstTradeAt = firstTradeBySymbol[symbol]
      ? Date.parse(firstTradeBySymbol[symbol] + 'T00:00:00')
      : NaN;
    if (!heldPeriods) {
      // Fallback only for trade assets when the ledger scan is too large.
      // Debt-only assets still use their exact positive-balance snapshot windows.
      if (isFinite(firstTradeAt)) addClippedWindow({ from: Math.max(start, firstTradeAt), to: end });
    } else {
      (heldPeriods[symbol] || []).forEach(addClippedWindow);
    }
    (debtWindowsBySymbol[symbol] || []).forEach(addClippedWindow);
    neededBySymbol[symbol] = mergeNetWorthHistoryWindows(windows);
  });
  function neededAt(symbol, at) {
    var windows = neededBySymbol[symbol] || [];
    for (var i = 0; i < windows.length; i++) {
      if (at >= windows[i].from && at <= windows[i].to) return true;
    }
    return false;
  }
  function mergeSeries(parts, symbol, kind) {
    var seen = {};
    var points = [];
    var errors = [];
    var currencyCode = '';
    parts.forEach(function (part) {
      if (!part) return;
      currencyCode = currencyCode || part.currency || '';
      if (part.error) errors.push(part.error);
      (part.points || []).forEach(function (point) {
        var key = String(point.at);
        if (seen[key]) return;
        seen[key] = true;
        points.push(point);
      });
    });
    points.sort(function (a, b) { return a.at - b.at; });
    return {
      currency: currencyCode || String(main).toUpperCase(),
      points: points,
      kind: kind,
      error: errors.length ? errors.join('; ').slice(0, 800) : ''
    };
  }
  function loadNextSeries() {
    if (nextSymbol >= names.length) return Promise.resolve();
    var symbol = names[nextSymbol++];
    var windows = neededBySymbol[symbol] || [];
    var parts = [];
    function loadWindow(index) {
      if (index >= windows.length) return Promise.resolve();
      var identityParts = splitPriceKey(symbol);
      var seriesSymbol = identityParts ? identityParts.sym : symbol;
      var seriesKind = identityParts ? identityParts.kind : symbols[symbol];
      return fetchNetWorthHistorySeries(seriesSymbol, seriesKind, main, windows[index].from, windows[index].to, onProgress)
        .then(function (part) {
          parts.push(part);
          return loadWindow(index + 1);
        });
    }
    var symbolStart = windows.length ? windows[0].from : start;
    return loadWindow(0).then(function () {
      // Nothing held inside this range: no download, and not a gap.
      var series = windows.length ? mergeSeries(parts, symbol, symbols[symbol])
        : { currency: String(main).toUpperCase(), points: [], kind: symbols[symbol], error: '' };
      seriesBySymbol[symbol] = series;
      completedSymbols[symbol] = true;
      if (typeof onProgress === 'function') {
        onProgress({
          phase: 'asset-complete',
          symbol: symbol,
          completedAssets: Object.keys(completedSymbols).length,
          totalAssets: names.length,
          start: start,
          end: end,
          assetStart: symbolStart,
          assetEnd: end,
          failed: windows.length > 0 && !series.points.length,
          error: series.error || ''
        });
      }
      return loadNextSeries();
    });
  }
  var workers = [];
  for (var worker = 0; worker < Math.min(3, names.length); worker++) workers.push(loadNextSeries());

  return Promise.all(workers).then(function () {
    function needsSeries(symbol) { return (neededBySymbol[symbol] || []).length > 0; }
    var incomplete = names.some(function (symbol) {
      return needsSeries(symbol) &&
        (!seriesBySymbol[symbol] || !seriesBySymbol[symbol].points.length || !!seriesBySymbol[symbol].error);
    });
    var missingSymbols = {};
    names.forEach(function (symbol) {
      if (needsSeries(symbol) &&
          (!seriesBySymbol[symbol] || !seriesBySymbol[symbol].points.length || seriesBySymbol[symbol].error)) {
        missingSymbols[symbol] = true;
      }
    });
    var points = [];
    var batchSize = 1;
    var sliceStartedAt = Date.now();
    function valueNextBatch(offset) {
      if (typeof isCurrent === 'function' && !isCurrent()) return Promise.resolve(points);
      if (offset >= times.length) return Promise.resolve(points);
      var batch = times.slice(offset, offset + batchSize);
      return Promise.all(batch.map(function (at) {
        var prices = {};
        var priceJobs = names.map(function (symbol) {
          return netWorthHistorySeriesPrice(seriesBySymbol[symbol], at, main).then(function (price) {
            if (price !== null) prices[symbol] = price;
            else {
              var tradeRequiredAt = firstTradeBySymbol[symbol]
                ? Date.parse(firstTradeBySymbol[symbol] + 'T00:00:00')
                : Infinity;
              var debtRequiredAt = isFinite(firstDebtBySymbol[symbol])
                ? firstDebtBySymbol[symbol]
                : Infinity;
              if (neededAt(symbol, at) && at >= Math.min(tradeRequiredAt, debtRequiredAt)) {
                incomplete = true;
                missingSymbols[symbol] = true;
              }
            }
          });
        });
        return Promise.all(priceJobs).then(function () {
          var point = { at: at, prices: prices };
          return netWorthHistoryPointValue(point, st, main, false).then(function (result) {
            if (result.complete === false) incomplete = true;
            return { at: at, value: result.value, prices: prices };
          });
        });
      })).then(function (batchPoints) {
        Array.prototype.push.apply(points, batchPoints);
        var nextOffset = offset + batch.length;
        // Hand the main thread back after a short slice of work rather than
        // after every point: a timer wait per point costs several ms each in
        // a foreground tab and a full second each in a hidden one.
        var yieldNow = Date.now() - sliceStartedAt >= NET_WORTH_HISTORY_SLICE_MS;
        if (typeof onProgress === 'function' && (yieldNow || nextOffset >= times.length)) {
          onProgress({
            phase: 'valuation',
            completed: points.length,
            total: times.length,
            start: start,
            end: end
          });
        }
        if (!yieldNow) return valueNextBatch(nextOffset);
        return new Promise(function (resolve) {
          setTimeout(function () {
            sliceStartedAt = Date.now();
            resolve(valueNextBatch(nextOffset));
          }, 0);
        });
      });
    }
    // Every fiat rate the valuation will ask for, fetched up front: a few
    // range requests instead of one request per day, one after another.
    var rateCodes = netWorthHistoryRateCodes(st, seriesBySymbol, main);
    var rateDays = times.map(function (at) { return netWorthHistoryDate(at); });
    return netWorthHistoryPrefetchRates(rateCodes, main, rateDays, isCurrent).then(function () {
      return valueNextBatch(0);
    }).then(function () {
      var completedAt = Date.now();
      if (points.length && currentSnapshot &&
          completedAt >= end && completedAt - end <= 5 * 60 * 1000) {
        var snapshotValue = currentSnapshot.value === null || currentSnapshot.value === undefined
          ? NaN : Number(currentSnapshot.value);
        points[points.length - 1] = {
          at: end,
          value: isFinite(snapshotValue) ? snapshotValue : null,
          prices: currentSnapshot.prices || {},
          live: true
        };
      }
      var missing = Object.keys(missingSymbols);
      return {
        points: points,
        incomplete: incomplete,
        message: missing.length
          ? 'Historical prices unavailable for: ' + missing.map(function (symbol) {
            var series = seriesBySymbol[symbol];
            var reason = series && series.error ? ' (' + series.error + ')' : '';
            return symbol + reason;
          }).join(', ') + '. Values are left as gaps.'
          : (incomplete ? 'Some asset prices or fiat conversions are unavailable. Values are left as gaps.' : ''),
        historyStart: earliest
      };
    });
  });
  });
}

function fetchNetWorthHistoryPrice(symbol, day, main, kind) {
  var cacheKind = histKindFor(kind);
  var key = histCacheKey(symbol, day, main, cacheKind);
  var cached = getHistCached(symbol, day, main, cacheKind);
  if (cachedPriceOf(cached) !== null) {
    return Promise.resolve(Number(cached.price));
  }
  if (netWorthHistoryFailures[key]) return Promise.resolve(null);
  if (netWorthHistoryFetches[key]) return netWorthHistoryFetches[key];
  if (histInflight[key] || histBlocked(key)) return Promise.resolve(null);
  if (netWorthHistoryFetchBudget.remaining <= 0) return Promise.resolve(null);
  netWorthHistoryFetchBudget.remaining--;

  netWorthHistoryFetches[key] = fetchHistoricalPrice(symbol, day, main, kind).then(function (price) {
    delete netWorthHistoryFetches[key];
    if (isFinite(Number(price)) && Number(price) > 0) {
      setHistCached(symbol, day, main, cacheKind, Number(price), 'net-worth-history', false);
      saveHistCache();
      return Number(price);
    }
    netWorthHistoryFailures[key] = true;
    return null;
  }, function () {
    delete netWorthHistoryFetches[key];
    netWorthHistoryFailures[key] = true;
    return null;
  });
  return netWorthHistoryFetches[key];
}

// Daily fiat rate for chart valuation. Only real ECB fixings are cached or
// shared: a day without one is fetched (fetchEcbRate already answers a
// weekend or holiday with the last fixing before it). This used to copy the
// rate of an earlier day and store it as the day's own rate, so one old
// fixing spread forward day after day, into this device's rate cache and
// through Price Data to every device, and the chart jumped between it and
// the real rates. A borrowed rate now only stands in when the fetch is not
// possible, and is never stored.
function fetchNetWorthHistoryRate(day, from, to) {
  var source = String(from || '').toUpperCase();
  var target = String(to || '').toUpperCase();
  var cached = getCachedRate(day, from, to);
  if (cached && isFinite(Number(cached.rate)) && Number(cached.rate) > 0) {
    netWorthHistorySaveRate(day, source, target, Number(cached.rate));
    return Promise.resolve(cached);
  }
  var shared = netWorthHistorySharedRate(day, source, target);
  if (shared) return Promise.resolve(shared);
  var key = [day, source, target].join('|');
  if (netWorthHistoryRateFetches[key]) return netWorthHistoryRateFetches[key];
  if (netWorthHistoryFetchBudget.remaining <= 0) {
    return Promise.resolve(netWorthHistoryBorrowedRate(day, source, target));
  }
  netWorthHistoryFetchBudget.remaining--;
  netWorthHistoryRateFetches[key] = fetchEcbRate(day, from, to).then(function (rate) {
    delete netWorthHistoryRateFetches[key];
    if (rate && isFinite(Number(rate.rate)) && Number(rate.rate) > 0) {
      cacheRate(day, from, to, Number(rate.rate), rate.source);
      netWorthHistorySaveRate(day, source, target, Number(rate.rate));
      saveFxCache();
      return rate;
    }
    return netWorthHistoryBorrowedRate(day, source, target);
  }, function () {
    delete netWorthHistoryRateFetches[key];
    return netWorthHistoryBorrowedRate(day, source, target);
  });
  return netWorthHistoryRateFetches[key];
}

// Fiat codes the chart converts from: quote currencies of the price series,
// cash accounts, and fiat-denominated debt and pending income.
function netWorthHistoryRateCodes(st, seriesBySymbol, main) {
  var codes = {};
  function note(code) {
    var c = String(code || '').trim().toUpperCase();
    if (c && c !== String(main).toUpperCase()) codes[c] = true;
  }
  Object.keys(seriesBySymbol || {}).forEach(function (symbol) {
    var series = seriesBySymbol[symbol];
    if (!series) return;
    note(series.currency);
    (series.points || []).forEach(function (point) { if (point && point.currency) note(point.currency); });
  });
  var cashIds = cashAccountIds(st);
  (st.accounts || []).forEach(function (account) {
    if (!account) return;
    if (cashIds[account.id]) note(account.ticker);
    accountBalancePositions(account).forEach(function (position) {
      var kind = String(position.assetKind || account.kind || 'crypto').trim().toLowerCase();
      if (isCashKind(kind)) note(position.assetTicker || account.ticker);
    });
  });
  return Object.keys(codes);
}

// Fetches, ahead of valuation, the fixings of every day in `days` that this
// device holds no rate for: one range request per 90 days and fiat, which
// fills weekends and holidays from the fixing before them. If a range
// request fails, its days are fetched one by one, six at a time. Rates
// already held cost nothing, so only the first load of a period downloads.
var NET_WORTH_RATE_RANGE_DAYS = 90;
var NET_WORTH_RATE_PARALLEL = 6;
function netWorthHistoryPrefetchRates(codes, main, days, isCurrent) {
  var target = String(main || '').toUpperCase();
  var uniqueDays = {};
  (days || []).forEach(function (day) { if (isValidDateStr(day) && !isFutureDateStr(day)) uniqueDays[day] = true; });
  var sortedDays = Object.keys(uniqueDays).sort();
  function current() { return typeof isCurrent !== 'function' || isCurrent(); }
  function held(day, code) {
    return !!(getCachedRate(day, code, target) || netWorthHistorySharedRate(day, code, target));
  }
  return Promise.all((codes || []).map(function (code) {
    var missing = sortedDays.filter(function (day) { return !held(day, code); });
    if (!missing.length) return Promise.resolve();
    var chunks = [];
    var chunk = null;
    missing.forEach(function (day) {
      if (chunk && Date.parse(day + 'T00:00:00Z') - Date.parse(chunk.start + 'T00:00:00Z') < NET_WORTH_RATE_RANGE_DAYS * 86400000) {
        chunk.days.push(day);
      } else {
        chunk = { start: day, days: [day] };
        chunks.push(chunk);
      }
    });
    function storeRange(chunkDays, fixings) {
      var fixingDays = Object.keys(fixings).sort();
      var last = fixingDays[fixingDays.length - 1];
      var stored = false;
      chunkDays.forEach(function (day) {
        // Days after the newest returned fixing (today before publication)
        // are left to fetchEcbRate.
        if (day > last && !netWorthHistoryWeekendAfter(last, day)) return;
        var picked = pickRate(fixings, day);
        if (!picked) return;
        cacheRate(day, code, target, picked.rate, picked.source);
        netWorthHistorySaveRate(day, String(code).toUpperCase(), target, picked.rate);
        stored = true;
      });
      if (stored) saveFxCache();
    }
    // Gives up on this fiat once a dozen days in a row found no rate (a fiat
    // the ECB does not publish, or no network): valuation leaves those gaps.
    var failedInRow = 0;
    function oneByOne(chunkDays) {
      var queue = chunkDays.filter(function (day) { return !held(day, code); });
      function worker() {
        if (!queue.length || !current() || failedInRow >= 2 * NET_WORTH_RATE_PARALLEL) return Promise.resolve();
        var day = queue.shift();
        return fetchNetWorthHistoryRate(day, code, target).then(function (rate) {
          failedInRow = rate ? 0 : failedInRow + 1;
          return worker();
        }, function () {
          failedInRow++;
          return worker();
        });
      }
      var workers = [];
      for (var i = 0; i < NET_WORTH_RATE_PARALLEL; i++) workers.push(worker());
      return Promise.all(workers);
    }
    function nextChunk(index) {
      if (index >= chunks.length || !current()) return Promise.resolve();
      var item = chunks[index];
      var from = fxShiftDate(item.days[0], -FX_MAX_LOOKBACK_DAYS);
      var to = item.days[item.days.length - 1];
      return fetchEcbRateRange(from, to, code, target).then(function (fixings) {
        storeRange(item.days, fixings);
        return oneByOne(item.days);
      }, function () {
        return oneByOne(item.days);
      }).then(function () { return nextChunk(index + 1); });
    }
    return nextChunk(0);
  })).then(null, function () { /* valuation fetches what is still missing */ });
}

// True when every day after `fixingDay` up to `day` is a Saturday or Sunday.
function netWorthHistoryWeekendAfter(fixingDay, day) {
  var d = fxShiftDate(fixingDay, 1);
  while (d && d <= day) {
    var w = new Date(d + 'T00:00:00Z').getUTCDay();
    if (w !== 0 && w !== 6) return false;
    d = fxShiftDate(d, 1);
  }
  return true;
}

// Stand-in when a day's fixing cannot be fetched (offline, budget spent):
// the nearest stored real fixing up to FX_MAX_LOOKBACK_DAYS earlier, used for
// this valuation only. Null beyond that, so the point stays a gap.
function netWorthHistoryBorrowedRate(day, from, to) {
  for (var lookback = 1; lookback <= FX_MAX_LOOKBACK_DAYS; lookback++) {
    var previousDay = fxShiftDate(day, -lookback);
    var previous = getCachedRate(previousDay, from, to) || netWorthHistorySharedRate(previousDay, from, to);
    if (previous && isFinite(Number(previous.rate)) && Number(previous.rate) > 0) {
      return { rate: Number(previous.rate), source: previous.source, interpolated: true };
    }
  }
  return null;
}

// Shared through Price Data. "FXECB-" holds real fixings only; the earlier
// "FX-" series carried copied rates and is no longer read (see
// priceDataNormalizeSeries, which drops it).
var NET_WORTH_RATE_SERIES_PREFIX = 'FXECB-';
function netWorthHistoryRateSeriesKey(from, to) {
  return [NET_WORTH_RATE_SERIES_PREFIX + from + '-' + to, 'commodity', to, '0', '4102444800'].join('|');
}

function netWorthHistorySharedRate(day, from, to) {
  var dayAt = Date.parse(day + 'T00:00:00Z');
  if (!isFinite(dayAt)) return null;
  var entry = netWorthHistorySeriesCache[netWorthHistoryRateSeriesKey(from, to)];
  if (!entry || !entry.series || !Array.isArray(entry.series.points)) return null;
  var points = entry.series.points;
  var low = 0;
  var high = points.length - 1;
  while (low <= high) {
    var middle = Math.floor((low + high) / 2);
    var at = Number(points[middle].at);
    if (at < dayAt) low = middle + 1;
    else if (at > dayAt) high = middle - 1;
    else {
      var rate = Number(points[middle].price);
      return isFinite(rate) && rate > 0 ? { rate: rate, source: 'ECB (Price Data)' } : null;
    }
  }
  return null;
}

function netWorthHistorySaveRate(day, from, to, rate) {
  if (!/^[A-Z]{2,10}$/.test(from) || !/^[A-Z]{2,10}$/.test(to) ||
      from === to || !isValidDateStr(day) || !isFinite(Number(rate)) || Number(rate) <= 0) return;
  var at = Date.parse(day + 'T00:00:00Z');
  var key = netWorthHistoryRateSeriesKey(from, to);
  var cached = netWorthHistorySeriesCache[key];
  var points = cached && cached.series && Array.isArray(cached.series.points)
    ? cached.series.points : [];
  var low = 0;
  var high = points.length;
  while (low < high) {
    var middle = Math.floor((low + high) / 2);
    if (Number(points[middle].at) < at) low = middle + 1;
    else high = middle;
  }
  var changed = true;
  if (low < points.length && Number(points[low].at) === at) {
    if (Number(points[low].price) === Number(rate)) changed = false;
    else points[low] = { at: at, price: Number(rate), currency: to };
  } else {
    points.splice(low, 0, { at: at, price: Number(rate), currency: to });
  }
  if (!changed) return;
  netWorthHistorySeriesCache[key] = {
    at: Date.now(),
    series: { currency: to, kind: 'commodity', points: points },
    shared: !!(cached && cached.shared)
  };
  netWorthSeriesCachePrune();
  priceDataCacheRevision++;
  try { priceDataScheduleUpload(); } catch (e) { /* chart cache must not break valuation */ }
}

function netWorthHistoryPointValue(point, st, main, allowFetch) {
  var day = netWorthHistoryDate(point.at);
  var trades = convertTrades((st.trades || []).filter(function (trade) {
    return trade && typeof trade.date === 'string' && trade.date <= day;
  }), main);
  var kinds = netWorthHistoryKinds(st);
  var prices = {};
  Object.keys(point.prices || {}).forEach(function (symbol) {
    var price = Number(point.prices[symbol]);
    if (isFinite(price) && price > 0) prices[symbol] = price;
  });
  var portfolio = computePortfolio(trades, prices, st.settings.costMethod);
  var filter = selectedTickers(st);
  var accounts = (st.accounts || []).filter(function (account) {
    return (filter === null || filter.indexOf(String(account.ticker || '').toUpperCase()) !== -1) &&
      !groupMainOf(st, account.id);
  });
  var total = 0;
  var complete = true;
  var missing = {};
  var cashTotal = 0;
  var seenAccount = dict();
  var cashIds = cashAccountIds(st);

  function addAccountPositions(accountId) {
    if (seenAccount[accountId]) return;
    seenAccount[accountId] = true;
    if (cashIds[accountId]) return;
    var rows = portfolio.byAccount[accountId];
    if (!rows) return;
    rows.forEach(function (row, symbol) {
      if (!(Number(row.qtyHeld) > 0)) return;
      if (row.marketValue === null) {
        var upSym = String(symbol).toUpperCase();
        if (PRICE_COLLISIONS[upSym]) {
          var accKind = PRICE_KIND_BY_ACCOUNT[accountId] || 'crypto';
          missing[priceKeyOf(upSym, accKind)] = accKind;
        } else {
          missing[upSym] = kinds[upSym] || 'crypto';
        }
      } else {
        total += Number(row.marketValue);
      }
    });
  }

  accounts.forEach(function (account) {
    addAccountPositions(account.id);
    groupMembers(st, account.id).forEach(function (member) { addAccountPositions(member.id); });
  });

  var cashJobs = [];
  Object.keys(cashIds).forEach(function (accountId) {
    var account = accountById(st, accountId);
    if (!account || (filter !== null && filter.indexOf(String(account.ticker || '').toUpperCase()) === -1)) return;
    if (!(trades || []).some(function (trade) { return transferInvolvesAccount(trade, accountId); })) return;
    var balance = cashBalance(trades, accountId, main, false);
    var currency = String(balance.ticker || account.ticker || '').toUpperCase();
    var native = Number(balance.native);
    if (!isFinite(native) || !currency) {
      complete = false;
      return;
    }
    if (currency === String(main).toUpperCase()) {
      cashTotal += native;
      return;
    }
    cashJobs.push(fetchNetWorthHistoryRate(day, currency, main).then(function (rate) {
      if (!rate) {
        complete = false;
        return;
      }
      var converted = native * Number(rate.rate);
      if (isFinite(converted)) cashTotal += converted;
      else complete = false;
    }));
  });

  // Each liability and pending stake reward uses its own denomination and
  // latest report at/before the chart point. debtTotal is subtracted from
  // the total below, so liabilities enter it positive and rewards negative.
  var debtCashTotal = 0;
  var debtCashJobs = [];
  var debtAmounts = [];
  var includedDebtAccounts = netWorthHistoryIncludedAccounts(st);
  (st.accounts || []).forEach(function (account) {
    if (!account || !includedDebtAccounts[account.id]) return;
    accountDebtPositions(account).map(function (position) { return { position: position, sign: 1 }; })
      .concat(accountStakeRewards(account).map(function (position) { return { position: position, sign: -1 }; }))
      .forEach(function (entry) {
      var position = entry.position;
      var snapshot = latestDebtBalanceSnapshot(position, point.at);
      var amount = snapshot ? Number(snapshot.amount) * entry.sign : 0;
      if (!(Math.abs(amount) > 0)) return;
      var ticker = String(position.assetTicker || account.ticker || '').trim().toUpperCase();
      var kind = String(position.assetKind || account.kind || 'crypto').trim().toLowerCase();
      if (!ticker) { complete = false; return; }
      if (isCashKind(kind)) {
        if (ticker === String(main || '').toUpperCase()) debtCashTotal += amount;
        else debtCashJobs.push(fetchNetWorthHistoryRate(day, ticker, main).then(function (rate) {
          if (!rate) { complete = false; return; }
          var converted = amount * Number(rate.rate);
          if (isFinite(converted)) debtCashTotal += converted;
          else complete = false;
        }));
        return;
      }
      var debtIdentity = priceKeyOf(ticker, kind);
      var currentDebtPrice = Number(prices[debtIdentity]);
      if (!(isFinite(currentDebtPrice) && currentDebtPrice > 0) && !PRICE_COLLISIONS[ticker]) {
        currentDebtPrice = Number(prices[ticker]);
      }
      if (!(isFinite(currentDebtPrice) && currentDebtPrice > 0)) {
        missing[debtIdentity] = kind;
      }
      debtAmounts.push({ identity: debtIdentity, ticker: ticker, kind: kind, amount: amount });
    });
  });

  var symbols = Object.keys(missing);
  var jobs = symbols.map(function (symbol) {
    var kind = missing[symbol];
    if (allowFetch === false) {
      complete = false;
      return Promise.resolve(false);
    }
    var keyParts = splitPriceKey(symbol);
    return fetchNetWorthHistoryPrice(keyParts ? keyParts.sym : symbol, day, main, kind).then(function (price) {
      if (isFinite(Number(price)) && Number(price) > 0) {
        prices[symbol] = Number(price);
        return true;
      }
      complete = false;
      return false;
    });
  });

  return Promise.all(jobs.concat(cashJobs, debtCashJobs)).then(function () {
    if (symbols.length) saveHistCache();
    if (symbols.length) {
      var repriced = computePortfolio(trades, prices, st.settings.costMethod);
      total = 0;
      accounts.forEach(function (account) {
        function addRows(accountId) {
          if (cashIds[accountId]) return;
          var rows = repriced.byAccount[accountId];
          if (!rows) return;
          rows.forEach(function (row) {
            if (!(Number(row.qtyHeld) > 0)) return;
            if (row.marketValue === null) complete = false;
            else total += Number(row.marketValue);
          });
        }
        addRows(account.id);
        groupMembers(st, account.id).forEach(function (member) { addRows(member.id); });
      });
    }

    var debtTotal = debtCashTotal;
    debtAmounts.forEach(function (debt) {
      var price = Number(prices[debt.identity]);
      if (!(isFinite(price) && price > 0) && !PRICE_COLLISIONS[debt.ticker]) {
        price = Number(prices[debt.ticker]);
      }
      if (isFinite(price) && price > 0) {
        debtTotal += debt.amount * price;
      } else {
        complete = false;
      }
    });
    total += cashTotal;
    total -= debtTotal;
    return {
      value: complete ? total : null,
      prices: prices,
      complete: complete
    };
  });
}
function updateNetWorthHistory(st, value, main) {
  if (typeof window === 'undefined' || !window.NetWorthHistory || !st || !st.settings) return;
  var historyStart = netWorthHistoryStart(st, netWorthHistoryIncludedAccounts(st));
  if (historyStart === null) return;
  var signature = netWorthHistorySignature(st);
  if (netWorthHistoryFetchBudget.signature !== signature) {
    netWorthHistoryFetchBudget = { signature: signature, remaining: 160 };
  }
  var filter = selectedTickers(st);
  var scope = String(main || st.settings.mainCurrency).toUpperCase() + '|' +
    (filter === null ? 'all' : filter.slice().sort().join(','));
  var prices = {};
  Object.keys(livePrices || {}).forEach(function (symbol) {
    var price = Number(livePrices[symbol]);
    if (isFinite(price) && price > 0) prices[String(symbol).toUpperCase()] = price;
  });
  window.NetWorthHistory.update({
    scope: scope,
    currency: main,
    value: value,
    prices: prices,
    signature: signature,
    historyStart: historyStart,
    onStatus: function (status) {
      if (!status) return;
      if (status.state === 'complete') {
        // The load that raised the "may be incomplete" notice finished
        // cleanly: retire it, but never a different message.
        if (netWorthHistoryLoadingBannerShown) {
          netWorthHistoryLoadingBannerShown = false;
          var shown = document.getElementById('banner-text');
          var bannerEl = document.getElementById('banner');
          if (shown && bannerEl && !bannerEl.hidden && shown.textContent === NET_WORTH_LOADING_BANNER) dismissBanner();
        }
        return;
      }
      if (status.state !== 'loading' && status.state !== 'error' && status.state !== 'incomplete') return;
      // The chart shows its own loading status, so loading never raises a toast.
      if (status.state === 'loading') return;
      netWorthHistoryLoadingBannerShown = false;
      var message = String(status.message || 'Some historical prices are unavailable.');
      showBanner(
        status.state === 'loading'
          ? NET_WORTH_LOADING_BANNER
          : (status.state === 'error'
            ? 'Historical chart data could not be loaded.'
            : 'Historical chart is incomplete — some values are missing.'),
        status.state === 'loading' ? 'info' : 'error',
        status.state === 'loading' ? null : { title: 'Historical chart data', lines: [message] }
      );
    },
    prepareRetry: function () {
      netWorthHistoryFetchBudget = { signature: signature, remaining: 25000 };
      netWorthHistoryFailures = {};
    },
    loadHistory: function (range) {
      return priceDataStartupPromise.then(function () {
        return buildNetWorthHistory(st, main, range, range.onProgress, {
          value: value,
          prices: prices
        }, signature, range.isCurrent);
      });
    }
  });
}
