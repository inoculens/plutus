'use strict';
// Sync: MEGA S4 (S3-compatible SigV4; standard HMAC-SHA256, no custom crypto).

function syncSplitUrl(url) {
  var s = String(url || '');
  var m = s.match(/^https?:\/\/([^\/]+)(\/.*)?$/);
  var host = m ? m[1].toLowerCase() : '';
  var path = (m && m[2]) ? m[2] : '/';
  var q = path.indexOf('?');
  if (q !== -1) path = path.slice(0, q);
  if (!path) path = '/';
  return { host: host, path: path };
}

// S3/SigV4 path encoding: encodeURIComponent leaves !'()* raw, but the
// canonical request requires them percent-encoded (uppercase hex), or AWS
// rejects the signature. Folders and keys share it; bucket names cannot
// contain those characters by S3 naming rules.
function syncS3EncodeSeg(seg) {
  return encodeURIComponent(String(seg)).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function syncS3Url(cfg) {
  var ep = String(cfg.endpoint || '').replace(/\/+$/, '');
  var folder = syncNormalizeFolder(cfg.folder);
  var key = String(cfg.objectKey || '').split('/').map(syncS3EncodeSeg).join('/');
  var full = (folder ? folder.split('/').map(syncS3EncodeSeg).join('/') + '/' : '') + key;
  return ep + '/' + encodeURIComponent(cfg.bucket) + '/' + full;
}

function syncS3CanonicalRequest(method, url, payloadHash, amzDate, qs) {
  var parts = syncSplitUrl(url);
  var signed, heads;
  if (method === 'PUT') {
    signed = 'content-type;host;x-amz-content-sha256;x-amz-date';
    heads = 'content-type:application/json\nhost:' + parts.host +
      '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + amzDate + '\n';
  } else {
    signed = 'host;x-amz-content-sha256;x-amz-date';
    heads = 'host:' + parts.host +
      '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + amzDate + '\n';
  }
  return method + '\n' + parts.path + '\n' + (qs || '') + '\n' + heads + '\n' + signed + '\n' + payloadHash;
}

function syncAmzDate(d) {
  function p(x, n) {
    x = String(x);
    while (x.length < n) x = '0' + x;
    return x;
  }
  return p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1, 2) + p(d.getUTCDate(), 2) + 'T' +
    p(d.getUTCHours(), 2) + p(d.getUTCMinutes(), 2) + p(d.getUTCSeconds(), 2) + 'Z';
}

function syncS3Sign(cfg, method, payloadText) {
  // Cheap configuration checks first (no crypto needed, better messages on
  // exotic browsers, and unit-testable without WebCrypto).
  var secret = syncSecret(cfg);
  if (!cfg.endpoint || syncSplitUrl(cfg.endpoint).host === '') {
    return Promise.reject(new Error('sync failed: enter the S3 endpoint URL.'));
  }
  try {
    syncRequireHttpsUrl(cfg.endpoint, 'S3 endpoint');
  } catch (e) {
    return Promise.reject(e);
  }
  if (!cfg.bucket) return Promise.reject(new Error('sync failed: enter the S3 bucket.'));
  if (!cfg.accessKey) return Promise.reject(new Error('sync failed: enter the S3 access key.'));
  if (!secret) return Promise.reject(new Error('sync failed: enter the S3 secret key.'));
  if (!cfg.region) return Promise.reject(new Error('sync failed: enter the S3 region.'));
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  }
  var url = syncS3Url(cfg);
  var now = new Date();
  var amzDate = syncAmzDate(now);
  var dateStamp = amzDate.slice(0, 8);
  var payloadBytes = syncUtf8Encode(payloadText || '');
  return syncSha256(payloadBytes).then(function (phBytes) {
    var payloadHash = syncHex(phBytes);
    var canon = syncS3CanonicalRequest(method, url, payloadHash, amzDate);
    return syncSha256(syncUtf8Encode(canon)).then(function (chBytes) {
      var sts = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + dateStamp + '/' + cfg.region +
        '/s3/aws4_request\n' + syncHex(chBytes);
      return syncHmac(syncUtf8Encode('AWS4' + secret), syncUtf8Encode(dateStamp)).then(function (kDate) {
        return syncHmac(kDate, syncUtf8Encode(cfg.region));
      }).then(function (kRegion) {
        return syncHmac(kRegion, syncUtf8Encode('s3'));
      }).then(function (kService) {
        return syncHmac(kService, syncUtf8Encode('aws4_request'));
      }).then(function (kSigning) {
        return syncHmac(kSigning, syncUtf8Encode(sts));
      }).then(function (sigBytes) {
        var signedHeaders = (method === 'PUT')
          ? 'content-type;host;x-amz-content-sha256;x-amz-date'
          : 'host;x-amz-content-sha256;x-amz-date';
        var auth = 'AWS4-HMAC-SHA256 Credential=' + cfg.accessKey + '/' + dateStamp + '/' +
          cfg.region + '/s3/aws4_request, SignedHeaders=' + signedHeaders +
          ', Signature=' + syncHex(sigBytes);
        var headers = {
          'x-amz-date': amzDate,
          'x-amz-content-sha256': payloadHash,
          'Authorization': auth
        };
        if (method === 'PUT') headers['Content-Type'] = 'application/json';
        return { url: url, headers: headers };
      });
    });
  });
}

