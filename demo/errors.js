// On-screen error log for the demo page. Phones have no console, so everything lands here too.
const box = () => document.getElementById('errors');

export function showOnScreen(message) {
  console.error(message);
  const el = box();
  if (!el) return;
  el.hidden = false;
  el.textContent += (el.textContent ? '\n\n' : '') + message;
}

window.addEventListener('error', (e) => showOnScreen(`JS error: ${e.message}\n  at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => showOnScreen(`Unhandled: ${e.reason?.stack || e.reason}`));
