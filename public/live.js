let stop;
export function stopUpdates() { stop?.(); stop = undefined; }
// Short polling works across Vercel instances and sleeping mobile browsers.
export function watchUpdates(load, initial, changed, milliseconds = 5000) {
  stopUpdates();
  let cancelled = false, timer, signature = JSON.stringify(initial);
  const tick = async () => {
    if (cancelled) return;
    try {
      // Preserve typed references and account forms while they are being edited.
      if (!document.hidden && !document.querySelector('dialog[open],button[data-action]:disabled,button[data-shop]:disabled,#nav-toggle[aria-expanded="true"]') && !document.activeElement?.matches('input,select,textarea')) {
        const next = await load(), value = JSON.stringify(next);
        if (!cancelled && value !== signature) { signature = value; await changed(next); }
      }
    } catch { /* Keep the last known state; explicit Refresh still reports errors. */ }
    if (!cancelled) timer = setTimeout(tick, milliseconds);
  };
  timer = setTimeout(tick, milliseconds);
  stop = () => { cancelled = true; clearTimeout(timer); };
}