// Query-string sibling of syncS3Sign for ListObjectsV2: same validation
// and key derivation, but the canonical request carries the (already
// sorted + encoded) query string and the URL keeps it. Used only by
// attachment-blob listing; object traffic keeps using syncS3Sign.
function syncS3SignQuery(cfg, method, canonicalQs) {
  var secret = syncSecret(cfg);
  if (!cfg.endpoint || syncSplitUrl(cfg.endpoint).host === '') {
    return Promise.reject(new Error('sync failed: enter the S3 endpoint URL.'));
  }
  try {
    syncRequireHttpsUrl(cfg.endpoint, 'S3 endpoint');
  } catch (e) {
    return Promise.reject(e);
  }
  if (!cfg.bucket) return Promise.reject(new Error('sync failed: enter the S3 bucket.'));
  if (!cfg.accessKey) return Promise.reject(new Error('sync failed: enter the S3 access key.'));
  if (!secret) return Promise.reject(new Error('sync failed: enter the S3 secret key.'));
  if (!cfg.region) return Promise.reject(new Error('sync failed: enter the S3 region.'));
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  }
  var ep = String(cfg.endpoint || '').replace(/\/+$/, '');
  var path = '/' + encodeURIComponent(cfg.bucket) + '/';
  var url = ep + path + '?' + canonicalQs;
  var now = new Date();
  var amzDate = syncAmzDate(now);
  var dateStamp = amzDate.slice(0, 8);
  return syncSha256(syncUtf8Encode('')).then(function (phBytes) {
    var payloadHash = syncHex(phBytes);
    var canon = syncS3CanonicalRequest(method, url, payloadHash, amzDate, canonicalQs);
    return syncSha256(syncUtf8Encode(canon)).then(function (chBytes) {
      var sts = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + dateStamp + '/' + cfg.region +
        '/s3/aws4_request\n' + syncHex(chBytes);
      return syncHmac(syncUtf8Encode('AWS4' + secret), syncUtf8Encode(dateStamp)).then(function (kDate) {
        return syncHmac(kDate, syncUtf8Encode(cfg.region));
      }).then(function (kRegion) {
        return syncHmac(kRegion, syncUtf8Encode('s3'));
      }).then(function (kService) {
        return syncHmac(kService, syncUtf8Encode('aws4_request'));
      }).then(function (kSigning) {
        return syncHmac(kSigning, syncUtf8Encode(sts));
      }).then(function (sigBytes) {
        var auth = 'AWS4-HMAC-SHA256 Credential=' + cfg.accessKey + '/' + dateStamp + '/' +
          cfg.region + '/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date' +
          ', Signature=' + syncHex(sigBytes);
        return {
          url: url,
          headers: { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, 'Authorization': auth }
        };
      });
    });
  });
}

// Reads an S3 XML error body and maps it to a calm, specific message:
// clock skew vs wrong keys vs missing object are very different problems.
function syncS3ErrorBody(body, missingMsg) {
  if (body && body.indexOf('RequestTimeTooSkewed') !== -1) {
    return new Error('sync failed: the device clock looks wrong — S3 refused the time. Fix the date/time and retry.');
  }
  if (body && (body.indexOf('NoSuchBucket') !== -1 || body.indexOf('NoSuchKey') !== -1)) {
    return new Error(missingMsg);
  }
  return null;
}

function syncS3Put(cfg, text) {
  return syncS3Sign(cfg, 'PUT', text).then(function (s) {
    return syncFetch(s.url, { method: 'PUT', headers: s.headers, body: text }, 'the S3 endpoint').then(function (res) {
      if (res.ok) return true;
      if (res.status === 403 || res.status === 404) {
        return syncReadMetaText(res).then(function (body) {
          throw syncS3ErrorBody(body, 'sync failed: S3 bucket not found. Check the endpoint and bucket name.') ||
            new Error('sync failed: S3 keys refused. Check the access key, secret, region and bucket policy.');
        }, function () {
          throw new Error('sync failed: S3 upload refused (HTTP ' + res.status + ').');
        });
      }
      throw new Error('sync failed: S3 upload refused (HTTP ' + res.status + ').');
    });
  });
}

function syncS3Get(cfg) {
  return syncS3Sign(cfg, 'GET', '').then(function (s) {
    return syncFetch(s.url, { method: 'GET', headers: s.headers }, 'the S3 endpoint').then(function (res) {
      if (res.ok) return syncReadTextLimited(res);
      if (res.status === 404 || res.status === 403) {
        return syncReadMetaText(res).then(function (body) {
          throw syncS3ErrorBody(body, 'sync failed: no backup found on the server yet.') ||
            new Error('sync failed: S3 keys refused. Check the access key, secret, region and bucket policy.');
        }, function () {
          throw new Error('sync failed: S3 download refused (HTTP ' + res.status + ').');
        });
      }
      throw new Error('sync failed: S3 download refused (HTTP ' + res.status + ').');
    });
  });
}
