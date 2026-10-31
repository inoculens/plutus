(function (root) {
  'use strict';

  var STORAGE_KEY = 'plutus.networth-history.v1';
  var MAX_POINTS = 1000;
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
  var active = null;
  var svgNS = 'http://www.w3.org/2000/svg';
  var storageMessage = '';
  var storageReadWarning = '';
  var hoverPoint = null;
  var pinned = false;
  var lastDrawn = [];
  var storeLoaded = false;

  function loadStore() {
    try {
      var raw = root.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.scopes && typeof parsed.scopes === 'object' && !Array.isArray(parsed.scopes)) {
        store = parsed;
        Object.keys(store.scopes).forEach(function (key) {
          var data = store.scopes[key];
          if (!data || typeof data !== 'object') return;
          delete data.pendingSignature;
          delete data.pendingContext;
          data.updating = false;
        });
      } else {
        storageReadWarning = 'Saved graph history could not be read; new history is being stored separately.';
        storageMessage = storageReadWarning;
      }
    } catch (e) {
      storageReadWarning = 'Local graph history is unavailable in this browser session.';
      storageMessage = storageReadWarning;
    }
  }

  function saveStore() {
    try {
      var saved = { scopes: {} };
      Object.keys(store.scopes).forEach(function (key) {
        var data = store.scopes[key];
        saved.scopes[key] = {
          points: data.points,
          period: data.period,
          from: data.from,
          to: data.to,
          signature: data.signature,
          incomplete: !!data.incomplete
        };
      });
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      storageMessage = storageReadWarning;
      return true;
    } catch (e) {
      storageMessage = 'Could not save graph history locally. Check available browser storage.';
      return false;
    }
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
    return { at: Number(point.at), value: isFinite(value) ? value : null, prices: prices };
  }

  function normalizePoints(points) {
    if (!Array.isArray(points)) return [];
    return points.filter(function (point) {
      return point && isFinite(Number(point.at)) &&
        (point.value === null || (point.value !== undefined && isFinite(Number(point.value))));
    }).map(pointCopy).sort(function (a, b) { return a.at - b.at; });
  }

  function compactPoints(points) {
    var sorted = normalizePoints(points);
    var latest = sorted.length ? sorted[sorted.length - 1].at : Date.now();
    var recentCutoff = latest - 24 * 60 * 60 * 1000;
    var recent = sorted.filter(function (point) { return point.at >= recentCutoff; });
    var older = sorted.filter(function (point) { return point.at < recentCutoff; });
    var budget = Math.max(0, MAX_POINTS - recent.length);
    if (older.length > budget && budget > 0) {
      var reduced = [];
      var stride = older.length / budget;
      for (var i = 0; i < budget; i++) reduced.push(older[Math.floor(i * stride)]);
      older = reduced;
    } else if (budget === 0) {
      older = [];
    }
    return older.concat(recent);
  }

  function scopeData(scope) {
    var key = String(scope || 'default');
    if (!store.scopes[key] || typeof store.scopes[key] !== 'object') {
      store.scopes[key] = { points: [], period: '1M', from: '', to: '', signature: '' };
    }
    var data = store.scopes[key];
    data.points = normalizePoints(data.points);
    if (!PERIODS[data.period] && data.period !== 'ALL' && data.period !== 'CUSTOM') data.period = '1M';
    return data;
  }

  function buildUi() {
    var panel = byId('networth-history');
    if (!panel || panel.getAttribute('data-wired') === 'true') return;
    panel.setAttribute('data-wired', 'true');

    panel.querySelectorAll('[data-history-period]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (!active) return;
        active.period = button.getAttribute('data-history-period');
        if (active.period === 'CUSTOM') {
          var min = active.points.length ? dateKey(active.points[0].at) : dateKey(Date.now());
          var max = dateKey(Date.now());
          active.from = active.from || min;
          active.to = active.to || max;
        }
        saveStore();
        draw();
      });
    });

    var fromInput = byId('history-date-from');
    var toInput = byId('history-date-to');
    if (fromInput) fromInput.addEventListener('change', function () {
      if (!active) return;
      active.period = 'CUSTOM';
      active.from = fromInput.value;
      if (active.to && active.from > active.to) active.to = active.from;
      saveStore();
      draw();
    });
    if (toInput) toInput.addEventListener('change', function () {
      if (!active) return;
      active.period = 'CUSTOM';
      active.to = toInput.value;
      if (active.from && active.to < active.from) active.from = active.to;
      saveStore();
      draw();
    });

    var startRange = byId('history-range-start');
    var endRange = byId('history-range-end');
    if (startRange) startRange.addEventListener('input', function () { onRangeInput(true); });
    if (endRange) endRange.addEventListener('input', function () { onRangeInput(false); });

    var plot = byId('history-plot');
    if (plot) {
      plot.addEventListener('pointermove', onPlotMove);
      plot.addEventListener('pointerdown', onPlotDown);
      plot.addEventListener('pointerleave', function () {
        if (!pinned) {
          hoverPoint = null;
          draw();
        }
      });
      plot.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          pinned = false;
          hoverPoint = null;
          draw();
        }
      });
    }
  }

  function currentRange() {
    if (!active || !active.points.length) return { start: 0, end: Date.now() };
    var oldest = active.points[0].at;
    var now = Date.now();
    if (active.period === 'ALL') return { start: oldest, end: now };
    if (active.period === 'CUSTOM') {
      var from = dateTimestamp(active.from || dateKey(oldest), false);
      var to = dateTimestamp(active.to || dateKey(now), true);
      return { start: isFinite(from) ? from : oldest, end: isFinite(to) ? to : now };
    }
    return { start: Math.max(oldest, now - PERIODS[active.period]), end: now };
  }

  function visiblePoints(range) {
    return (active ? active.points : []).filter(function (point) {
      return point.at >= range.start && point.at <= range.end;
    });
  }

  function setText(id, text) {
    var node = byId(id);
    if (node) node.textContent = text;
  }

  function onRangeInput(startChanged) {
    if (!active || !active.points.length) return;
    var start = byId('history-range-start');
    var end = byId('history-range-end');
    var min = active.points[0].at;
    var max = active.points[active.points.length - 1].at;
    var maxValue = 1000;
    var low = Number(start.value);
    var high = Number(end.value);
    if (high - low < 2) {
      if (startChanged) low = Math.max(0, high - 2);
      else high = Math.min(maxValue, low + 2);
      start.value = String(low);
      end.value = String(high);
    }
    active.period = 'CUSTOM';
    active.from = dateKey(min + (max - min) * low / maxValue);
    active.to = dateKey(min + (max - min) * high / maxValue);
    saveStore();
    draw();
  }

  function syncRangeInputs(range) {
    var start = byId('history-range-start');
    var end = byId('history-range-end');
    if (!start || !end || !active || !active.points.length) return;
    var min = active.points[0].at;
    var max = active.points[active.points.length - 1].at;
    var span = Math.max(1, max - min);
    var low = Math.max(0, Math.min(1000, Math.round((range.start - min) / span * 1000)));
    var high = Math.max(0, Math.min(1000, Math.round((range.end - min) / span * 1000)));
    start.value = String(Math.min(low, high - 1));
    end.value = String(Math.max(high, low + 1));
    var fill = byId('history-range-fill');
    if (fill) {
      fill.style.left = (Number(start.value) / 10) + '%';
      fill.style.width = ((Number(end.value) - Number(start.value)) / 10) + '%';
    }
  }

  function renderNavigator() {
    var svg = byId('history-navigator');
    if (!svg || !active) return;
    clear(svg);
    var points = active.points;
    if (!points.length) return;
    var width = 900;
    var height = 72;
    var minT = points[0].at;
    var maxT = Math.max(minT + 1, points[points.length - 1].at);
    var values = points.filter(function (point) { return point.value !== null && isFinite(Number(point.value)); })
      .map(function (point) { return Number(point.value); });
    if (!values.length) return;
    var minV = Math.min.apply(Math, values);
    var maxV = Math.max.apply(Math, values);
    if (minV === maxV) { minV -= 1; maxV += 1; }
    var d = '';
    var segmentOpen = false;
    points.forEach(function (point) {
      if (point.value === null || !isFinite(Number(point.value))) {
        segmentOpen = false;
        return;
      }
      var x = (point.at - minT) / (maxT - minT) * width;
      var y = height - 6 - ((Number(point.value) - minV) / (maxV - minV)) * (height - 12);
      d += (segmentOpen ? ' L ' : 'M ') + x.toFixed(2) + ' ' + y.toFixed(2);
      segmentOpen = true;
    });
    if (d) svg.appendChild(svgElement('path', { d: d, 'class': 'history-navigator-line' }));
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
  }

  function drawPlot(points, range) {
    var svg = byId('history-plot');
    if (!svg) return;
    clear(svg);
    var validPoints = points.filter(function (point) { return point.value !== null && isFinite(Number(point.value)); });
    lastDrawn = validPoints;
    if (!validPoints.length) {
      setText('history-empty', active && active.points.length
        ? 'No saved values with complete price coverage fall within this interval yet.'
        : 'History starts collecting once a portfolio value is available.');
      return;
    }
    setText('history-empty', '');

    var width = 960;
    var height = 260;
    var left = 82;
    var right = 948;
    var top = 14;
    var bottom = 220;
    var vals = validPoints.map(function (point) { return Number(point.value); });
    var min = Math.min.apply(Math, vals);
    var max = Math.max.apply(Math, vals);
    var padding = Math.max((max - min) * 0.12, Math.max(Math.abs(min), Math.abs(max), 1) * 0.004);
    min -= padding;
    max += padding;
    if (max === min) max = min + 1;
    var start = range.start;
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

    var d = '';
    var segmentOpen = false;
    points.forEach(function (point) {
      if (point.value === null || !isFinite(Number(point.value))) {
        segmentOpen = false;
        return;
      }
      d += (segmentOpen ? ' L ' : 'M ') + xAt(point.at).toFixed(2) + ' ' + yAt(Number(point.value)).toFixed(2);
      segmentOpen = true;
    });
    var positive = Number(validPoints[validPoints.length - 1].value) >= Number(validPoints[0].value);
    if (d) svg.appendChild(svgElement('path', { d: d, 'class': 'history-line ' + (positive ? 'is-positive' : 'is-negative') }));

    var labelCount = Math.min(4, validPoints.length);
    for (var i = 0; i < labelCount; i++) {
      var point = validPoints[Math.round(i * (validPoints.length - 1) / Math.max(1, labelCount - 1))];
      var dateLabel = svgElement('text', {
        x: xAt(point.at), y: 248, 'text-anchor': i === 0 ? 'start' : (i === labelCount - 1 ? 'end' : 'middle'),
        'class': 'history-axis-label'
      });
      dateLabel.textContent = displayDate(point.at, true);
      svg.appendChild(dateLabel);
    }

    if (hoverPoint && points.indexOf(hoverPoint) !== -1) {
      var hx = xAt(hoverPoint.at);
      var hy = yAt(Number(hoverPoint.value));
      svg.appendChild(svgElement('line', { x1: hx, x2: hx, y1: top, y2: bottom, 'class': 'history-crosshair' }));
      svg.appendChild(svgElement('circle', { cx: hx, cy: hy, r: 5, 'class': 'history-marker' }));
    }
  }

  function draw() {
    if (!active) return;
    var range = currentRange();
    var points = visiblePoints(range);
    drawPlot(points, range);
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
    var custom = byId('history-custom');
    if (custom) custom.hidden = active.period !== 'CUSTOM';
    var from = byId('history-date-from');
    var to = byId('history-date-to');
    if (from && active.points.length) {
      from.min = dateKey(active.points[0].at);
      from.max = dateKey(Date.now());
      from.value = active.from || from.min;
    }
    if (to && active.points.length) {
      to.min = dateKey(active.points[0].at);
      to.max = dateKey(Date.now());
      to.value = active.to || to.max;
    }

    var validPoints = points.filter(function (point) { return point.value !== null && isFinite(Number(point.value)); });
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
      var tooltip = byId('history-tooltip');
      if (tooltip) {
        tooltip.hidden = !hoverPoint;
        tooltip.textContent = hoverPoint ? (money(hoverPoint.value, active.currency) + ' · ' + displayDate(hoverPoint.at, false)) : '';
      }
    } else {
      setText('history-value', '—');
      setText('history-date', '');
      setText('history-change', '');
      var noTooltip = byId('history-tooltip');
      if (noTooltip) noTooltip.hidden = true;
    }

    var note = byId('history-note');
    var badge = byId('history-local-badge');
    if (badge) badge.textContent = storageMessage ? 'Storage issue' : 'Saved locally';
    if (note) {
      if (storageMessage) note.textContent = storageMessage;
      else if (active.updating) note.textContent = 'Rebuilding saved values using locally cached prices; missing historical prices are fetched only when needed.';
      else if (active.incomplete) note.textContent = 'Some past values could not be rebuilt because historical prices were unavailable or a safe request limit was reached.';
      else note.textContent = 'Snapshots start now and are recorded when PLUTUS updates a portfolio value. Past transactions recalculate saved points where prices are available; no values are invented before the first snapshot.';
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
    var nearest = lastDrawn[0];
    var distance = Math.abs(nearest.at - target);
    lastDrawn.forEach(function (point) {
      var next = Math.abs(point.at - target);
      if (next < distance) { nearest = point; distance = next; }
    });
    return nearest;
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

  function revalue(data, context) {
    var signature = String(context.signature || '');
    if (!signature || data.signature === signature || data.pendingSignature === signature || !data.points.length) return;
    data.pendingSignature = signature;
    data.pendingContext = context;
    data.updating = true;
    data.incomplete = false;
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
        saveStore();
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
        if (index % 10 === 0) saveStore();
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
    var nextPoint = { at: bucket, value: Number(value), prices: cleanPrices };
    if (last && last.at === bucket) data.points[data.points.length - 1] = nextPoint;
    else data.points.push(nextPoint);
    data.points = compactPoints(data.points);
  }

  function update(options) {
    if (!root.document || !options) return;
    if (!storeLoaded) {
      loadStore();
      storeLoaded = true;
    }
    buildUi();
    var panel = byId('networth-history');
    if (!panel) return;
    active = scopeData(options.scope);
    active.currency = String(options.currency || 'EUR').toUpperCase();
    active.updating = !!active.updating;
    active.incomplete = !!active.incomplete;
    record(active, options.value, options.prices);
    if (!active.signature && options.signature) active.signature = String(options.signature);
    else if (options.revalue) revalue(active, { signature: options.signature, revalue: options.revalue });
    saveStore();
    panel.hidden = false;
    draw();
  }

  root.NetWorthHistory = { update: update };
}(typeof window !== 'undefined' ? window : this));
