// Applies a stored Light/Dark choice before the page is drawn, so it never flashes the other theme.
// A classic script in <head>: the CSP allows no inline script, and the module app.js runs too late.
// app.js owns the switch; this only replays the stored choice ('system' or nothing = follow the device).
(function () {
  var choice = null;
  try { choice = localStorage.getItem('deus-control.theme'); } catch (e) { /* no storage: follow the device */ }
  if (choice !== 'light' && choice !== 'dark') return;
  document.documentElement.dataset.theme = choice;
  var bg = choice === 'light' ? '#faf9f5' : '#1f1e1d';
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) { metas[i].setAttribute('content', bg); metas[i].removeAttribute('media'); }
})();
