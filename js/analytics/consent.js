'use strict';
// Consent / analytics (GDPR Basic mode).
//
// Google Analytics 4 (G-0JEDV505S7) loads ONLY after the visitor presses
// Accept in #cookie-banner. Default is denied (see head inline consent).
// Choice persists in localStorage under CONSENT_KEY, separate from the
// portfolio store. Decline (or no choice) = gtag.js is never requested.
var GA_MEASUREMENT_ID = 'G-0JEDV505S7';
var CONSENT_KEY = 'inoculens.consent.v1';

function consentRead() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    var raw = window.localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    var v = JSON.parse(raw);
    if (v && (v.choice === 'accepted' || v.choice === 'declined')) return v.choice;
    return null;
  } catch (e) { return null; }
}

function consentWrite(choice) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ choice: choice, at: new Date().toISOString() }));
    }
  } catch (e) { /* private mode: choice lasts this session only */ }
  return choice;
}

function consentGtagStub() {
  try {
    if (typeof window === 'undefined') return;
    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag !== 'function') {
      window.gtag = function () { window.dataLayer.push(arguments); };
    }
  } catch (e) { /* ignore */ }
}

function consentLoadGA() {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (window.__gaLoaded) return true;
    consentGtagStub();
    window.gtag('js', new Date());
    window.gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
    s.setAttribute('data-ga', 'consent');
    var head = document.head || document.getElementsByTagName('head')[0];
    if (head) head.appendChild(s);
    window.__gaLoaded = true;
    return true;
  } catch (e) { return false; }
}

// Google Analytics cookies set on this site (and, for the "auto" cookie
// domain, on its parent domain). Expiring them is what makes a later Decline
// actually stop the identifier, not just stop new events.
function consentExpireGaCookies() {
  try {
    if (typeof document === 'undefined') return;
    var names = [];
    String(document.cookie || '').split(';').forEach(function (c) {
      var n = c.split('=')[0].replace(/^\s+|\s+$/g, '');
      if (n === '_ga' || n.indexOf('_ga_') === 0 || n === '_gid' || n.indexOf('_gat') === 0) names.push(n);
    });
    var host = String((typeof location !== 'undefined' && location.hostname) || '');
    var parts = host.split('.');
    var domains = [''];
    if (host) domains.push(host);
    for (var i = 1; i < parts.length - 1; i++) domains.push('.' + parts.slice(i).join('.'));
    names.forEach(function (n) {
      domains.forEach(function (d) {
        document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + (d ? '; domain=' + d : '');
      });
    });
  } catch (e) { /* ignore */ }
}

function consentApply(choice) {
  consentWrite(choice);
  try {
    consentGtagStub();
    window.gtag('consent', 'update', {
      analytics_storage: choice === 'accepted' ? 'granted' : 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });
  } catch (e) { /* ignore */ }
  try { window['ga-disable-' + GA_MEASUREMENT_ID] = (choice !== 'accepted'); } catch (e) { /* ignore */ }
  if (choice === 'accepted') consentLoadGA();
  else consentExpireGaCookies();
  try {
    var b = typeof document !== 'undefined' ? document.getElementById('cookie-banner') : null;
    if (b) b.hidden = true;
  } catch (e) { /* ignore */ }
  return choice;
}

function consentWireBanner() {
  var acc = document.getElementById('cookie-accept');
  var dec = document.getElementById('cookie-decline');
  if (acc && !acc.getAttribute('data-wired')) {
    acc.setAttribute('data-wired', '1');
    acc.addEventListener('click', function () { consentApply('accepted'); });
  }
  if (dec && !dec.getAttribute('data-wired')) {
    dec.setAttribute('data-wired', '1');
    dec.addEventListener('click', function () { consentApply('declined'); });
  }
}

// Footer "Cookie settings": withdrawing consent must be as easy as giving it.
function consentReopen() {
  try {
    var banner = document.getElementById('cookie-banner');
    if (!banner) return;
    consentWireBanner();
    banner.hidden = false;
  } catch (e) { /* ignore */ }
}

function consentInitBanner() {
  try {
    if (typeof document === 'undefined') return;
    var banner = document.getElementById('cookie-banner');
    if (!banner) return;
    var settings = document.getElementById('cookie-settings');
    if (settings && !settings.getAttribute('data-wired')) {
      settings.setAttribute('data-wired', '1');
      settings.addEventListener('click', consentReopen);
    }
    var choice = consentRead();
    if (choice === 'accepted') { banner.hidden = true; consentLoadGA(); return; }
    if (choice === 'declined') { banner.hidden = true; return; }
    banner.hidden = false;
    consentWireBanner();
  } catch (e) { /* banner never breaks boot */ }
}
