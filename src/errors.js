// On-screen error log. Phones have no console, so everything lands here too.
const box = () => document.getElementById('errors');

export function showError(message) {
  console.error(message);
  const el = box();
  if (!el) return;
  el.hidden = false;
  el.textContent += (el.textContent ? '\n\n' : '') + message;
}

window.addEventListener('error', (e) => showError(`JS error: ${e.message}\n  at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => showError(`Unhandled: ${e.reason?.stack || e.reason}`));
