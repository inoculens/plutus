'use strict';
// Sync: OAuth (PKCE, user's own app credentials; tokens stay in this browser).

function syncRedirectUri() {
  try {
    if (typeof window === 'undefined' || !window.location) return '';
    var loc = window.location;
    if (!loc.protocol || loc.protocol.indexOf('http') !== 0 || !loc.host) return '';
    // Always the site root: the registered redirect URI must be stable and must
    // not follow the current route (e.g. /account/<id>).
    return loc.protocol + '//' + loc.host + '/';
  } catch (e) {
    return '';
  }
}

function syncPkcePair() {
  var verifier = syncB64UrlEncode(syncRandomBytes(64));
  return syncSha256(syncUtf8Encode(verifier)).then(function (h) {
    return { verifier: verifier, challenge: syncB64UrlEncode(h) };
  });
}

function syncOAuthAuthUrl(providerId, clientId, redirectUri, challenge, state) {
  var scope;
  if (providerId === 'gdrive') {
    scope = 'https://www.googleapis.com/auth/drive.file';
    return 'https://accounts.google.com/o/oauth2/v2/auth' +
      '?client_id=' + encodeURIComponent(clientId) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&response_type=code' +
      '&scope=' + encodeURIComponent(scope) +
      '&code_challenge=' + encodeURIComponent(challenge) +
      '&code_challenge_method=S256' +
      '&access_type=offline&prompt=consent&include_granted_scopes=true' +
      '&state=' + encodeURIComponent(state);
  }
  if (providerId === 'dropbox') {
    return 'https://www.dropbox.com/oauth2/authorize' +
      '?client_id=' + encodeURIComponent(clientId) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&response_type=code' +
      '&code_challenge=' + encodeURIComponent(challenge) +
      '&code_challenge_method=S256' +
      '&token_access_type=offline' +
      '&state=' + encodeURIComponent(state);
  }
  return '';
}

function syncOAuthTokenExchange(providerId, cfg, code, verifier) {
  var redirect = syncRedirectUri();
  var cid = syncEffectiveClientId(cfg);
  var body;
  var url;
  if (providerId === 'gdrive') {
    url = 'https://oauth2.googleapis.com/token';
    body = 'grant_type=authorization_code' +
      '&code=' + encodeURIComponent(code) +
      '&redirect_uri=' + encodeURIComponent(redirect) +
      '&client_id=' + encodeURIComponent(cid) +
      '&client_secret=' + encodeURIComponent(cfg.clientSecret || '') +
      '&code_verifier=' + encodeURIComponent(verifier);
  } else if (providerId === 'dropbox') {
    url = 'https://api.dropboxapi.com/oauth2/token';
    body = 'grant_type=authorization_code' +
      '&code=' + encodeURIComponent(code) +
      '&redirect_uri=' + encodeURIComponent(redirect) +
      '&client_id=' + encodeURIComponent(cid) +
      '&code_verifier=' + encodeURIComponent(verifier);
  } else {
    return Promise.reject(new Error('sync failed: unknown provider.'));
  }
  return syncPostForm(url, body).then(function (tok) {
    return syncNormalizeTokens(tok);
  });
}

function syncOAuthRefresh(providerId, cfg) {
  var t = cfg.tokens || {};
  if (!t.refresh) return Promise.reject(new Error('sync failed: connect your drive first.'));
  var cid = syncEffectiveClientId(cfg);
  var body;
  var url;
  if (providerId === 'gdrive') {
    url = 'https://oauth2.googleapis.com/token';
    body = 'grant_type=refresh_token' +
      '&refresh_token=' + encodeURIComponent(t.refresh) +
      '&client_id=' + encodeURIComponent(cid) +
      '&client_secret=' + encodeURIComponent(cfg.clientSecret || '');
  } else if (providerId === 'dropbox') {
    url = 'https://api.dropboxapi.com/oauth2/token';
    body = 'grant_type=refresh_token' +
      '&refresh_token=' + encodeURIComponent(t.refresh) +
      '&client_id=' + encodeURIComponent(cid);
  } else {
    return Promise.reject(new Error('sync failed: unknown provider.'));
  }
  return syncPostForm(url, body).then(function (tok) {
    var n = syncNormalizeTokens(tok);
    if (!n.refresh) n.refresh = t.refresh;
    return n;
  });
}

function syncNormalizeTokens(tok) {
  var out = { access: '', refresh: '', expiry: 0 };
  if (tok && typeof tok.access_token === 'string') out.access = tok.access_token;
  if (tok && typeof tok.refresh_token === 'string') out.refresh = tok.refresh_token;
  var exp = tok ? Number(tok.expires_in) : 0;
  out.expiry = (isFinite(exp) && exp > 0) ? (Date.now() + exp * 1000) : 0;
  if (!out.access) throw new Error('sync failed: sign-in gave no access token.');
  return out;
}

function syncEnsureAccessToken(cfg) {
  var t = cfg.tokens;
  if (!t || !t.access) return Promise.reject(new Error('sync failed: connect your drive first.'));
  if (t.expiry && (t.expiry - Date.now()) > 60000) return Promise.resolve(t.access);
  if (!t.refresh) {
    if (t.expiry && t.expiry <= Date.now()) {
      return Promise.reject(new Error('sync failed: session expired — connect again.'));
    }
    return Promise.resolve(t.access);
  }
  return syncOAuthRefresh(cfg.provider, cfg).then(function (n) {
    cfg.tokens = n;
    if (cfg.priceDataAuth) priceDataSaveConfig(cfg);
    else if (cfg.priceDataFile) {
      // Price Data shares the Records sign-in: persist ONLY the refreshed
      // tokens into the Records config. Saving this whole clone would
      // overwrite the Records file name with the price-data name (+ .enc.json).
      var own = syncLoadConfig();
      own.tokens = n;
      syncSaveConfig(own);
    } else syncSaveConfig(cfg);
    return n.access;
  });
}

function syncParseQuery(q) {
  var out = {};
  var pairs = String(q || '').split('&');
  var i, kv, k, v;
  for (i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    kv = pairs[i].split('=');
    k = kv[0];
    v = kv.slice(1).join('=');
    try { k = decodeURIComponent(k); } catch (e) { /* keep raw */ }
    try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ }
    out[k] = v;
  }
  return out;
}

// Runs in the OAuth popup after the provider redirects back to this page:
// hands the code to the opener window and closes itself.
function syncHandleOAuthRedirect() {
  try {
    if (typeof window === 'undefined' || !window.location || !window.opener) return;
    var search = String(window.location.search || '');
    if (search.indexOf('code=') === -1 && search.indexOf('error=') === -1) return;
    var q = syncParseQuery(search.replace(/^\?/, ''));
    if (!q.state || q.state.indexOf('plutus-') !== 0) return;
    if (!q.code && !q.error) return;
    try {
      window.opener.postMessage({ type: 'plutus-oauth', code: q.code || null, error: q.error || null, state: q.state }, window.location.origin);
    } catch (e) { /* ignore */ }
    try {
      if (document && document.body) {
        document.body.innerHTML = '<p style="font-family:sans-serif;padding:2rem">Signed in — you can close this window.</p>';
      }
    } catch (e2) { /* ignore */ }
    try { window.close(); } catch (e3) { /* ignore */ }
  } catch (e) { /* ignore */ }
}
