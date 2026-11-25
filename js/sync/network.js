'use strict';
// Sync: network helpers (timeouts, HTTPS guard, size-limited reads).

function syncNetErr(label) {
  return function () {
    throw new Error('sync failed: cannot reach ' + label + '. Check your connection.');
  };
}

// All sync traffic goes through here: a hung connection aborts after
// SYNC_TIMEOUT_MS so the UI can never wedge with its buttons disabled.
// The timer covers the whole exchange: it keeps running after the response
// headers arrive and stops only once the body has been read (a stalled body
// aborts and rejects like a stalled request). A response whose body is never
// read is cut off by the timer, which is harmless.
// Degrades to plain fetch where AbortController/timers are unavailable.
var SYNC_TIMEOUT_MS = 30000;

function syncFetch(url, opts, label) {
  var o = opts || {};
  try {
    if (typeof AbortController !== 'undefined' && typeof setTimeout !== 'undefined') {
      var ctrl = new AbortController();
      o.signal = ctrl.signal;
      var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, SYNC_TIMEOUT_MS);
      var stop = function () { try { clearTimeout(timer); } catch (e) { /* ignore */ } };
      var timedOut = function () {
        return new Error('sync failed: timed out reaching ' + label + '. Check your connection.');
      };
      return fetch(url, o).then(function (res) {
        if (!res) { stop(); return res; }
        if (res.body === null) { stop(); return res; } // HEAD / 204: nothing left to wait for
        ['json', 'text', 'arrayBuffer', 'blob', 'formData'].forEach(function (name) {
          var orig = res[name];
          if (typeof orig !== 'function') return;
          try {
            res[name] = function () {
              var p;
              try { p = orig.apply(res, arguments); } catch (e) { stop(); throw e; }
              return Promise.resolve(p).then(function (v) {
                stop();
                return v;
              }, function (err) {
                stop();
                if (err && err.name === 'AbortError') throw timedOut();
                throw err;
              });
            };
          } catch (e) { /* read-only response object: timer still bounds it */ }
        });
        try { res.syncStop = stop; res.syncTimedOut = timedOut; } catch (e) { /* read-only response */ }
        return res;
      }, function (err) {
        stop();
        if (err && err.name === 'AbortError') throw timedOut();
        throw new Error('sync failed: cannot reach ' + label + '. Check your connection.');
      });
    }
  } catch (e) { /* fall through to plain fetch */ }
  return fetch(url, o).then(null, syncNetErr(label));
}

// User-configured hosts must use https (loopback excepted) so logins and
// tokens never travel in cleartext where anyone on the network can read them.
function syncRequireHttpsUrl(url, label) {
  var s = String(url || '');
  var m = s.match(/^(https?):\/\/([^\/?#]+)/i);
  if (!m) throw new Error('sync failed: enter the ' + label + ' URL starting with https://.');
  var hostport = m[2].toLowerCase();
  // Credentials belong in the password fields, never in the URL: browsers
  // refuse fetch() URLs that carry them, and "127.0.0.1@evil.com" must not be
  // read as a loopback host.
  if (hostport.indexOf('@') !== -1) {
    throw new Error('sync failed: the ' + label + ' URL must not contain a username or password — enter them in the sign-in fields instead.');
  }
  var host = hostport;
  if (host.charAt(0) === '[') {
    host = host.slice(1, host.indexOf(']'));
  } else {
    host = host.split(':')[0];
  }
  // Exact loopback names only: a prefix test would accept hosts such as
  // "127.evil.com" and send the login over cleartext http.
  var local = (host === 'localhost' || host === '::1' ||
    /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host));
  if (m[1].toLowerCase() !== 'https' && !local) {
    throw new Error('sync failed: the ' + label + ' URL must use https:// (not http) so your login stays private.');
  }
  return s;
}

function syncPostForm(url, body) {
  return syncFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body
  }, 'the sign-in server').then(function (res) {
    return syncReadMetaJson(res).then(function (data) {
      if (!res.ok) {
        var msg = (data && (data.error_description || data.error)) || ('HTTP ' + res.status);
        throw new Error('sync failed: sign-in refused (' + String(msg).slice(0, 160) + ').');
      }
      return data || {};
    }, function () {
      if (!res.ok) throw new Error('sync failed: sign-in refused (HTTP ' + res.status + ').');
      throw new Error('sync failed: bad sign-in response.');
    });
  });
}
