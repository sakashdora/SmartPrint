let stop;
export function stopUpdates() { stop?.(); stop = undefined; }
// A connector heartbeat timestamp changes every few seconds. Only whether the printer is online (seen
// in the last 3 minutes) is shown, so compare that instead of the raw time; otherwise every check-in
// re-rendered the page under the owner while they were reading it.
const visible = value => JSON.stringify(value, (key, v) => key === 'heartbeat' ? Boolean(v && Date.now() - Date.parse(v) < 180000) : v);

// Short polling works across Vercel instances and sleeping mobile browsers.
export function watchUpdates(load, initial, changed, milliseconds = 5000) {
  stopUpdates();
  let cancelled = false, timer, signature = visible(initial);
  const tick = async () => {
    if (cancelled) return;
    try {
      // Preserve typed references and account forms while they are being edited.
      if (!document.hidden && !document.querySelector('dialog[open],button[data-action]:disabled,button[data-shop]:disabled,#nav-toggle[aria-expanded="true"]') && !document.activeElement?.matches('input,select,textarea')) {
        const next = await load(), value = visible(next);
        if (!cancelled && value !== signature) { signature = value; await changed(next); }
      }
    } catch { /* Keep the last known state; explicit Refresh still reports errors. */ }
    if (!cancelled) timer = setTimeout(tick, milliseconds);
  };
  timer = setTimeout(tick, milliseconds);
  stop = () => { cancelled = true; clearTimeout(timer); };
}
