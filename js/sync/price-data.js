'use strict';
// Price-data sync: shares the historical price cache between devices through
// its own drive file (no portfolio data in it).

function priceDataCloneConfig(source) {
  var out = {};
  Object.keys(source || {}).forEach(function (key) { out[key] = source[key]; });
  return out;
}

function priceDataDestination(syncCfg) {
  var saved = priceDataLoadConfig();
  var cfg = saved.sameAsRecords
    ? priceDataCloneConfig(syncCfg || syncLoadConfig())
    : priceDataCloneConfig(saved);
  cfg.filename = PRICE_DATA_FILENAME;
  cfg.objectKey = PRICE_DATA_FILENAME;
  cfg.priceDataAuth = !saved.sameAsRecords;
  cfg.priceDataFile = true;
  if (!saved.sameAsRecords) {
    cfg.filename = saved.filename;
    cfg.objectKey = saved.objectKey;
    if (cfg.provider === 'webdav' && cfg.folder) {
      cfg.url = String(cfg.url || '').replace(/\/+$/, '') + '/' +
        cfg.folder.split('/').map(function (part) { return encodeURIComponent(part); }).join('/');
    }
  }
  return cfg;
}

function priceDataValidKey(key) {
  var parts = String(key || '').split('|');
  return parts.length === 4 &&
    /^[A-Z0-9._-]{1,48}$/.test(parts[0]) &&
    isValidDateStr(parts[1]) &&
    /^[A-Z0-9_-]{2,12}$/.test(parts[2]) &&
    /^(crypto|stock|commodity)$/.test(parts[3]);
}

function priceDataNormalizeRecords(input, strict) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (strict) throw new Error('price data file is invalid: records must be an object.');
    return {};
  }
  var inputKeys = Object.keys(input);
  if (strict && inputKeys.length > HISTCACHE_MAX) {
    throw new Error('price data file is invalid: it contains too many records.');
  }
  var out = {};
  inputKeys.forEach(function (key) {
    var item = input[key];
    var price = item && Number(item.price);
    if (!priceDataValidKey(key) || !item || typeof item !== 'object' ||
        !isFinite(price) || price <= 0) {
      if (strict) throw new Error('price data file is invalid: a price record is malformed.');
      return;
    }
    out[key] = {
      price: price,
      source: String(item.source || '').slice(0, 120),
      interpolated: !!item.interpolated,
      at: (isFinite(Number(item.at)) && Number(item.at) > 0) ? Number(item.at) : 0
    };
  });
  return out;
}

function priceDataValidSeriesKey(key) {
  var parts = String(key || '').split('|');
  return parts.length === 5 &&
    /^[A-Z0-9._-]{1,48}$/.test(parts[0]) &&
    /^(crypto|stock|commodity)$/.test(parts[1]) &&
    /^[A-Z0-9_-]{2,12}$/.test(parts[2]) &&
    /^-?\d{1,12}$/.test(parts[3]) &&
    /^-?\d{1,12}$/.test(parts[4]) &&
    Number(parts[3]) < Number(parts[4]);
}

