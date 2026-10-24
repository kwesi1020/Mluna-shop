/*
 * lib/render-safety.js — Phase 1B rendering helpers (XSS remediation).
 * STATUS: UNEXECUTED — NOT APPROVED FOR RELEASE. Never run or tested at the time of writing.
 * Works in the browser (window.RenderSafety) and in Node (module.exports).
 */
(function(root, factory){
  if(typeof module === 'object' && module.exports){ module.exports = factory(); }
  else { root.RenderSafety = factory(); }
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';
  const MAP = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
  function esc(v){ if(v === null || v === undefined) return ''; return String(v).replace(/[&<>"']/g, function(c){ return MAP[c]; }); }
  function num(v){ return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function money(v){ const n = num(v); if(n === null || n < 0 || n > 1e12) return 'Invalid amount'; return 'GHC ' + n.toFixed(2); }
  function rating(v){ return (Number.isInteger(v) && v >= 1 && v <= 5) ? v : null; }
  function safeUrl(u){
    if(typeof u !== 'string') return '';
    const s = u.trim();
    if(s.length === 0 || s.length > 2048) return '';
    if(/[\u0000-\u0020\u007f"'`<>()\\]/.test(s)) return '';
    if(/^https:\/\/[^\/?#]+/i.test(s)) return s;
    if(/^assets\/[A-Za-z0-9._\/-]+$/.test(s) && !/(^|\/)\.\.(\/|$)/.test(s)) return s;
    return '';
  }
  return { esc: esc, num: num, money: money, rating: rating, safeUrl: safeUrl };
});
