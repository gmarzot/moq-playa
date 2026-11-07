// Sets the stored or OS theme before first paint; main.ts keeps it in sync.
(function () {
  var t = null;
  try { t = localStorage.getItem('g5-theme'); } catch (e) { /* storage unavailable */ }
  if (t !== 'dark' && t !== 'light') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
})();