function priceDataNormalizeSeries(input, strict) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    if (strict) throw new Error('price data file is invalid: chart series must be an object.');
    return {};
  }
  var keys = Object.keys(input);
  if (strict && keys.length > PRICE_DATA_SERIES_MAX) {
    throw new Error('price data file is invalid: it contains too many chart series.');
  }
  var out = {};
  keys.forEach(function (key) {
    var entry = input[key];
    var series = entry && entry.series;
    var keyParts = key.split('|');
    var points = [];
    var valid = priceDataValidSeriesKey(key) && entry && typeof entry === 'object' &&
      isFinite(Number(entry.at)) && Number(entry.at) > 0 &&
      series && typeof series === 'object' && !Array.isArray(series) &&
      series.kind === keyParts[1] && Array.isArray(series.points) &&
      series.points.length > 0 && series.points.length <= PRICE_DATA_SERIES_SINGLE_MAX &&
      (series.currency == null || /^[A-Z0-9_-]{2,12}$/i.test(String(series.currency)));
    if (valid) {
      for (var i = 0; i < series.points.length; i++) {
        var point = series.points[i];
        var at = point && Number(point.at);
        var price = point && Number(point.price);
        if (!point || !isFinite(at) || !isFinite(price) || price <= 0) {
          valid = false;
          break;
        }
        var normalizedPoint = { at: at, price: price };
        if (typeof point.currency === 'string' && /^[A-Z0-9_-]{2,12}$/i.test(point.currency)) {
          normalizedPoint.currency = point.currency.toUpperCase();
        }
        points.push(normalizedPoint);
      }
    }
    if (!valid) {
      if (strict) throw new Error('price data file is invalid: a chart series is malformed.');
      return;
    }
    points.sort(function (a, b) { return a.at - b.at; });
    out[key] = {
      at: Number(entry.at),
      series: {
        currency: String(series.currency || keyParts[2]).toUpperCase(),
        kind: keyParts[1],
        points: points
      }
    };
  });
  if (strict) {
    var totalPoints = 0;
    Object.keys(out).forEach(function (key) { totalPoints += out[key].series.points.length; });
    if (totalPoints > PRICE_DATA_SERIES_POINTS_MAX) {
      throw new Error('price data file is invalid: it contains too many chart prices.');
    }
  }
  return out;
}

function priceDataMergeSeries(first, second) {
  var merged = priceDataNormalizeSeries(first, false);
  var incoming = priceDataNormalizeSeries(second, false);
  Object.keys(incoming).forEach(function (key) {
    var old = merged[key];
    var next = incoming[key];
    if (!old) {
      merged[key] = next;
      return;
    }
    var byTime = {};
    old.series.points.forEach(function (point) { byTime[String(point.at)] = point; });
    next.series.points.forEach(function (point) {
      var prior = byTime[String(point.at)];
      if (!prior || Number(next.at) >= Number(old.at)) byTime[String(point.at)] = point;
    });
    var points = Object.keys(byTime).map(function (at) { return byTime[at]; })
      .sort(function (a, b) { return a.at - b.at; });
    merged[key] = {
      at: Math.max(Number(old.at) || 0, Number(next.at) || 0),
      series: {
        currency: next.series.currency || old.series.currency,
        kind: next.series.kind,
        points: points.slice(-PRICE_DATA_SERIES_SINGLE_MAX)
      }
    };
  });
  var keys = Object.keys(merged);
  keys.sort(function (a, b) { return Number(merged[a].at || 0) - Number(merged[b].at || 0); });
  var totalPoints = keys.reduce(function (sum, key) { return sum + merged[key].series.points.length; }, 0);
  while (keys.length > PRICE_DATA_SERIES_MAX || totalPoints > PRICE_DATA_SERIES_POINTS_MAX) {
    var removed = keys.shift();
    totalPoints -= merged[removed].series.points.length;
    delete merged[removed];
  }
  return merged;
}

function priceDataParsePayload(plaintext) {
  var data;
  try { data = JSON.parse(plaintext); }
  catch (e) { throw new Error('price data file is invalid JSON.'); }
  if (!data || data.app !== PRICE_DATA_APP || data.version !== 1) {
    throw new Error('price data file is not a supported INOCULENS PLUTUS price cache.');
  }
  return {
    records: priceDataNormalizeRecords(data.records, true),
    series: priceDataNormalizeSeries(data.series, true)
  };
}

function priceDataFingerprint(payload) {
  var records = {};
  var series = {};
  Object.keys(payload.records || {}).sort().forEach(function (key) {
    var item = payload.records[key];
    records[key] = {
      price: item.price,
      source: item.source,
      interpolated: item.interpolated,
      at: item.at
    };
  });
  Object.keys(payload.series || {}).sort().forEach(function (key) {
    var item = payload.series[key];
    series[key] = {
      at: item.at,
      series: {
        currency: item.series.currency,
        kind: item.series.kind,
        points: item.series.points
      }
    };
  });
  return JSON.stringify({ records: records, series: series });
}

