'use strict';
// Floating dock (phones/tablets): when the page is scrolled to the end the
// footer rises into view, and the fixed pill used to sit on top of it. Lift
// the pill by exactly the footer's visible height so it rests right above the
// footer instead. The desktop rail (>= 1024px) is top-anchored and never lifts.
function dockFooterInit() {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    var dock = document.getElementById('dock');
    var foot = document.querySelector('footer');
    if (!dock || !foot || dock.getAttribute('data-lift-wired')) return;
    dock.setAttribute('data-lift-wired', '1');
    var root = document.documentElement;
    var queued = false;
    var update = function () {
      queued = false;
      var lift = 0;
      if (window.innerWidth < 1024) {
        var visible = window.innerHeight - foot.getBoundingClientRect().top;
        if (visible > 0) lift = Math.round(visible);
      }
      root.style.setProperty('--dock-lift', lift + 'px');
    };
    var schedule = function () {
      if (queued) return;
      queued = true;
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(update);
      else update();
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(schedule);
      ro.observe(document.body);
      ro.observe(foot);
    }
    update();
  } catch (e) { /* dock placement never breaks boot */ }
}
