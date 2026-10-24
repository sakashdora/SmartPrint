export async function waitForQuote(initial, api, { timeout = 120000, interval = 1500, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let result = initial;
  const deadline = now() + timeout;
  while (result.pending && now() < deadline) {
    await sleep(interval);
    result = await api(`/api/preparations/${initial.id}`, { token: initial.token });
  }
  if (result.error) throw Object.assign(new Error(result.error), { preparationFailed: true });
  if (result.pending) throw new Error('The shop is still preparing your document. Please retry shortly or ask the shop to check its printer connection.');
  if (!result.id || !result.token || !Number.isFinite(result.amount) || !Number.isFinite(Date.parse(result.expires))) throw new Error('The print file is not ready. Please retry preparation.');
  return result;
}
