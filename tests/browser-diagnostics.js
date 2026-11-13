'use strict';
// Classifies browser diagnostics for the e2e test without ever muting CSP
// output by message text. CSP violations come from the stable
// `securitypolicyviolation` event properties (effectiveDirective, blockedURI,
// sourceFile), not from console wording.
//
// The e2e test deliberately attacks its own page twice: one injected inline
// <script> and one eval() from the served probe script. Each probe is expected
// to be blocked EXACTLY ONCE. Every other violation, a repeat of a probe, a
// page exception, a failed same-origin request or a missing asset is unexpected
// and fails the test.
const PROBE_PATH = '/__csp_probe.js';
const PROBE_EVAL_MARKER = 'plutus_csp_probe_eval_7c1e';
const PROBE_INLINE_MARKER = 'plutus_csp_probe_inline_4b9d';

const isScriptDirective = d => /^script-src(-elem|-attr)?$/.test(d || '');

function classifyViolation(v) {
  const dir = v.effectiveDirective || v.violatedDirective || '';
  const blocked = String(v.blockedURI || '');
  const src = String(v.sourceFile || '');
  if (isScriptDirective(dir) && blocked === 'inline' && !src.endsWith(PROBE_PATH)) return 'inline-probe';
  if (dir === 'script-src' && blocked === 'eval' && src.endsWith(PROBE_PATH)) return 'eval-probe';
  return 'unexpected';
}

class Diagnostics {
  constructor() {
    this.expected = { 'inline-probe': 0, 'eval-probe': 0 };
    this.unexpectedCsp = []; this.exceptions = []; this.requestFailures = []; this.badResponses = []; this.loaded = {};
  }
  csp(v) {
    const c = classifyViolation(v);
    if (c === 'unexpected') this.unexpectedCsp.push((v.effectiveDirective || '?') + ' blocked ' + (v.blockedURI || '?') + ' from ' + (v.sourceFile || '?'));
    else this.expected[c]++;
  }
  exception(msg) { this.exceptions.push(msg); }
  // Only same-origin traffic counts: every external host is intentionally aborted by the test.
  // The one tolerated case: Chromium cancels an in-flight <img> load (net::ERR_ABORTED) when the
  // app re-renders and replaces that element mid-load. Scripts, styles, fonts and fetches that
  // abort still fail, and an image that is really missing still fails through its 404 response.
  requestFailed(url, origin, why, resourceType) {
    if (!url.startsWith(origin)) return;
    if (resourceType === 'image' && /ERR_ABORTED/.test(why || '')) return;
    this.requestFailures.push(url + ' ' + why);
  }
  response(url, origin, status) {
    if (!url.startsWith(origin)) return;
    this.loaded[url.slice(origin.length).split('?')[0]] = status;
    if (status >= 400) this.badResponses.push(status + ' ' + url);
  }
  // Problems that fail the test regardless of what the probes did.
  problems(requiredAssets) {
    const out = [];
    this.unexpectedCsp.forEach(m => out.push('unexpected CSP violation: ' + m));
    this.exceptions.forEach(m => out.push('page exception: ' + m));
    this.requestFailures.forEach(m => out.push('failed request: ' + m));
    this.badResponses.forEach(m => out.push('bad response: ' + m));
    (requiredAssets || []).forEach(a => { if (this.loaded[a] !== 200) out.push('required asset not loaded (200): ' + a + ' -> ' + this.loaded[a]); });
    return out;
  }
  // Probe evidence: each blocked exactly once.
  probeProblems() {
    const out = [];
    if (this.expected['inline-probe'] !== 1) out.push('expected exactly 1 inline-script CSP block, saw ' + this.expected['inline-probe']);
    if (this.expected['eval-probe'] !== 1) out.push('expected exactly 1 eval CSP block, saw ' + this.expected['eval-probe']);
    return out;
  }
}

module.exports = { Diagnostics, classifyViolation, PROBE_PATH, PROBE_EVAL_MARKER, PROBE_INLINE_MARKER };
