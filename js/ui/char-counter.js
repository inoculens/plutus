'use strict';
// Character counter for capped text fields, in the style of a post composer:
// a ring fills as the text grows; near the cap it enlarges and shows how many
// characters are left, amber first, red once the cap is reached.

var CHAR_COUNTER_WARN = 20;

// Wires a counter to `input` (an input or textarea with a hard cap of `max`)
// and returns { el, update }. The caller places `el`; it keeps a fixed box,
// so the layout never shifts while typing.
function attachCharCounter(input, max) {
  var cap = Math.max(1, Number(max) || 1);
  var box = document.createElement('span');
  box.className = 'char-counter';
  box.setAttribute('data-char-counter', '1');
  var bar = null;
  if (typeof document.createElementNS === 'function') {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'char-counter-ring');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var track = document.createElementNS(NS, 'circle');
    track.setAttribute('class', 'char-counter-track');
    track.setAttribute('cx', '10');
    track.setAttribute('cy', '10');
    track.setAttribute('r', '8.5');
    bar = document.createElementNS(NS, 'circle');
    bar.setAttribute('class', 'char-counter-bar');
    bar.setAttribute('cx', '10');
    bar.setAttribute('cy', '10');
    bar.setAttribute('r', '8.5');
    bar.setAttribute('pathLength', '100');
    bar.setAttribute('stroke-dasharray', '100');
    bar.setAttribute('transform', 'rotate(-90 10 10)');
    svg.appendChild(track);
    svg.appendChild(bar);
    box.appendChild(svg);
  }
  var num = document.createElement('span');
  num.className = 'char-counter-num';
  num.setAttribute('aria-hidden', 'true');
  box.appendChild(num);
  // Screen readers hear the count only once it matters (near the cap).
  var live = document.createElement('span');
  live.className = 'char-counter-sr';
  live.setAttribute('aria-live', 'polite');
  box.appendChild(live);

  function update() {
    var len = String(input.value == null ? '' : input.value).length;
    var left = cap - len;
    var state = left <= 0 ? 'full' : (left <= CHAR_COUNTER_WARN ? 'warn' : 'ok');
    box.setAttribute('data-state', state);
    box.title = Math.max(0, left) + ' of ' + cap + ' characters left';
    if (bar) bar.setAttribute('stroke-dashoffset', String(100 - Math.min(100, (len / cap) * 100)));
    num.textContent = state === 'ok' ? '' : String(Math.max(0, left));
    live.textContent = state === 'ok' ? '' : Math.max(0, left) + ' characters left';
  }
  input.addEventListener('input', update);
  update();
  return { el: box, update: update };
}
