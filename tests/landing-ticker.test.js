#!/usr/bin/env node
'use strict';

// The home-screen pill (BTC | XAU | SPCX, shown when no account exists) must
// resolve its prices like the portfolio does: each pill on its own, one
// gentle retry, no sticky '—' after a transient failure, and no pill held
// hostage by a slow feed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};

function fakePill() {
  const classes = new Set();
  return {
    textContent: '…',
    title: '',
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: noop,
      contains: c => classes.has(c)
    },
    setAttribute: noop,
    removeAttribute: noop,
    isLoading: () => classes.has('is-loading')
  };
}

function createApp(fetchImpl, main) {
  const store = new Map();
  store.set('inoculens.v2', JSON.stringify({
    settings: { mainCurrency: main || 'USD', costMethod: 'average', assetLedgers: true, dateFormat: 'DD/MM/YYYY' },
    accounts: [], trades: [], priceOverrides: {}
  }));
  const pills = { 'tick-btc': fakePill(), 'tick-xau': fakePill(), 'tick-spcx': fakePill() };
  const el = () => new Proxy(function () {}, {
    get: (target, key) => key === 'style' ? {} : key === 'classList'
      ? { add: noop, remove: noop, toggle: noop, contains: () => false }
      : key === 'querySelectorAll' ? () => [] : key === 'querySelector' ? () => null : noop,
    set: () => true,
    apply: () => el()
  });
  const context = {
    console, setTimeout, clearTimeout, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    },
    document: {
      getElementById: id => pills[id] || null, addEventListener: noop, querySelector: () => null,
      querySelectorAll: () => [], createElement: () => el(), body: el(),
      documentElement: el(), readyState: 'loading'
    },
    navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' },
    addEventListener: noop, fetch: fetchImpl,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    requestAnimationFrame: noop, Event: function () {},
    crypto: { getRandomValues: value => value, subtle: {} },
    history: { pushState: noop, replaceState: noop },
    performance: { now: () => 0 }
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(src, context, { filename: 'app.js' });
  // Keep the in-run retry and the failure cooldown short for the test.
  context.LANDING_TICK_RETRY_MS = 5;
  context.LANDING_TICK_FAIL_MS = 0;
  return { app: context, pills };
}

const json = body => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const down = () => Promise.resolve({ ok: false, status: 503 });
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function until(check, message) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(message);
}

const isPrice = text => /\d/.test(text) && text !== '…' && text !== '—';

function healthyFeed(url) {
  if (url.includes('api.coingecko.com')) return json({ bitcoin: { usd: 90000 } });
  if (url.includes('api.gold-api.com')) return json({ price: 4000 });
  if (url.includes('quote.cnbc.com')) {
    return json({ FormattedQuoteResult: { FormattedQuote: [{ code: 0, symbol: 'SPCX', last: '55.25', currencyCode: 'USD' }] } });
  }
  return down();
}

async function main() {
  // 1. Every source answers: all three pills show a price.
  {
    const { app, pills } = createApp(healthyFeed);
    app.refreshLandingTicker();
    await until(() => Object.values(pills).every(p => isPrice(p.textContent)),
      'all three pills fill in when every feed answers');
    assert.match(pills['tick-btc'].textContent, /90,000/);
    assert.match(pills['tick-xau'].textContent, /4,000/);
    assert.match(pills['tick-spcx'].textContent, /55\.25/);
    Object.values(pills).forEach(p => assert.equal(p.isLoading(), false, 'loading state cleared'));
  }

  // 2. A transient failure heals on the in-run retry (no sticky '—').
  {
    let cnbcCalls = 0;
    const { app, pills } = createApp(url => {
      if (url.includes('quote.cnbc.com')) {
        cnbcCalls++;
        if (cnbcCalls === 1) return down();
      }
      return healthyFeed(url);
    });
    app.refreshLandingTicker();
    await until(() => isPrice(pills['tick-spcx'].textContent), 'SPCX heals on the retry');
    assert.ok(cnbcCalls >= 2, 'the failed stock lookup was retried');
    assert.ok(isPrice(pills['tick-btc'].textContent) && isPrice(pills['tick-xau'].textContent));
  }

  // 3. A pill that ends unknown shows '—' and is re-attempted on the next
  //    paint instead of waiting out a one-minute throttle.
  {
    let stockUp = false;
    const { app, pills } = createApp(url => {
      if (url.includes('quote.cnbc.com') && !stockUp) return down();
      return healthyFeed(url);
    });
    app.refreshLandingTicker();
    await until(() => pills['tick-spcx'].textContent === '—', "a dead feed settles on '—'");
    assert.equal(pills['tick-spcx'].isLoading(), false);
    assert.ok(isPrice(pills['tick-btc'].textContent), 'other pills are unaffected by one dead feed');
    stockUp = true;
    app.refreshLandingTicker(); // any later paint of the home screen
    await until(() => isPrice(pills['tick-spcx'].textContent), 'the next paint re-attempts the unknown pill');
  }

  // 4. A feed that never answers does not hold the other pills back.
  {
    const { app, pills } = createApp(url => {
      if (url.includes('quote.cnbc.com')) return new Promise(noop);
      return healthyFeed(url);
    });
    app.refreshLandingTicker();
    await until(() => isPrice(pills['tick-btc'].textContent) && isPrice(pills['tick-xau'].textContent),
      'BTC and XAU paint while SPCX is still pending');
    assert.equal(pills['tick-spcx'].textContent, '…');
    assert.equal(pills['tick-spcx'].isLoading(), true);
  }

  // 5. Unknown is never coerced to a price.
  {
    const { app, pills } = createApp(() => down());
    app.refreshLandingTicker();
    await until(() => Object.values(pills).every(p => p.textContent === '—'), "all-dead feeds read '—', never 0");
  }

  // 6. A pill that already shows a price keeps it when a later refresh fails.
  {
    let feedUp = true;
    const { app, pills } = createApp(url => feedUp ? healthyFeed(url) : down());
    app.refreshLandingTicker();
    await until(() => isPrice(pills['tick-btc'].textContent), 'first paint');
    const shown = pills['tick-btc'].textContent;
    feedUp = false;
    app.priceCache = {}; // drop the 60s price cache so the refetch really hits the dead feed
    app.LANDING_TICK_FRESH_MS = 0;
    app.refreshLandingTicker();
    await sleep(150);
    assert.equal(pills['tick-btc'].textContent, shown, 'last good price stays on a failed refresh');
  }

  console.log('landing ticker checks passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
