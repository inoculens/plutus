// Startup loader. Loaded synchronously at the end of <body>, so it runs as
// soon as the page is parsed, before the deferred app scripts compile.
//
// - The intro starts at once. It animates only transform and opacity, which
//   browsers run off the main thread, so a busy boot cannot make it stutter,
//   skip a coin or leave one blurred.
// - The app calls finishStartupLoader() when its first paint is ready. The
//   loader closes only after BOTH the app is ready and the intro has really
//   finished (no fixed timer racing the animation).
// - Last resort: if the app never reports ready, the page is uncovered
//   shortly after the load event; it is never left covered.
(function () {
  'use strict';
  var INTRO_MS = 2300;        // longest intro animation (progress bar / logo)
  var HOLD_MS = 150;          // logo stays fully shown this long before the fade
  var EXIT_FALLBACK_MS = 700; // fade is 450ms; hide even if transitionend is lost
  var RECOVERY_MS = 500;      // app never reported ready by the load event

  var loader = document.getElementById('app-loader');
  if (!loader) {
    window.finishStartupLoader = function () {};
    return;
  }
  var reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var startedAt = Date.now();
  var finishing = false;

  // Keep the page pinned to the top while it is covered.
  var savedScrollRestoration = null;
  var scrollRestorationChanged = false;
  if (window.history && 'scrollRestoration' in window.history) {
    savedScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    scrollRestorationChanged = true;
  }

  if (!reducedMotion) loader.classList.add('is-running');

  function uncoverPage() {
    if (scrollRestorationChanged) {
      window.history.scrollRestoration = savedScrollRestoration;
      scrollRestorationChanged = false;
    }
    window.scrollTo(0, 0);
    document.documentElement.classList.remove('is-app-loading');
    document.body.classList.remove('is-app-loading');
  }

  function hide() {
    if (loader.hidden) return;
    loader.hidden = true;
    loader.setAttribute('aria-busy', 'false');
    uncoverPage();
  }

  function fadeOut() {
    loader.setAttribute('aria-busy', 'false');
    loader.classList.add('is-exiting');
    var fallback = window.setTimeout(hide, EXIT_FALLBACK_MS);
    loader.addEventListener('transitionend', function onEnd(event) {
      if (event.target !== loader || event.propertyName !== 'opacity') return;
      loader.removeEventListener('transitionend', onEnd);
      window.clearTimeout(fallback);
      hide();
    });
  }

  // Runs `done` once every intro animation has finished. The timer is a cap
  // for hidden tabs, where animations may not advance.
  function afterIntro(done) {
    var called = false;
    function go() {
      if (called) return;
      called = true;
      window.setTimeout(done, HOLD_MS);
    }
    var remaining = Math.max(0, INTRO_MS - (Date.now() - startedAt));
    window.setTimeout(go, remaining + 1000);
    var animations = [];
    try { animations = loader.getAnimations ? loader.getAnimations({ subtree: true }) : []; } catch (e) { animations = []; }
    if (animations.length && typeof Promise === 'function') {
      Promise.all(animations.map(function (a) { return a.finished; })).then(go, go);
    } else {
      window.setTimeout(go, remaining);
    }
  }

  // Reduced motion: no intro. Reveal after the load event, re-pinning the
  // top for a moment while late layout (fonts, images) settles.
  function revealWithoutMotion() {
    function pinThenReveal() {
      if (scrollRestorationChanged) {
        window.history.scrollRestoration = savedScrollRestoration;
        scrollRestorationChanged = false;
      }
      var attempts = 0;
      (function pin() {
        window.scrollTo(0, 0);
        attempts += 1;
        if (attempts < 11) {
          window.setTimeout(pin, 50);
          return;
        }
        hide();
      })();
    }
    if (document.readyState === 'complete') pinThenReveal();
    else window.addEventListener('load', pinThenReveal, { once: true });
  }

  window.finishStartupLoader = function () {
    if (finishing || loader.hidden) return;
    finishing = true;
    loader.setAttribute('data-app-ready', '1');
    window.scrollTo(0, 0);
    if (reducedMotion) revealWithoutMotion();
    else afterIntro(fadeOut);
  };

  window.addEventListener('load', function () {
    if (finishing || loader.hidden) return;
    window.setTimeout(function () {
      if (!finishing) hide();
    }, RECOVERY_MS);
  }, { once: true });
})();
