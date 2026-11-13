'use strict';
// Shared Playwright/Chromium loader for the browser tests.
//
// CI-required mode (CI is set, or REQUIRE_BROWSER_TESTS=1): a missing
// Playwright package, a missing Chromium binary or any launch/setup error is a
// FAILURE (exit 1). Nothing is ever skipped there.
// Local optional mode: the same conditions print an unmistakable
// "SKIP: ... NOT RUN" line and exit 0, so a contributor without a browser is
// not blocked, but a skipped run can never be mistaken for a pass.
//
// Test hooks (used by browser-env.test.js to prove the failure modes):
//   PLUTUS_PLAYWRIGHT_MODULE      module to require instead of "playwright"
//   PLUTUS_CHROMIUM_EXECUTABLE    chromium executablePath override
const required = () => {
  const ci = String(process.env.CI || '').toLowerCase();
  return (ci !== '' && ci !== '0' && ci !== 'false') || process.env.REQUIRE_BROWSER_TESTS === '1';
};

function unavailable(name, why, err) {
  const detail = err ? ' (' + String((err && err.message) || err).split('\n')[0] + ')' : '';
  if (required()) {
    console.error(name + ': FAIL: ' + why + detail + '. Browser tests are mandatory in CI-required mode.');
    process.exit(1);
  }
  console.log('SKIP: ' + name + ' NOT RUN: ' + why + detail + '. Install Playwright and Chromium to run it; CI never skips.');
  process.exit(0);
}

function loadChromium(name) {
  try {
    return require(process.env.PLUTUS_PLAYWRIGHT_MODULE || 'playwright').chromium;
  } catch (e) {
    return unavailable(name, 'playwright is not installed', e);
  }
}

async function launchChromium(chromium, name) {
  try {
    const opts = process.env.PLUTUS_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLUTUS_CHROMIUM_EXECUTABLE } : {};
    const browser = await chromium.launch(opts);
    console.log(name + ': Chromium ' + browser.version() + ' launched');
    return browser;
  } catch (e) {
    return unavailable(name, 'Chromium could not be launched', e);
  }
}

module.exports = { loadChromium, launchChromium, required };
