(function (root) {
  'use strict';

  var STORAGE_KEY = 'plutus.networth-history.v1';
  var RANGE_STORAGE_KEY = 'plutus.networth-history-ranges.v1';
  var HISTORY_DB = 'plutus.networth-history';
  var HISTORY_STORE = 'scopes';
  var PERIODS = {
    '1D': 24 * 60 * 60 * 1000,
    '1W': 7 * 24 * 60 * 60 * 1000,
    '1M': 30 * 24 * 60 * 60 * 1000,
    '3M': 90 * 24 * 60 * 60 * 1000,
    '6M': 183 * 24 * 60 * 60 * 1000,
    '1Y': 365 * 24 * 60 * 60 * 1000,
    '5Y': 1826 * 24 * 60 * 60 * 1000
  };
  var store = { scopes: {} };
  var rangePreferences = {};
  var active = null;
  var svgNS = 'http://www.w3.org/2000/svg';
  var storageMessage = '';
  var storageReadWarning = '';
  var hoverPoint = null;
  var pinned = false;
  var lastDrawn = [];
  var storeLoaded = false;
  var pendingUpdateOptions = null;
  var storageReady = false;
  var storageReadyPromise = Promise.resolve();
  var historyDb = null;
  var pendingStorageWrites = {};
  var dirtyScopeKeys = {};
  var storageWriteTimer = null;
  var rangeStorageTimer = null;
  var legacyStoragePending = false;
  var rangeDrag = null;
  var rangeRequestTimer = null;
  var historyRetryTimer = null;
  var historyProgressTimer = null;
  var navigatorCache = null;
  var requestSequence = 0;
  var lastReportedStatus = '';

  function storedScope(data, key) {
    return {
      scopeKey: key,
      points: Array.isArray(data.points) ? data.points : [],
      period: data.period,
      from: data.from,
      to: data.to,
      rangeStart: data.rangeStart,
      rangeEnd: data.rangeEnd,
      signature: data.signature,
      incomplete: !!data.incomplete
    };
  }

  function scopeSnapshot(data, key) {
    return {
      scopeKey: key,
      points: data.points,
      period: data.period,
      from: data.from,
      to: data.to,
      rangeStart: data.rangeStart,
      rangeEnd: data.rangeEnd,
      signature: data.signature,
      incomplete: !!data.incomplete
    };
  }

  function historyDatabase() {
    return new Promise(function (resolve) {
      var settled = false;
      var timeout = root.setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, 5000);
      function finish(db) {
        if (settled) {
          if (db) db.close();
          return;
        }
        settled = true;
        root.clearTimeout(timeout);
        resolve(db);
      }
      try {
        if (!root.indexedDB) { finish(null); return; }
        var request = root.indexedDB.open(HISTORY_DB, 1);
        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains(HISTORY_STORE)) {
            request.result.createObjectStore(HISTORY_STORE);
          }
        };
        request.onsuccess = function () {
          var db = request.result;
          db.onversionchange = function () { db.close(); };
          finish(db);
        };
        request.onerror = function () { finish(null); };
        request.onblocked = function () { finish(null); };
      } catch (e) {
        finish(null);
      }
    });
  }

  function replaceScope(target, source) {
    Object.keys(target).forEach(function (key) { delete target[key]; });
    Object.keys(source).forEach(function (key) { target[key] = source[key]; });
  }

  function saveLegacyStore() {
    try {
      var saved = { scopes: {} };
      Object.keys(store.scopes).forEach(function (key) {
        saved.scopes[key] = scopeSnapshot(store.scopes[key], key);
        delete saved.scopes[key].scopeKey;
      });
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      storageMessage = storageReadWarning;
      return true;
    } catch (e) {
      storageMessage = 'Could not save chart history locally. Check available browser storage.';
      return false;
    }
  }

  function flushStorageWrites() {
    if (!historyDb || !storageReady) return;
    var keys = Object.keys(pendingStorageWrites);
    if (!keys.length) return;
    var batch = {};
    keys.forEach(function (key) { batch[key] = pendingStorageWrites[key]; });
    try {
      var transaction = historyDb.transaction(HISTORY_STORE, 'readwrite');
      var objectStore = transaction.objectStore(HISTORY_STORE);
      keys.forEach(function (key) { objectStore.put(batch[key], key); });
      transaction.oncomplete = function () {
        keys.forEach(function (key) {
          if (pendingStorageWrites[key] === batch[key]) delete pendingStorageWrites[key];
        });
        if (legacyStoragePending && !Object.keys(pendingStorageWrites).length) {
          try { root.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* IDB is authoritative */ }
          legacyStoragePending = false;
        }
        storageMessage = storageReadWarning;
        if (active) draw();
        if (Object.keys(pendingStorageWrites).length) scheduleStorageWrite();
      };
      transaction.onerror = transaction.onabort = function () {
        storageMessage = 'Could not save chart history in IndexedDB. Check available browser storage.';
        if (active) draw();
      };
    } catch (e) {
      storageMessage = 'Could not save chart history in IndexedDB. Check available browser storage.';
      if (active) draw();
    }
  }

  function scheduleStorageWrite() {
    if (storageWriteTimer !== null) root.clearTimeout(storageWriteTimer);
    storageWriteTimer = root.setTimeout(function () {
      storageWriteTimer = null;
      if (historyDb) flushStorageWrites();
      else if (storageReady) saveLegacyStore();
    }, 150);
  }

  function loadStore() {
    if (storeLoaded) return storageReadyPromise;
    storeLoaded = true;
    try {
      var ranges = root.localStorage.getItem(RANGE_STORAGE_KEY);
      if (ranges) {
        try {
          var parsedRanges = JSON.parse(ranges);
          if (parsedRanges && typeof parsedRanges === 'object' && !Array.isArray(parsedRanges)) {
            rangePreferences = parsedRanges;
          }
        } catch (rangeError) {
          storageReadWarning = 'Saved chart range preferences could not be read.';
        }
      }
      var raw = root.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.scopes && typeof parsed.scopes === 'object' && !Array.isArray(parsed.scopes)) {
          store = parsed;
          legacyStoragePending = true;
          Object.keys(store.scopes).forEach(function (key) {
            var data = store.scopes[key];
            if (!data || typeof data !== 'object') {
              delete store.scopes[key];
              return;
            }
            data.pointsNormalized = true;
            delete data.pendingSignature;
            delete data.pendingContext;
            data.updating = false;
          });
        } else {
          storageReadWarning = 'Saved graph history could not be read; new history is being stored separately.';
          storageMessage = storageReadWarning;
        }
      }
    } catch (e) {
      storageReadWarning = 'Local graph history is unavailable in this browser session.';
      storageMessage = storageReadWarning;
    }
    storageReadyPromise = historyDatabase().then(function (db) {
      historyDb = db;
      if (!db) {
        storageReady = true;
        storageReadWarning = storageReadWarning ||
          'IndexedDB is unavailable; chart history is using limited local browser storage.';
        storageMessage = storageReadWarning;
        return false;
      }
      return new Promise(function (resolve) {
        try {
          var request = db.transaction(HISTORY_STORE, 'readonly').objectStore(HISTORY_STORE).getAll();
          request.onsuccess = function () {
            var records = Array.isArray(request.result) ? request.result : [];
            var storedKeys = {};
            storageReadWarning = '';
            storageMessage = '';
            records.forEach(function (record) {
              if (!record || typeof record.scopeKey !== 'string' || !record.scopeKey) return;
              storedKeys[record.scopeKey] = true;
              if (dirtyScopeKeys[record.scopeKey]) return;
              var current = store.scopes[record.scopeKey];
              var normalized = storedScope(record, record.scopeKey);
              normalized.pointsNormalized = true;
              if (current) replaceScope(current, normalized);
              else store.scopes[record.scopeKey] = normalized;
            });
            if (legacyStoragePending) {
              Object.keys(store.scopes).forEach(function (key) {
                if (storedKeys[key] || dirtyScopeKeys[key]) return;
                pendingStorageWrites[key] = scopeSnapshot(store.scopes[key], key);
              });
            }
            storageReady = true;
            if (legacyStoragePending && !Object.keys(pendingStorageWrites).length) {
              try { root.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* IDB is authoritative */ }
              legacyStoragePending = false;
            }
            if (Object.keys(pendingStorageWrites).length) scheduleStorageWrite();
            resolve(true);
          };
          request.onerror = function () {
            storageReadWarning = 'IndexedDB chart history could not be read; saved values may need to be rebuilt.';
            storageMessage = storageReadWarning;
            try { db.close(); } catch (e) { /* ignore */ }
            historyDb = null;
            storageReady = true;
            resolve(false);
          };
        } catch (e) {
          storageReadWarning = 'IndexedDB chart history could not be read; saved values may need to be rebuilt.';
          storageMessage = storageReadWarning;
          try { db.close(); } catch (e2) { /* ignore */ }
          historyDb = null;
          storageReady = true;
          resolve(false);
        }
      });
    }).then(function (loaded) {
      if (pendingUpdateOptions) {
        var options = pendingUpdateOptions;
        pendingUpdateOptions = null;
        update(options);
      }
      return loaded;
    });
    return storageReadyPromise;
  }

  function applyRangePreference(data) {
    var preference = rangePreferences[data.scopeKey];
    if (!preference || typeof preference !== 'object') return;
    if (PERIODS[preference.period] || preference.period === 'ALL' || preference.period === 'CUSTOM') {
      data.period = preference.period;
    }
    if (typeof preference.from === 'string') data.from = preference.from;
    if (typeof preference.to === 'string') data.to = preference.to;
    data.rangeStart = preference.rangeStart !== null && isFinite(Number(preference.rangeStart))
      ? Number(preference.rangeStart) : null;
    data.rangeEnd = preference.rangeEnd !== null && isFinite(Number(preference.rangeEnd))
      ? Number(preference.rangeEnd) : null;
  }

  function saveRangePreference(data) {
    var key = String(data.scopeKey || 'default');
    rangePreferences[key] = {
      period: data.period,
      from: data.from,
      to: data.to,
      rangeStart: data.rangeStart,
      rangeEnd: data.rangeEnd
    };
    if (rangeStorageTimer !== null) root.clearTimeout(rangeStorageTimer);
    rangeStorageTimer = root.setTimeout(function () {
      rangeStorageTimer = null;
      try {
        root.localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(rangePreferences));
      } catch (e) {
        storageMessage = 'Could not save chart range locally. Check available browser storage.';
        if (active) draw();
      }
    }, 150);
  }

  function saveStore(data) {
    data = data || active;
    if (!data) return true;
    var key = String(data.scopeKey || (active && active.scopeKey) || 'default');
    data.scopeKey = key;
    dirtyScopeKeys[key] = true;
    pendingStorageWrites[key] = scopeSnapshot(data, key);
    if (!storageReady) return true;
    if (historyDb) {
      scheduleStorageWrite();
      return true;
    }
    scheduleStorageWrite();
    return true;
  }

  // Lets the loading state paint before heavy work starts. Animation frames
  // never fire in hidden or occluded tabs, so a timer fallback guarantees the
  // work still runs (exactly once) instead of stalling until the tab returns.
  function runAfterPaint(work) {
    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      root.setTimeout(work, 0);
    }
    var hasFrames = typeof root.requestAnimationFrame === 'function';
    if (hasFrames) root.requestAnimationFrame(schedule);
    root.setTimeout(schedule, hasFrames ? 100 : 0);
  }

  function byId(id) {
    return root.document ? root.document.getElementById(id) : null;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function svgElement(name, attrs) {
    var el = root.document.createElementNS(svgNS, name);
    Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, String(attrs[key])); });
    return el;
  }

  function money(value, currency) {
    if (value === null || value === undefined || !isFinite(Number(value))) return '—';
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency,
        maximumFractionDigits: 2
      }).format(Number(value));
    } catch (e) {
      return currency + ' ' + Number(value).toFixed(2);
    }
  }

  function dateKey(timestamp) {
    var d = new Date(timestamp);
    var month = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (month.length < 2 ? '0' : '') + month + '-' + (day.length < 2 ? '0' : '') + day;
  }

  function displayDate(timestamp, compact) {
    var options = compact
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    try { return new Date(timestamp).toLocaleString(undefined, options); }
    catch (e) { return dateKey(timestamp); }
  }

  function dateTimestamp(value, endOfDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return NaN;
    var parts = value.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]),
      endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime();
  }

  function pointCopy(point) {
    var prices = {};
    Object.keys(point.prices || {}).forEach(function (symbol) {
      var value = Number(point.prices[symbol]);
      if (isFinite(value) && value > 0) prices[symbol] = value;
    });
    var value = (point.value === null || point.value === undefined) ? null : Number(point.value);
    return {
      at: Number(point.at),
      value: isFinite(value) ? value : null,
      prices: prices,
      live: point.live === true
    };
  }

  function normalizePoints(points) {
    if (!Array.isArray(points)) return [];
    var normalized = [];
    var needsSort = false;
    for (var i = 0; i < points.length; i++) {
      var point = points[i];
      if (!point || !isFinite(Number(point.at)) ||
          (point.value !== null && (point.value === undefined || !isFinite(Number(point.value))))) continue;
      var copy = pointCopy(point);
      if (normalized.length && normalized[normalized.length - 1].at > copy.at) needsSort = true;
      normalized.push(copy);
    }
    if (needsSort) normalized.sort(function (a, b) { return a.at - b.at; });
    return normalized;
  }

  function compactPoints(points) {
    return normalizePoints(points);
  }

  function scopeData(scope) {
    var key = String(scope || 'default');
    if (!store.scopes[key] || typeof store.scopes[key] !== 'object') {
      store.scopes[key] = { points: [], pointsNormalized: true, period: '1M', from: '', to: '', signature: '' };
    }
    var data = store.scopes[key];
    data.scopeKey = key;
    if (!data.pointsNormalized) {
      data.points = normalizePoints(data.points);
      data.pointsNormalized = true;
    } else if (!Array.isArray(data.points)) data.points = [];
    applyRangePreference(data);
    if (!PERIODS[data.period] && data.period !== 'ALL' && data.period !== 'CUSTOM') data.period = '1M';
    return data;
  }

  function buildUi() {
    var panel = byId('networth-history');
    if (!panel || panel.getAttribute('data-wired') === 'true') return;
    panel.setAttribute('data-wired', 'true');

    var datePicker = byId('history-custom-picker');
    function positionDatePicker() {
      if (!datePicker || !datePicker.open) return;
      var summary = datePicker.querySelector('summary');
      var fieldset = byId('history-custom');
      if (!summary || !fieldset) return;
      var rect = summary.getBoundingClientRect();
      var above = rect.top - 12;
      var below = root.innerHeight - rect.bottom - 12;
      var opensUp = below < fieldset.scrollHeight && above > below;
      datePicker.classList.toggle('opens-up', opensUp);
      fieldset.style.maxHeight = Math.max(120, opensUp ? above : below) + 'px';
    }

    panel.querySelectorAll('[data-history-period]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (!active) return;
        active.loadedKey = '';
        active.period = button.getAttribute('data-history-period');
        active.rangeStart = null;
        active.rangeEnd = null;
        active.from = '';
        active.to = '';
        saveRangePreference(active);
        draw();
        requestHistory();
      });
    });

    if (datePicker) {
      datePicker.addEventListener('toggle', positionDatePicker);
      root.addEventListener('resize', positionDatePicker);
      root.document.addEventListener('click', function (event) {
        if (datePicker.open && !datePicker.contains(event.target)) datePicker.open = false;
      });
      datePicker.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && datePicker.open) {
          datePicker.open = false;
          var summary = datePicker.querySelector('summary');
          if (summary) summary.focus();
        }
      });
    }

    var fromInput = byId('history-date-from');
    var toInput = byId('history-date-to');
    if (fromInput) fromInput.addEventListener('change', function () {
      if (!active) return;
      active.loadedKey = '';
      active.period = 'CUSTOM';
      active.rangeStart = null;
      active.rangeEnd = null;
      active.from = fromInput.value;
      if (active.to && active.from > active.to) active.to = active.from;
      saveRangePreference(active);
      draw();
      requestHistory();
    });
    if (toInput) toInput.addEventListener('change', function () {
      if (!active) return;
      active.loadedKey = '';
      active.period = 'CUSTOM';
      active.rangeStart = null;
      active.rangeEnd = null;
      active.to = toInput.value;
      if (active.from && active.to < active.from) active.from = active.to;
      saveRangePreference(active);
      draw();
      requestHistory();
    });

    var retryButton = byId('history-retry');
    if (retryButton) retryButton.addEventListener('click', function () {
      if (!active) return;
      if (historyRetryTimer !== null) root.clearTimeout(historyRetryTimer);
      historyRetryTimer = null;
      active.loadedKey = '';
      active.loadingKey = '';
      active.loadError = '';
      active.loadMessage = '';
      active.retryCounts = active.retryCounts || {};
      var range = currentRange();
      var key = [active.sourceSignature, active.period,
        Math.floor(range.start / (active.period === 'CUSTOM' ? 1 : 300000)),
        Math.floor(range.end / (active.period === 'CUSTOM' ? 1 : 300000))].join('|');
      delete active.retryCounts[key];
      if (typeof active.prepareRetry === 'function') active.prepareRetry();
      draw();
      requestHistory();
    });

    var infoButton = byId('history-load-info-button');
    if (infoButton) infoButton.addEventListener('click', function () {
      var details = byId('history-load-details');
      if (!details) return;
      var expanded = infoButton.getAttribute('aria-expanded') === 'true';
      details.hidden = expanded;
      infoButton.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    });

    var startRange = byId('history-range-start');
    var endRange = byId('history-range-end');
    var rangeTrack = byId('history-navigator-wrap');
    [startRange, endRange].forEach(function (handle, index) {
      if (!handle) return;
      handle.addEventListener('keydown', function (event) {
        var current = rangeValue(handle);
        var next = current;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next -= 1;
        else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next += 1;
        else if (event.key === 'PageDown') next -= 50;
        else if (event.key === 'PageUp') next += 50;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = 1000;
        else return;
        event.preventDefault();
        setRangeValue(handle, Math.max(0, Math.min(1000, next)));
        onRangeInput(index === 0);
      });
    });
    if (rangeTrack) {
      rangeTrack.addEventListener('pointerdown', function (event) {
        if (!active || !active.points.length) return;
        var target = event.target.closest('.history-range-thumb');
        if (target && target.disabled) return;
        var rect = rangeTrack.getBoundingClientRect();
        if (!rect.width) return;
        if (!target) {
          var ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          var position = ratio * 1000;
          target = Math.abs(position - rangeValue(startRange)) <= Math.abs(position - rangeValue(endRange))
            ? startRange : endRange;
        }
        if (target.disabled) return;
        rangeDrag = { pointerId: event.pointerId, startChanged: target === startRange };
        rangeTrack.setPointerCapture(event.pointerId);
        moveRangeFromPointer(event, rangeTrack);
        event.preventDefault();
      });
      rangeTrack.addEventListener('pointermove', function (event) {
        if (rangeDrag && rangeDrag.pointerId === event.pointerId) moveRangeFromPointer(event, rangeTrack);
      });
      rangeTrack.addEventListener('pointerup', function (event) {
        if (rangeDrag && rangeDrag.pointerId === event.pointerId) rangeDrag = null;
      });
      rangeTrack.addEventListener('pointercancel', function () { rangeDrag = null; });
      rangeTrack.addEventListener('lostpointercapture', function () { rangeDrag = null; });
    }

    var plot = byId('history-plot');
    if (plot) {
      plot.addEventListener('pointermove', onPlotMove);
      plot.addEventListener('pointerdown', onPlotDown);
      plot.addEventListener('pointerleave', function (event) {
        if (event.pointerType === 'touch' || !pinned) clearPlotHover();
      });
      plot.addEventListener('pointerup', clearTouchHover);
      plot.addEventListener('pointercancel', clearTouchHover);
      plot.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          clearPlotHover();
        }
      });
    }
  }

  function currentRange() {
    if (!active) return { start: 0, end: Date.now() };
    var now = Date.now();
    var oldest = Number(active.historyStart) || (active.points.length ? active.points[0].at : now);
    if (active.period === 'ALL') return { start: oldest, end: now };
    if (active.period === 'CUSTOM') {
      if (active.rangeStart !== null && active.rangeStart !== undefined &&
          active.rangeEnd !== null && active.rangeEnd !== undefined &&
          isFinite(Number(active.rangeStart)) && isFinite(Number(active.rangeEnd))) {
        var customStart = Math.max(oldest, Number(active.rangeStart));
        return { start: customStart, end: Math.max(customStart + 1, Math.min(now, Number(active.rangeEnd))) };
      }
      var from = dateTimestamp(active.from || dateKey(oldest), false);
      var to = dateTimestamp(active.to || dateKey(now), true);
      var customFrom = Math.max(oldest, isFinite(from) ? from : oldest);
      return { start: customFrom, end: Math.max(customFrom + 1, Math.min(now, isFinite(to) ? to : now)) };
    }
    return { start: Math.max(oldest, now - PERIODS[active.period]), end: now };
  }

  function visiblePoints(range) {
    var points = active ? active.points : [];
    var low = 0;
    var high = points.length;
    while (low < high) {
      var middle = Math.floor((low + high) / 2);
      if (points[middle].at < range.start) low = middle + 1;
      else high = middle;
    }
    var start = low;
    high = points.length;
    while (low < high) {
      var upperMiddle = Math.floor((low + high) / 2);
      if (points[upperMiddle].at <= range.end) low = upperMiddle + 1;
      else high = upperMiddle;
    }
    return points.slice(start, low);
  }

  function samplePoints(points, start, end, width) {
    var bucketCount = Math.max(1, Math.floor(width));
    if (points.length <= bucketCount * 2) return points;
    var span = Math.max(1, end - start);
    var buckets = [];
    points.forEach(function (point, index) {
      var bucketIndex = Math.max(0, Math.min(bucketCount - 1,
        Math.floor((point.at - start) / span * bucketCount)));
      var bucket = buckets[bucketIndex];
      var value = Number(point.value);
      if (!bucket) {
        buckets[bucketIndex] = { min: index, max: index };
      } else {
        if (value < Number(points[bucket.min].value)) bucket.min = index;
        if (value > Number(points[bucket.max].value)) bucket.max = index;
      }
    });
    var indexes = [0];
    buckets.forEach(function (bucket) {
      if (!bucket) return;
      if (indexes[indexes.length - 1] !== bucket.min) indexes.push(bucket.min);
      if (indexes[indexes.length - 1] !== bucket.max) indexes.push(bucket.max);
    });
    if (indexes[indexes.length - 1] !== points.length - 1) indexes.push(points.length - 1);
    indexes.sort(function (a, b) { return a - b; });
    var sampled = [];
    indexes.forEach(function (index) {
      if (!sampled.length || sampled[sampled.length - 1] !== points[index]) sampled.push(points[index]);
    });
    return sampled;
  }

  function setText(id, text) {
    var node = byId(id);
    if (node) node.textContent = text;
  }

  function rangeValue(handle) {
    return handle ? Number(handle.getAttribute('aria-valuenow')) : 0;
  }

  function setRangeValue(handle, value) {
    if (!handle) return;
    var bounded = Math.max(0, Math.min(1000, Math.round(value)));
    handle.setAttribute('aria-valuenow', String(bounded));
    handle.style.left = (bounded / 10) + '%';
  }

  function moveRangeFromPointer(event, track) {
    var rect = track.getBoundingClientRect();
    if (!rect.width || !rangeDrag) return;
    var position = Math.max(0, Math.min(1000, (event.clientX - rect.left) / rect.width * 1000));
    setRangeValue(byId(rangeDrag.startChanged ? 'history-range-start' : 'history-range-end'), position);
    onRangeInput(rangeDrag.startChanged);
  }

  function onRangeInput(startChanged) {
    if (!active || !active.points.length) return;
    var start = byId('history-range-start');
    var end = byId('history-range-end');
    var min = Number(active.historyStart) || active.points[0].at;
    var max = active.points[active.points.length - 1].at;
    var maxValue = 1000;
    var low = rangeValue(start);
    var high = rangeValue(end);
    if (high - low < 2) {
      if (startChanged) low = Math.max(0, high - 2);
      else high = Math.min(maxValue, low + 2);
      setRangeValue(start, low);
      setRangeValue(end, high);
    }
    active.rangeStart = min + (max - min) * low / maxValue;
    active.rangeEnd = min + (max - min) * high / maxValue;
    active.period = 'CUSTOM';
    active.from = dateKey(active.rangeStart);
    active.to = dateKey(active.rangeEnd);
    active.loadedKey = '';
    saveRangePreference(active);
    draw();
    if (rangeRequestTimer !== null) root.clearTimeout(rangeRequestTimer);
    rangeRequestTimer = root.setTimeout(function () {
      rangeRequestTimer = null;
      requestHistory();
    }, 180);
  }

  function requestHistory() {
    if (!active || typeof active.loadHistory !== 'function') return;
    var data = active;
    var range = currentRange();
    var keyPrecision = data.period === 'CUSTOM' ? 1 : 300000;
    var key = [
      data.sourceSignature,
      data.period,
      Math.floor(range.start / keyPrecision),
      Math.floor(range.end / keyPrecision)
    ].join('|');
    if (data.loadingKey === key || data.loadedKey === key) return;
    var sequence = ++requestSequence;
    data.loadingKey = key;
    data.loading = true;
    data.loadError = '';
    data.loadMessage = '';
    data.progress = {
      phase: 'start',
      startedAt: Date.now(),
      symbols: [],
      totalAssets: 0,
      completedAssets: 0,
      assets: {},
      completedValues: 0,
      totalValues: 0,
      start: range.start,
      end: range.end
    };
    var infoButton = byId('history-load-info-button');
    var details = byId('history-load-details');
    if (infoButton) infoButton.setAttribute('aria-expanded', 'false');
    if (details) details.hidden = true;
    // No banner yet: a load served from saved prices is instant and the
    // chart is already complete. 'loading' is reported only once a real
    // download/retry starts (see updateLoadProgress).
    data.loadingReported = false;
    draw();
    if (historyProgressTimer !== null) root.clearInterval(historyProgressTimer);
    historyProgressTimer = root.setInterval(function () {
      if (active === data && data.loading) renderLoadDetails(data);
    }, 1000);
    Promise.resolve(storageReadyPromise).then(function () {
      return new Promise(function (resolve, reject) {
        function startLoad() {
          if (sequence !== requestSequence || active !== data || data.loadingKey !== key) {
            resolve(null);
            return;
          }
          try {
            Promise.resolve(data.loadHistory({
              period: data.period,
              start: range.start,
              end: range.end,
              isCurrent: function () {
                return sequence === requestSequence && active === data && data.loadingKey === key;
              },
              onProgress: function (progress) {
                if (sequence !== requestSequence || active !== data || data.loadingKey !== key) return;
                updateLoadProgress(data, progress);
                draw();
              }
            })).then(resolve, reject);
          } catch (error) {
            reject(error);
          }
        }
        runAfterPaint(startLoad);
      });
    }).then(function (result) {
      if (sequence !== requestSequence || active !== data || data.loadingKey !== key) return;
      if (!result) return;
      if (!result || !Array.isArray(result.points)) throw new Error('History provider returned no points.');
      var historyDays = {};
      var incoming = normalizePoints(result.points);
      incoming.forEach(function (point) {
        if (!point.live) historyDays[dateKey(point.at)] = true;
      });
      var today = dateKey(Date.now());
      var merged = [];
      var existingIndex = 0;
      var incomingIndex = 0;
      while (existingIndex < data.points.length || incomingIndex < incoming.length) {
        var existing = existingIndex < data.points.length ? data.points[existingIndex] : null;
        var next = incomingIndex < incoming.length ? incoming[incomingIndex] : null;
        if (existing && existing.live && dateKey(existing.at) < today &&
            historyDays[dateKey(existing.at)]) {
          existingIndex++;
          continue;
        }
        if (existing && next && existing.at === next.at) {
          merged.push(next);
          existingIndex++;
          incomingIndex++;
        } else if (!existing || (next && next.at < existing.at)) {
          merged.push(next);
          incomingIndex++;
        } else {
          merged.push(existing);
          existingIndex++;
        }
      }
      data.points = merged;
      data.pointsNormalized = true;
      navigatorCache = null;
      data.historyStart = Number(result.historyStart) || data.historyStart;
      if (data.historyStart) {
        data.points = data.points.filter(function (point) { return point.at >= data.historyStart; });
      }
      data.signature = data.sourceSignature;
      data.incomplete = !!result.incomplete;
      data.loadMessage = String(result.message || '');
      data.loadedKey = key;
      data.loadingKey = '';
      data.loading = false;
      data.progress.phase = data.incomplete ? 'incomplete' : 'complete';
      if (historyProgressTimer !== null) root.clearInterval(historyProgressTimer);
      historyProgressTimer = null;
      if (data.incomplete) {
        reportStatus(data, 'incomplete', key, data.loadMessage);
        scheduleHistoryRetry(data, key);
      } else {
        if (data.retryCounts) delete data.retryCounts[key];
        // Finished cleanly: retire the "loading" banner if one was shown.
        if (data.loadingReported) reportStatus(data, 'complete', key, '');
      }
      data.loadingReported = false;
      saveStore(data);
      draw();
    }).catch(function (error) {
      if (sequence !== requestSequence || active !== data || data.loadingKey !== key) return;
      data.loadingKey = '';
      data.loading = false;
      data.incomplete = true;
      data.loadError = String(error && error.message ? error.message : error);
      data.loadedKey = key;
      data.progress.phase = 'error';
      if (historyProgressTimer !== null) root.clearInterval(historyProgressTimer);
      historyProgressTimer = null;
      reportStatus(data, 'error', key, data.loadError);
      scheduleHistoryRetry(data, key);
      draw();
    });
  }

  function updateLoadProgress(data, event) {
    if (!data.progress || !event) return;
    var progress = data.progress;
    progress.phase = event.phase || progress.phase;
    progress.current = event;
    if (data.loading && !data.loadingReported &&
        (event.phase === 'download' || event.phase === 'retry' || event.phase === 'download-error')) {
      data.loadingReported = true;
      reportStatus(data, 'loading', data.loadingKey, 'Loading historical market prices for the selected interval.');
    }
    if (Array.isArray(event.symbols)) {
      progress.symbols = event.symbols.slice();
      progress.totalAssets = Number(event.totalAssets) || event.symbols.length;
      progress.start = Number(event.start) || progress.start;
      progress.end = Number(event.end) || progress.end;
    }
    if ((event.phase === 'download' || event.phase === 'cache') && event.symbol) {
      progress.assets[event.symbol] = {
        provider: event.provider,
        completed: Number(event.completed) || 0,
        total: Number(event.total) || 0,
        start: Number(event.assetStart) || progress.start,
        end: Number(event.assetEnd) || progress.end
      };
    } else if (event.phase === 'asset-complete' && event.symbol) {
      var asset = progress.assets[event.symbol] || { completed: 0, total: 0 };
      asset.start = Number(event.assetStart) || progress.start;
      asset.end = Number(event.assetEnd) || progress.end;
      if (!asset.total) asset.total = Math.max(1,
        Math.ceil((asset.end - asset.start) / (180 * 86400000)));
      asset.completed = asset.total;
      asset.done = true;
      asset.failed = !!event.failed;
      asset.error = String(event.error || '');
      progress.assets[event.symbol] = asset;
      progress.completedAssets = Number(event.completedAssets) || 0;
    } else if (event.phase === 'valuation') {
      progress.completedValues = Number(event.completed) || 0;
      progress.totalValues = Number(event.total) || 0;
    }
  }

  function formatElapsed(milliseconds) {
    var seconds = Math.max(0, Math.floor(milliseconds / 1000));
    var minutes = Math.floor(seconds / 60);
    seconds %= 60;
    return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function displayRangeDate(timestamp) {
    try {
      return new Date(timestamp).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch (e) {
      return dateKey(timestamp);
    }
  }

  function renderLoadDetails(data) {
    var status = byId('history-load-status');
    var infoButton = byId('history-load-info-button');
    var details = byId('history-load-details');
    var summary = byId('history-load-summary');
    var duration = byId('history-load-duration');
    var meter = byId('history-load-progress');
    if (!data || !status || !infoButton || !details) return;

    var progress = data.progress;
    var current = progress && progress.current;
    var visible = !!(data.loading || data.incomplete || data.loadError);
    infoButton.hidden = !visible;
    if (!visible) {
      details.hidden = true;
      infoButton.setAttribute('aria-expanded', 'false');
      status.textContent = '';
      return;
    }

    var rangeText = progress
      ? displayRangeDate(progress.start) + ' to ' + displayRangeDate(progress.end)
      : 'Selected interval';
    if (data.loading && current && current.phase === 'retry') {
      status.textContent = 'Retrying ' + current.symbol + ' — ' + current.provider +
        ', chunk ' + (Number(current.completed) + 1) + ' of ' + current.total + ' (attempt ' + current.attempt + ').';
    } else if (data.loading && current && current.phase === 'cache') {
      status.textContent = 'Reusing saved historical prices for ' + current.symbol + '.';
    } else if (data.loading && current && current.phase === 'download-error') {
      status.textContent = 'Could not load ' + current.symbol + ' chunk ' +
        (Number(current.completed) + 1) + ' of ' + current.total + '; trying another source.';
    } else if (data.loading && current && current.phase === 'download') {
      status.textContent = 'Downloading ' + current.symbol + ' — ' + current.provider +
        ', chunk ' + (Number(current.completed) + (Number(current.completed) < Number(current.total) ? 1 : 0)) +
        ' of ' + current.total + '.';
    } else if (data.loading && current && current.phase === 'valuation') {
      status.textContent = 'Calculating portfolio values: ' + current.completed + ' of ' + current.total + ' dates.';
    } else if (data.loading && current && current.phase === 'asset-complete') {
      status.textContent = 'Loaded historical prices for ' + current.completedAssets + ' of ' + current.totalAssets + ' assets.';
    } else if (data.loading) {
      status.textContent = 'Preparing historical prices for the selected interval…';
    } else if (data.loadError) {
      status.textContent = 'Historical market data could not be loaded.';
    } else if (data.incomplete) {
      status.textContent = 'Some historical values are still unavailable.';
    } else {
      status.textContent = 'Historical market data loaded.';
    }

    var completedAssets = progress ? Number(progress.completedAssets) || 0 : 0;
    var totalChunks = 0;
    var completedChunks = 0;
    if (progress) {
      var defaultChunks = Math.max(1, Math.ceil((progress.end - progress.start) / (180 * 86400000)));
      progress.symbols.forEach(function (symbol) {
        var asset = progress.assets[symbol];
        var assetChunks = asset
          ? Math.max(1, Math.ceil(((asset.end || progress.end) - (asset.start || progress.start)) /
            (180 * 86400000)))
          : defaultChunks;
        totalChunks += asset && asset.total ? asset.total : assetChunks;
        completedChunks += asset && asset.done
          ? (asset.total || assetChunks)
          : (asset ? Math.min(asset.completed, asset.total || 0) : 0);
      });
    }
    var lines = [
      'Date range: ' + rangeText,
      'Assets ready: ' + completedAssets + ' of ' + (progress ? progress.totalAssets : 0),
      'History chunks: ' + completedChunks + ' of ' + totalChunks
    ];
    if (progress) {
      progress.symbols.forEach(function (symbol) {
        var asset = progress.assets[symbol];
        if (asset && asset.failed) {
          lines.push('No history loaded for ' + symbol + (asset.error ? ': ' + asset.error : '.'));
        }
      });
    }
    if (current && current.phase === 'download') {
      lines.push('Current download: ' + current.symbol + ' · ' + current.provider);
      lines.push('Chunk range: ' + displayRangeDate(current.start) + ' to ' + displayRangeDate(current.end));
    } else if (current && current.phase === 'cache') {
      lines.push('Using saved prices: ' + current.symbol + ' · ' + current.provider);
      lines.push('Cached range: ' + displayRangeDate(current.start) + ' to ' + displayRangeDate(current.end));
    } else if (current && current.phase === 'retry') {
      lines.push('Retrying: ' + current.symbol + ' · ' + current.provider + ' · attempt ' + current.attempt);
    } else if (current && current.phase === 'download-error') {
      lines.push('Source error: ' + current.error);
    }
    if (progress && progress.totalValues) {
      lines.push('Portfolio values calculated: ' + progress.completedValues + ' of ' + progress.totalValues);
    }
    var elapsed = progress ? Date.now() - progress.startedAt : 0;
    lines.push('Elapsed: ' + formatElapsed(elapsed));
    var completedWork = completedChunks + (progress ? progress.completedValues : 0);
    var totalWork = totalChunks + (progress ? progress.totalValues : 0);
    if (data.loading && elapsed >= 1000 && completedWork > 0 && totalWork > completedWork) {
      var eta = elapsed * (totalWork - completedWork) / completedWork;
      lines.push('Estimated remaining: ' + formatElapsed(eta));
    } else if (data.loading) {
      lines.push('Estimated remaining: calculating after the first completed chunk.');
    } else if (data.loadError || data.incomplete) {
      lines.push(data.loadError || data.loadMessage || 'Some values could not be retrieved. Use Retry to try again.');
    }
    if (summary) summary.textContent = lines.join('\n');
    if (duration) duration.textContent = 'Total elapsed: ' + formatElapsed(elapsed) + '.';
    if (meter) {
      meter.max = Math.max(1, totalWork);
      meter.value = Math.min(completedWork, totalWork);
      meter.hidden = !data.loading || !totalWork;
    }
    details.hidden = infoButton.getAttribute('aria-expanded') !== 'true';
  }

  function reportStatus(data, state, key, message) {
    var statusKey = [data.scopeKey, state, key].join('|');
    if (statusKey === lastReportedStatus || typeof data.onStatus !== 'function') return;
    lastReportedStatus = statusKey;
    data.onStatus({ state: state, message: message, key: key });
  }

  function scheduleHistoryRetry(data, key) {
    data.retryCounts = data.retryCounts || {};
    var attempt = Number(data.retryCounts[key]) || 0;
    if (attempt >= 2) return;
    data.retryCounts[key] = attempt + 1;
    if (historyRetryTimer !== null) root.clearTimeout(historyRetryTimer);
    historyRetryTimer = root.setTimeout(function () {
      historyRetryTimer = null;
      if (active !== data || data.loadedKey !== key || data.loading) return;
      data.loadedKey = '';
      if (typeof data.prepareRetry === 'function') data.prepareRetry();
      requestHistory();
    }, attempt === 0 ? 15000 : 60000);
  }

  function syncRangeInputs(range) {
    var start = byId('history-range-start');
    var end = byId('history-range-end');
    if (!start || !end) return;
    if (!active || !active.points.length) {
      start.disabled = true;
      end.disabled = true;
      setRangeValue(start, 0);
      setRangeValue(end, 1000);
      return;
    }
    var min = Number(active.historyStart) || active.points[0].at;
    var max = active.points[active.points.length - 1].at;
    var hasRange = max > min;
    var span = Math.max(1, max - min);
    var low = Math.max(0, Math.min(1000, Math.round((range.start - min) / span * 1000)));
    var high = Math.max(0, Math.min(1000, Math.round((range.end - min) / span * 1000)));
    if (high - low < 2) {
      if (low >= 999) low = 998;
      else high = Math.min(1000, low + 2);
    }
    setRangeValue(start, low);
    setRangeValue(end, high);
    start.disabled = !hasRange;
    end.disabled = !hasRange;
    start.setAttribute('aria-valuetext', displayDate(min + span * low / 1000, true));
    end.setAttribute('aria-valuetext', displayDate(min + span * high / 1000, true));
  }

  function renderNavigator() {
    var svg = byId('history-navigator');
    if (!svg || !active) return;
    clear(svg);
    var points = active.points;
    if (!points.length) return;
    var width = 900;
    var height = 72;
    var minT = Number(active.historyStart) || points[0].at;
    var maxT = Math.max(minT + 1, points[points.length - 1].at);
    if (!navigatorCache || navigatorCache.active !== active ||
        navigatorCache.points !== points || navigatorCache.minT !== minT ||
        navigatorCache.maxT !== maxT) {
      var validPoints = points.filter(function (point) {
        return point.value !== null && isFinite(Number(point.value));
      });
      var minV = Infinity;
      var maxV = -Infinity;
      validPoints.forEach(function (point) {
        var value = Number(point.value);
        minV = Math.min(minV, value);
        maxV = Math.max(maxV, value);
      });
      if (minV === maxV) { minV -= 1; maxV += 1; }
      var pathPoints = samplePoints(validPoints, minT, maxT, width);
      var path = '';
      var segmentOpen = false;
      pathPoints.forEach(function (point) {
        if (point.at < minT) return;
        var x = (point.at - minT) / (maxT - minT) * width;
        var y = height - 6 - ((Number(point.value) - minV) / (maxV - minV)) * (height - 12);
        path += (segmentOpen ? ' L ' : 'M ') + x.toFixed(2) + ' ' + y.toFixed(2);
        segmentOpen = true;
      });
      navigatorCache = {
        active: active,
        points: points,
        minT: minT,
        maxT: maxT,
        path: path,
        onlyPoint: validPoints.length === 1 ? validPoints[0] : null
      };
    }
    if (!navigatorCache.path) return;
    svg.appendChild(svgElement('path', { d: navigatorCache.path, 'class': 'history-navigator-line' }));
    if (navigatorCache.onlyPoint) {
      var only = navigatorCache.onlyPoint;
      svg.appendChild(svgElement('circle', {
        cx: (only.at - minT) / (maxT - minT) * width,
        cy: height / 2,
        r: 3,
        'class': 'history-navigator-point'
      }));
    }
    var range = currentRange();
    var x1 = Math.max(0, Math.min(width, (range.start - minT) / (maxT - minT) * width));
    var x2 = Math.max(x1 + 1, Math.min(width, (range.end - minT) / (maxT - minT) * width));
    svg.appendChild(svgElement('rect', {
      x: x1, y: 1, width: Math.max(1, x2 - x1), height: height - 2,
      'class': 'history-navigator-selection'
    }));
    [x1, x2].forEach(function (x) {
      svg.appendChild(svgElement('line', {
        x1: x, x2: x, y1: 0, y2: height, 'class': 'history-navigator-handle'
      }));
    });
    setRangeValue(byId('history-range-start'), x1 / width * 1000);
    setRangeValue(byId('history-range-end'), x2 / width * 1000);
  }

  function smoothLinePath(points, xAt, yAt) {
    if (!points.length) return '';
    var coordinates = points.map(function (point) {
      return { x: xAt(point.at), y: yAt(Number(point.value)) };
    });
    if (coordinates.length === 1) return 'M ' + coordinates[0].x.toFixed(2) + ' ' + coordinates[0].y.toFixed(2);

    var slopes = [];
    var tangents = [];
    for (var i = 0; i < coordinates.length - 1; i++) {
      slopes.push((coordinates[i + 1].y - coordinates[i].y) /
        (coordinates[i + 1].x - coordinates[i].x));
    }
    tangents[0] = slopes[0];
    tangents[coordinates.length - 1] = slopes[slopes.length - 1];
    for (var j = 1; j < coordinates.length - 1; j++) {
      var previousSlope = slopes[j - 1];
      var nextSlope = slopes[j];
      if (previousSlope * nextSlope <= 0) {
        tangents[j] = 0;
      } else {
        var previousWidth = coordinates[j].x - coordinates[j - 1].x;
        var nextWidth = coordinates[j + 1].x - coordinates[j].x;
        var previousWeight = 2 * nextWidth + previousWidth;
        var nextWeight = nextWidth + 2 * previousWidth;
        tangents[j] = (previousWeight + nextWeight) /
          (previousWeight / previousSlope + nextWeight / nextSlope);
      }
    }

    var path = 'M ' + coordinates[0].x.toFixed(2) + ' ' + coordinates[0].y.toFixed(2);
    for (var k = 0; k < coordinates.length - 1; k++) {
      var from = coordinates[k];
      var to = coordinates[k + 1];
      var width = to.x - from.x;
      path += ' C ' +
        (from.x + width / 3).toFixed(2) + ' ' + (from.y + tangents[k] * width / 3).toFixed(2) + ' ' +
        (to.x - width / 3).toFixed(2) + ' ' + (to.y - tangents[k + 1] * width / 3).toFixed(2) + ' ' +
        to.x.toFixed(2) + ' ' + to.y.toFixed(2);
    }
    return path;
  }

  function drawPlot(points, range) {
    var svg = byId('history-plot');
    if (!svg) return [];
    clear(svg);
    var validPoints = points.filter(function (point) { return point.value !== null && isFinite(Number(point.value)); });
    lastDrawn = validPoints;
    if (!validPoints.length) {
      setText('history-empty', active && active.loading
        ? 'Updating portfolio history…'
        : (active && active.points.length
          ? 'No saved values with complete price coverage fall within this interval yet.'
          : 'History starts collecting once a portfolio value is available.'));
      return validPoints;
    }
    setText('history-empty', active && active.loading && validPoints.length === 1
      ? 'Updating portfolio history…'
      : '');

    var width = 960;
    var height = 260;
    var left = 82;
    var right = 948;
    var top = 14;
    var bottom = 220;
    var min = Infinity;
    var max = -Infinity;
    validPoints.forEach(function (point) {
      var value = Number(point.value);
      min = Math.min(min, value);
      max = Math.max(max, value);
    });
    var padding = Math.max((max - min) * 0.12, Math.max(Math.abs(min), Math.abs(max), 1) * 0.004);
    min = min >= 0 ? Math.max(0, min - padding) : min - padding;
    max += padding;
    if (max === min) max = min + 1;
    var start = validPoints[0].at;
    var end = Math.max(start + 1, range.end);
    function xAt(time) { return left + ((time - start) / (end - start)) * (right - left); }
    function yAt(value) { return bottom - ((value - min) / (max - min)) * (bottom - top); }

    for (var grid = 0; grid < 4; grid++) {
      var gy = top + (bottom - top) * grid / 3;
      var gv = max - (max - min) * grid / 3;
      svg.appendChild(svgElement('line', { x1: left, x2: right, y1: gy, y2: gy, 'class': 'history-grid' }));
      var label = svgElement('text', { x: left - 10, y: gy + 4, 'text-anchor': 'end', 'class': 'history-axis-label' });
      label.textContent = money(gv, active.currency);
      svg.appendChild(label);
    }

    var pathPoints = samplePoints(validPoints, start, end, right - left);
    var d = smoothLinePath(pathPoints, xAt, yAt);
    var positive = Number(validPoints[validPoints.length - 1].value) >= Number(validPoints[0].value);
    if (d) svg.appendChild(svgElement('path', { d: d, 'class': 'history-line ' + (positive ? 'is-positive' : 'is-negative') }));
    if (validPoints.length === 1) {
      svg.appendChild(svgElement('circle', {
        cx: xAt(validPoints[0].at),
        cy: yAt(Number(validPoints[0].value)),
        r: 4,
        'class': 'history-single-point'
      }));
    }

    var labelIndices = [0, Math.round((validPoints.length - 1) / 3),
      Math.round((validPoints.length - 1) * 2 / 3), validPoints.length - 1];
    var labels = [];
    labelIndices.forEach(function (index, labelIndex) {
      var labelText = displayDate(validPoints[index].at, true);
      if (labels.some(function (label) { return label.text === labelText; })) return;
      var point = validPoints[index];
      var anchor = labelIndex === 0 ? 'start' : (labelIndex === labelIndices.length - 1 ? 'end' : 'middle');
      var dateLabel = svgElement('text', {
        x: xAt(point.at), y: 248, 'text-anchor': anchor,
        'class': 'history-axis-label'
      });
      dateLabel.textContent = labelText;
      svg.appendChild(dateLabel);
      var bounds = dateLabel.getBoundingClientRect();
      var leftEdge = bounds.left;
      var rightEdge = bounds.right;
      if (labelIndex === labelIndices.length - 1) {
        while (labels.length > 1 && leftEdge < labels[labels.length - 1].right + 4) {
          svg.removeChild(labels.pop().node);
        }
      }
      if (labels.length && leftEdge < labels[labels.length - 1].right + 4) {
        svg.removeChild(dateLabel);
        return;
      }
      labels.push({ node: dateLabel, text: dateLabel.textContent, right: rightEdge });
    });

    if (hoverPoint && points.indexOf(hoverPoint) !== -1) {
      var hx = xAt(hoverPoint.at);
      var hy = yAt(Number(hoverPoint.value));
      svg.appendChild(svgElement('line', { x1: hx, x2: hx, y1: top, y2: bottom, 'class': 'history-crosshair' }));
      svg.appendChild(svgElement('circle', { cx: hx, cy: hy, r: 5, 'class': 'history-marker' }));
    }
    return validPoints;
  }

  function draw() {
    if (!active) return;
    var range = currentRange();
    var points = visiblePoints(range);
    var validPoints = drawPlot(points, range);
    renderNavigator();
    syncRangeInputs(range);

    var periodButtons = byId('history-periods');
    if (periodButtons) {
      periodButtons.querySelectorAll('[data-history-period]').forEach(function (button) {
        var selected = button.getAttribute('data-history-period') === active.period;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
    }
    var customLabel = byId('history-custom-label');
    if (customLabel) customLabel.textContent = active.period === 'CUSTOM' ? 'Custom range' : 'Custom dates';
    var from = byId('history-date-from');
    var to = byId('history-date-to');
    if (from && active.points.length) {
      from.min = dateKey(Number(active.historyStart) || active.points[0].at);
      from.max = dateKey(Date.now());
      from.value = active.period === 'CUSTOM'
        ? (active.from || from.min)
        : dateKey(range.start);
    } else if (from) {
      from.value = '';
      from.min = '';
      from.max = '';
    }
    if (to && active.points.length) {
      to.min = dateKey(Number(active.historyStart) || active.points[0].at);
      to.max = dateKey(Date.now());
      to.value = active.period === 'CUSTOM'
        ? (active.to || to.max)
        : dateKey(range.end);
    } else if (to) {
      to.value = '';
      to.min = '';
      to.max = '';
    }

    var shown = hoverPoint && validPoints.indexOf(hoverPoint) !== -1
      ? hoverPoint : (validPoints.length ? validPoints[validPoints.length - 1] : null);
    if (shown) {
      setText('history-value', money(shown.value, active.currency));
      setText('history-date', displayDate(shown.at, false));
      var change = validPoints.length > 1 ? Number(validPoints[validPoints.length - 1].value) - Number(validPoints[0].value) : 0;
      var base = validPoints.length > 1 ? Number(validPoints[0].value) : 0;
      var changeText = base !== 0
        ? ((change >= 0 ? '+' : '') + ((change / Math.abs(base)) * 100).toFixed(2) + '%')
        : money(change, active.currency);
      var changeNode = byId('history-change');
      if (changeNode) {
        changeNode.textContent = changeText;
        changeNode.classList.toggle('gain', change >= 0);
        changeNode.classList.toggle('loss', change < 0);
      }
    } else {
      setText('history-value', '—');
      setText('history-date', '');
      setText('history-change', '');
    }

    var note = byId('history-note');
    var badge = byId('history-local-badge');
    var retryButton = byId('history-retry');
    var panel = byId('networth-history');
    if (panel) panel.setAttribute('aria-busy', active.loading ? 'true' : 'false');
    renderLoadDetails(active);
    if (retryButton) retryButton.hidden = !(active.loadError || active.incomplete);
    if (badge) badge.textContent = storageMessage ? 'Storage issue' : 'Saved locally';
    if (note) {
      note.hidden = !storageMessage && (active.loading || active.loadError || active.incomplete);
      if (storageMessage) note.textContent = storageMessage;
      else if (active.loading) note.textContent = 'Loading historical market prices for this interval…';
      else if (active.loadError) note.textContent = 'Could not load historical chart data: ' + active.loadError;
      else if (active.incomplete) note.textContent = active.loadMessage ||
        'Some assets have no historical prices for this interval. Their values are shown as gaps.';
      else if (active.points.length === 1) note.textContent = 'Only one value is available for this interval.';
      else note.textContent = 'Portfolio history is saved on this device.';
    }
  }

  function nearestPoint(event) {
    var svg = byId('history-plot');
    if (!svg || !lastDrawn.length) return null;
    var rect = svg.getBoundingClientRect();
    if (!rect.width) return null;
    var x = (event.clientX - rect.left) / rect.width * 960;
    var start = currentRange().start;
    var end = Math.max(start + 1, currentRange().end);
    var target = start + (x - 82) / (948 - 82) * (end - start);
    var low = 0;
    var high = lastDrawn.length - 1;
    while (low < high) {
      var middle = Math.floor((low + high) / 2);
      if (lastDrawn[middle].at < target) low = middle + 1;
      else high = middle;
    }
    if (low > 0 && Math.abs(lastDrawn[low - 1].at - target) <
        Math.abs(lastDrawn[low].at - target)) low--;
    return lastDrawn[low];
  }

  function onPlotMove(event) {
    var point = nearestPoint(event);
    if (!point || (pinned && event.pointerType !== 'touch')) return;
    hoverPoint = point;
    draw();
  }

  function onPlotDown(event) {
    var point = nearestPoint(event);
    if (!point) return;
    pinned = true;
    hoverPoint = point;
    draw();
  }

  function clearTouchHover(event) {
    if (event.pointerType === 'touch') clearPlotHover();
  }

  function clearPlotHover() {
    pinned = false;
    hoverPoint = null;
    draw();
  }

  function revalue(data, context) {
    var signature = String(context.signature || '');
    if (!signature || data.signature === signature || data.pendingSignature === signature || !data.points.length) return;
    data.pendingSignature = signature;
    data.pendingContext = context;
    data.updating = true;
    data.incomplete = false;
    navigatorCache = null;
    draw();

    var points = data.points.slice();
    var index = 0;
    var incomplete = false;
    function next() {
      if (data.pendingSignature !== signature) return;
      if (index >= points.length) {
        data.signature = signature;
        data.pendingSignature = '';
        data.pendingContext = null;
        data.updating = false;
        data.incomplete = incomplete;
        navigatorCache = null;
        saveStore(data);
        draw();
        return;
      }
      var point = points[index++];
      Promise.resolve().then(function () {
        return context.revalue(pointCopy(point));
      }).then(function (result) {
        if (result && Object.prototype.hasOwnProperty.call(result, 'value')) {
          for (var i = 0; i < data.points.length; i++) {
            if (data.points[i].at !== point.at) continue;
            data.points[i].value = result.value === null || !isFinite(Number(result.value)) ? null : Number(result.value);
            if (result.prices) {
              data.points[i].prices = pointCopy({
                at: point.at,
                value: data.points[i].value,
                prices: result.prices
              }).prices;
            }
            break;
          }
        } else {
          incomplete = true;
        }
        if (result && result.complete === false) incomplete = true;
        if (index % 10 === 0) saveStore(data);
        root.setTimeout(next, 0);
      }, function () {
        incomplete = true;
        root.setTimeout(next, 0);
      });
    }
    next();
  }

  function record(data, value, prices) {
    if (value === null || value === undefined || !isFinite(Number(value))) return;
    var now = Date.now();
    var bucket = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000);
    var cleanPrices = {};
    Object.keys(prices || {}).forEach(function (symbol) {
      var price = Number(prices[symbol]);
      if (isFinite(price) && price > 0) cleanPrices[String(symbol).toUpperCase()] = price;
    });
    var last = data.points.length ? data.points[data.points.length - 1] : null;
    var nextPoint = { at: bucket, value: Number(value), prices: cleanPrices, live: true };
    if (last && last.at >= bucket && last.at < bucket + 5 * 60 * 1000) {
      nextPoint.at = last.at;
      data.points[data.points.length - 1] = nextPoint;
    } else if (!last || last.at < bucket) {
      data.points.push(nextPoint);
    } else {
      data.points.push(nextPoint);
      data.points = compactPoints(data.points);
    }
    data.pointsNormalized = true;
    navigatorCache = null;
  }

  function update(options) {
    if (!root.document || !options) return;
    if (!storeLoaded) {
      loadStore();
    }
    if (!storageReady) {
      pendingUpdateOptions = options;
      return;
    }
    buildUi();
    var panel = byId('networth-history');
    if (!panel) return;
    active = scopeData(options.scope);
    var nextSignature = String(options.signature || '');
    if (active.signature !== nextSignature) {
      navigatorCache = null;
      active.points = [];
      active.pointsNormalized = true;
      active.rangeStart = null;
      active.rangeEnd = null;
      active.from = '';
      active.to = '';
      active.loadedKey = '';
      active.loadingKey = '';
      active.incomplete = false;
      active.loadError = '';
      active.loadMessage = '';
      active.signature = nextSignature;
    }
    active.currency = String(options.currency || 'EUR').toUpperCase();
    active.historyStart = Number(options.historyStart) || active.historyStart;
    if (active.historyStart && active.points.length && active.points[0].at < active.historyStart) {
      active.points = active.points.filter(function (point) { return point.at >= active.historyStart; });
      active.pointsNormalized = true;
      navigatorCache = null;
    }
    active.sourceSignature = nextSignature;
    active.loadHistory = options.loadHistory;
    active.onStatus = options.onStatus;
    active.prepareRetry = options.prepareRetry;
    active.scopeKey = String(options.scope || 'default');
    active.updating = !!active.updating;
    active.incomplete = !!active.incomplete;
    record(active, options.value, options.prices);
    saveStore(active);
    panel.hidden = false;
    draw();
    requestHistory();
  }

  function refresh() {
    if (!active) return;
    requestSequence++;
    if (historyProgressTimer !== null) root.clearInterval(historyProgressTimer);
    if (historyRetryTimer !== null) root.clearTimeout(historyRetryTimer);
    historyProgressTimer = null;
    historyRetryTimer = null;
    active.loadedKey = '';
    active.loadingKey = '';
    active.loading = false;
    active.incomplete = false;
    active.loadError = '';
    active.loadMessage = '';
    draw();
    requestHistory();
  }

  root.NetWorthHistory = { update: update, refresh: refresh };
}(typeof window !== 'undefined' ? window : this));