function priceDataMergeRecords(first, second) {
  var merged = priceDataNormalizeRecords(first, false);
  var incoming = priceDataNormalizeRecords(second, false);
  Object.keys(incoming).forEach(function (key) {
    var old = merged[key];
    var next = incoming[key];
    if (!old || Number(next.at || 0) >= Number(old.at || 0)) merged[key] = next;
  });
  var keys = Object.keys(merged);
  if (keys.length > HISTCACHE_MAX) {
    keys.sort(function (a, b) { return Number(merged[a].at || 0) - Number(merged[b].at || 0); });
    keys.slice(0, keys.length - HISTCACHE_MAX).forEach(function (key) { delete merged[key]; });
  }
  return merged;
}

function priceDataReadRemote(cfg, passphrase) {
  function read(target) {
    return syncRemoteDownload(target).then(function (text) {
      return syncDecryptEnvelope(text, passphrase).then(function (plain) {
        var payload = priceDataParsePayload(plain);
        payload.exists = true;
        return payload;
      });
    });
  }
  function isMissing(err) {
    return !!(err && err.message && err.message.indexOf('no backup found') !== -1);
  }
  var none = function () { return { exists: false, records: {}, series: {} }; };
  return read(cfg).then(null, function (err) {
    if (!isMissing(err)) throw err;
    // Migration: earlier versions stored this cache WITHOUT the .enc.json
    // ending. Read it once so nothing is lost; exists stays false so the
    // merged result is saved under the proper .enc.json name.
    var legacyName = String(cfg.filename || '').replace(/\.enc\.json$/i, '');
    if (!legacyName || legacyName === cfg.filename) return none();
    var legacy = priceDataCloneConfig(cfg);
    legacy.filename = legacyName;
    legacy.objectKey = legacyName;
    return read(legacy).then(function (payload) {
      payload.exists = false;
      return payload;
    }, function (legacyErr) {
      if (isMissing(legacyErr)) return none();
      throw legacyErr;
    });
  });
}

var priceDataSyncBusy = false;
var priceDataSyncTimer = null;
var priceDataFailureShown = {};

function priceDataReportFailure(err, automatic) {
  var message = String((err && err.message) || err);
  var status = (typeof document !== 'undefined') ? document.getElementById('pd-status') : null;
  if (status) status.textContent = 'Price history sync failed — ' + message;
  if (!priceDataFailureShown[message]) {
    priceDataFailureShown[message] = true;
    showBanner('Price history could not sync.', 'error', {
      title: 'Price history sync',
      lines: [message, automatic ? 'It will retry after another history update or sync.' : 'Your account and trade data were not changed.']
    });
  }
}

