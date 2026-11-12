// Last-resort recovery: the app's normal loader exit depends on init()
// and a CSS transitionend event. Never leave the whole page covered if
// either fails; the normal animation gets several seconds to finish.
window.addEventListener('load', function () {
  var loader = document.getElementById('app-loader');
  if (!loader || loader.hidden) return;
  var delay = loader.classList.contains('is-running') ? 5000 : 500;
  window.setTimeout(function () {
    if (loader.hidden) return;
    loader.hidden = true;
    loader.setAttribute('aria-busy', 'false');
    if (window.startupScrollRestorationChanged &&
        window.startupScrollRestoration !== null &&
        'scrollRestoration' in window.history) {
      window.history.scrollRestoration = window.startupScrollRestoration;
    }
    document.documentElement.classList.remove('is-app-loading');
    document.body.classList.remove('is-app-loading');
    window.scrollTo(0, 0);
  }, delay);
}, { once: true });
