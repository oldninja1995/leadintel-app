/* Print view: opens the print dialog once the page has laid out (for "Save as
   PDF"), and the button does the same again. A file, not an inline script —
   the CSP admits none. */
(function () {
  function go() { window.print(); }
  var btn = document.querySelector('[data-print]');
  if (btn) btn.addEventListener('click', go);
  if (document.body.hasAttribute('data-auto-print')) window.addEventListener('load', function () { setTimeout(go, 300); });
})();