function priceDataSyncFlow(opts) {
  opts = opts || {};
  if (priceDataSyncBusy) return Promise.resolve('busy');
  var rd;
  try { rd = syncReadForm(); }
  catch (e) { return Promise.reject(e); }
  var passphrase = rd.passphrase;
  var cfg = priceDataDestination(rd.cfg);
  if (!passphrase) {
    var missingPass = new Error('Enter the Sync passphrase to access encrypted price history.');
    if (opts.automatic) {
      var missingStatus = (typeof document !== 'undefined') ? document.getElementById('pd-status') : null;
      if (missingStatus) missingStatus.textContent = 'Price history needs the Sync passphrase before it can load.';
      return Promise.resolve('skipped');
    }
    priceDataReportFailure(missingPass, false);
    return Promise.reject(missingPass);
  }
  if (!syncIsConnected(cfg)) {
    if (opts.automatic) return Promise.resolve('skipped');
    var notConnected = new Error('Connect the selected Price Data provider first.');
    priceDataReportFailure(notConnected, false);
    return Promise.reject(notConnected);
  }
  priceDataSyncBusy = true;
  var status = (typeof document !== 'undefined') ? document.getElementById('pd-status') : null;
  if (status) status.textContent = 'Loading price history…';
  function localPayload() {
    return {
      records: priceDataNormalizeRecords(loadHistCache(), false),
      series: priceDataNormalizeSeries(netWorthHistorySeriesCache, false)
    };
  }
  function applyPayload(payload) {
    var cache = loadHistCache();
    Object.keys(cache).forEach(function (key) { delete cache[key]; });
    Object.keys(payload.records).forEach(function (key) { cache[key] = payload.records[key]; });
    saveHistCache();
    Object.keys(netWorthHistorySeriesCache).forEach(function (key) { delete netWorthHistorySeriesCache[key]; });
    Object.keys(payload.series).forEach(function (key) {
      netWorthHistorySeriesCache[key] = {
        at: payload.series[key].at,
        series: payload.series[key].series,
        shared: true
      };
    });
  }
  var local = localPayload();
  var localSeriesFingerprint = priceDataFingerprint({ records: {}, series: local.series });
  var historySeriesChanged = false;
  var uploadRevision = priceDataCacheRevision;
  return priceDataReadRemote(cfg, passphrase).then(function (remote) {
    var merged = {
      records: priceDataMergeRecords(remote.records, local.records),
      series: priceDataMergeSeries(remote.series, local.series)
    };
    applyPayload(merged);
    return priceDataReadRemote(cfg, passphrase).then(function (latest) {
      var freshLocal = localPayload();
      merged = {
        records: priceDataMergeRecords(merged.records, freshLocal.records),
        series: priceDataMergeSeries(merged.series, freshLocal.series)
      };
      merged.records = priceDataMergeRecords(merged.records, latest.records);
      merged.series = priceDataMergeSeries(merged.series, latest.series);
      historySeriesChanged = priceDataFingerprint({ records: {}, series: merged.series }) !== localSeriesFingerprint;
      applyPayload(merged);
      uploadRevision = priceDataCacheRevision;
      if (latest.exists && priceDataFingerprint(merged) === priceDataFingerprint(latest)) {
        return merged;
      }
      var plaintext = JSON.stringify({
        app: PRICE_DATA_APP,
        version: 1,
        records: merged.records,
        series: merged.series
      });
      return syncEncryptEnvelope(plaintext, passphrase).then(function (encrypted) {
        if (status) status.textContent = 'Saving price history…';
        return syncRemoteEnsureFolder(cfg).then(function () {
          return syncRemoteUpload(cfg, encrypted);
        });
      }).then(function () { return merged; });
    });
  }).then(function (merged) {
    priceDataFailureShown = {};
    priceDataSyncBusy = false;
    var priceCount = Object.keys(merged.records).length;
    var seriesCount = Object.keys(merged.series).length;
    if (status) status.textContent = 'Price history synced (' + priceCount + ' historical prices, ' + seriesCount + ' chart series).';
    if (priceDataCacheRevision !== uploadRevision) priceDataScheduleUpload();
    try { render(); } catch (e) { /* repaint must not affect a completed cache sync */ }
    if (historySeriesChanged && typeof window !== 'undefined' && window.NetWorthHistory &&
        typeof window.NetWorthHistory.refresh === 'function') {
      window.NetWorthHistory.refresh();
    }
    return 'synced';
  }, function (err) {
    priceDataSyncBusy = false;
    priceDataReportFailure(err, !!opts.automatic);
    if (opts.automatic) return 'failed';
    throw err;
  });
}

function priceDataCanSync() {
  try {
    var rd = syncReadForm();
    return !!(rd.passphrase && syncIsConnected(priceDataDestination(rd.cfg)));
  } catch (e) {
    return false;
  }
}

function priceDataScheduleUpload() {
  if (priceDataSyncBusy || !priceDataCanSync()) return;
  if (priceDataSyncTimer) {
    try { clearTimeout(priceDataSyncTimer); } catch (e) { /* ignore */ }
  }
  priceDataSyncTimer = setTimeout(function () {
    priceDataSyncTimer = null;
    priceDataSyncFlow({ automatic: true });
  }, 12000);
}
