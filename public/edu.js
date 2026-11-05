// Institution workspace for Education organizations. Loaded on demand; the shop and customer screens do not use it.
const TABS = [
  ['overview', 'Overview', 'institution.profile.edit'], ['print', 'Print', 'jobs.submit'], ['queue', 'Queue', 'jobs.view_queue'],
  ['wallet', 'My wallet', 'wallet.view_own'], ['wallets', 'Wallets', 'wallet.view_any'], ['people', 'People', 'users.read'], ['printers', 'Printers', 'printers.manage'], ['agents', 'Agents', 'agents.manage'], ['reports', 'Reports', 'reports.view_org']
];
const ROLE_LABEL = r => String(r).replaceAll('_', ' ');
const STATUS_TEXT = { queued: 'Waiting', claimed: 'Starting', submitted: 'Printing', completed: 'Printed', failed: 'Failed', uncertain: 'Check output', cancelled: 'Cancelled' };

export async function collegeLogin({ api, mount, escape, notify, setMe, route }) {
  mount(`<main class="auth panel"><nav class="audience-switch" aria-label="Who is signing in"><a href="#login">Shop owner</a><a href="#college-login" class="is-active" aria-current="page">College student or staff</a></nav>
    <span class="eyebrow">STUDENTS &amp; STAFF</span><h1>Sign in with your College ID</h1>
    <p class="muted">Use the institution code your college gave you. Ask your print desk if you do not have it.</p>
    <form id="college-form">
      <label class="field">Institution code<input name="institutionCode" required maxlength="80" autocapitalize="none" autocomplete="organization"></label>
      <label class="field">College / staff ID<input name="collegeId" required maxlength="40" autocomplete="username"></label>
      <label class="field">Password<input name="password" type="password" required maxlength="128" autocomplete="current-password"></label>
      <label class="field" id="code-field" hidden>Authenticator code<input name="code" inputmode="numeric" maxlength="19" autocomplete="one-time-code"></label>
      <div id="college-error" class="inline-error" style="display:none" role="alert"></div>
      <button class="primary wide">Sign in →</button>
    </form>
    <p class="foot"><a href="#forgot-password">Forgot your password?</a></p></main>`);
  const form = document.querySelector('#college-form');
  try { const saved = localStorage.getItem('sp-institution'); if (saved) form.institutionCode.value = saved; } catch {}
  form.onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form)), error = document.querySelector('#college-error');
    error.style.display = 'none';
    try {
      const user = await api('/api/auth/login', { method: 'POST', body: { ...data, code: data.code || undefined } });
      try { localStorage.setItem('sp-institution', data.institutionCode); } catch {}
      setMe(user); location.hash = user.mfaRequired ? 'security' : 'edu'; await route();
    } catch (err) {
      if (err.details?.mfaRequired) { document.querySelector('#code-field').hidden = false; notify('Enter your authenticator code.'); return; }
      error.textContent = err.message; error.style.display = 'block';
    }
  };
}

export async function eduApp(view, { api, mount, escape, notify, route }) {
  const context = await api('/api/v2/me');
  const org = context.organization, can = p => context.permissions.includes(p);
  const tabs = TABS.filter(([, , permission]) => can(permission));
  if (!tabs.length) return mount(`<main class="auth panel"><h1>${escape(org?.name || 'Institution')}</h1><p class="muted">Your role has no screens yet.</p><button class="secondary" id="logout">Sign out</button></main>`);
  const current = tabs.find(([id]) => id === view) ? view : tabs[0][0];
  const shell = body => mount(`<main class="container edu-shell"><div class="workhead edu-head"><div><span class="eyebrow">${escape(ROLE_LABEL(org.role)).toUpperCase()}</span><h1>${escape(org.name)}</h1></div><button class="secondary small" id="logout">Sign out</button></div>
    <nav class="edu-tabs" aria-label="Institution">${tabs.map(([id, label]) => `<a href="#edu/${id}" class="${id === current ? 'active' : ''}" ${id === current ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>${body}</main>`);
  const time = v => v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const act = (selector, fn) => document.querySelectorAll(selector).forEach(el => { el.onclick = async event => { event.preventDefault(); el.disabled = true; try { await fn(el); } catch (e) { notify(e.message); el.disabled = false; } }; });
  const refresh = () => route();
  const table = (head, rows, empty = 'Nothing here yet.') => rows.length ? `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<div class="empty-state">${empty}</div>`;

  if (current === 'overview') {
    const info = await api('/api/v2/edu/institution');
    const p = info.policies, step = (done, text) => `<li class="${done ? 'is-done' : ''}"><span class="step-dot" aria-hidden="true">${done ? '✓' : ''}</span><span>${text}${done ? ' <span class="sr-only">(done)</span>' : ''}</span></li>`;
    shell(`<section class="panel"><h2>Get started</h2><ul class="checklist">${step(info.setup.agents > 0, 'Install the SmartPrint agent on the printer PC <a href="#edu/agents">(Agents)</a>')}${step(info.setup.printers > 0, 'Printers appear automatically once the agent runs <a href="#edu/printers">(Printers)</a>')}${step(info.setup.people > 1, 'Add staff and students <a href="#edu/people">(People)</a>')}</ul>
      <p class="muted">Departments and campuses are optional; add them whenever you need them. Students and staff sign in at <strong>${escape(location.origin)}/#college-login</strong> with the institution code <strong>${escape(info.loginCode)}</strong> and their ID.</p></section>
      <section class="panel"><h2>Printing policies</h2><form id="policies" class="form-grid">
        <label class="field">Student printing<select name="studentPrinting"><option value="disabled" ${p.studentPrinting === 'disabled' ? 'selected' : ''}>Off</option><option value="free" ${p.studentPrinting === 'free' ? 'selected' : ''}>On, free of charge (pilot)</option><option value="wallet" ${p.studentPrinting === 'wallet' ? 'selected' : ''}>On, charged from the student wallet</option></select></label>
        <label class="field">Max pages per job<input name="maxPagesPerJob" type="number" min="1" max="500" value="${p.maxPagesPerJob}"></label>
        <label class="field">Max copies<input name="maxCopies" type="number" min="1" max="100" value="${p.maxCopies}"></label>
        <label class="field"><span><input type="checkbox" name="colourStudents" ${p.colourStudents ? 'checked' : ''}> Students may print in colour</span></label>
        <label class="field"><span><input type="checkbox" name="colourStaff" ${p.colourStaff ? 'checked' : ''}> Staff may print in colour</span></label>
        <label class="field"><span><input type="checkbox" name="onlineTopups" ${p.onlineTopups ? 'checked' : ''}> Students may add money online (needs the payment settings below)</span></label>
                <label class="field">Keep printed documents (hours, 0 = delete at once)<input name="retentionHoursAfterPrint" type="number" min="0" max="720" value="${p.retentionHoursAfterPrint}"></label>
        <label class="field">Student rate, black &amp; white (paise per side)<input name="studentRateBwMinor" type="number" min="0" value="${p.studentRateBwMinor}"></label>
        <label class="field">Student rate, colour (paise per side)<input name="studentRateColourMinor" type="number" min="0" value="${p.studentRateColourMinor}"></label>
        <button class="primary">Save policies</button></form></section>`);
    if (can('payments.configure')) {
      const pay = await api('/api/v2/edu/payments/settings').catch(() => ({ configured: false }));
      document.querySelector('#policies').closest('section').insertAdjacentHTML('afterend', `<section class="panel"><h2>Online payments (Razorpay)</h2>
        <p class="muted">Money from student top-ups goes straight to <strong>your own</strong> Razorpay account. Create the keys in your Razorpay dashboard and add the webhook address shown below.</p>
        ${pay.configured ? `<p>Status: <strong>${pay.enabled ? 'on' : 'off'}</strong> (${escape(pay.mode)} mode, key ${escape(pay.keyId)}).<br>Webhook address: <input readonly style="width:100%" value="${escape(pay.webhookUrl)}" onclick="this.select()"><br><small class="muted">Subscribe it to payment.captured, payment.failed and refund.processed.</small></p>` : '<p class="muted">Not set up yet.</p>'}
        <form id="pay-form"><label class="field">Key ID<input name="keyId" required placeholder="rzp_test_…" autocomplete="off"></label>
        <label class="field">Key secret<input name="keySecret" type="password" required autocomplete="off"></label>
        <label class="field">Webhook secret<input name="webhookSecret" type="password" required autocomplete="off"></label>
        <label class="field"><span><input type="checkbox" name="confirmLive"> These are LIVE keys and I am authorised to take real payments</span></label>
        <button class="primary">Save payment settings</button></form></section>`);
      document.querySelector('#pay-form').onsubmit = async event => {
        event.preventDefault();
        const f = event.target;
        try { await api('/api/v2/edu/payments/settings', { method: 'PUT', body: { keyId: f.keyId.value.trim(), keySecret: f.keySecret.value, webhookSecret: f.webhookSecret.value, confirmLive: f.confirmLive.checked } }); notify('Payment settings saved. Secrets are stored encrypted and are never shown again.'); await refresh(); }
        catch (err) { notify(err.message); }
      };
    }
    // Alerts, webhooks and sign-in sessions (each panel appears only for people allowed to use it).
    const when = value => value ? new Date(value).toLocaleString() : '';
    if (can('agents.view_health')) {
      const alerts = await api('/api/v2/edu/alerts').catch(() => []);
      const openAlerts = alerts.filter(a => !a.resolved);
      document.querySelector('#policies').closest('section').insertAdjacentHTML('beforebegin', `<section class="panel"><h2>Alerts</h2>
        ${openAlerts.length ? `<ul>${openAlerts.map(a => `<li><strong>${escape(a.kind.replaceAll('_', ' '))}</strong>: ${escape(a.message)} <small class="muted">since ${escape(when(a.opened))}</small></li>`).join('')}</ul>` : '<p class="muted">Nothing needs attention. Alerts appear here (and are e-mailed to administrators) when a print PC goes quiet, printers are unavailable while work waits, a job is left uncertain, or the wallet check finds a problem.</p>'}
        ${alerts.length > openAlerts.length ? `<details><summary>Earlier alerts</summary><ul>${alerts.filter(a => a.resolved).slice(0, 10).map(a => `<li>${escape(a.message)} <small class="muted">${escape(when(a.lastSeen))}</small></li>`).join('')}</ul></details>` : ''}</section>`);
    }
    if (can('integrations.manage')) {
      const hooks = await api('/api/v2/edu/webhooks').catch(() => ({ events: [], endpoints: [] }));
      document.querySelector('#policies').closest('section').insertAdjacentHTML('afterend', `<section class="panel" id="webhooks"><h2>Webhooks</h2>
        <p class="muted">Send events (job printed or failed, wallet top-ups, alerts) to your own system, for example an ERP. Each request is signed with a secret; the receiver must use https and be reachable from the internet. Events contain ids only, never names or documents.</p>
        ${hooks.endpoints.length ? table(['Address', 'Events', 'Status', ''], hooks.endpoints.map(h => `<tr><td>${escape(h.url)}</td><td>${escape(h.events.join(', '))}</td><td>${escape(h.status)}</td><td><button class="secondary small" data-hook-test="${escape(h.id)}">Send test</button> <button class="secondary small" data-hook-toggle="${escape(h.id)}" data-status="${escape(h.status)}">${h.status === 'active' ? 'Disable' : 'Enable'}</button> <button class="secondary small" data-hook-rotate="${escape(h.id)}">New secret</button> <button class="secondary small" data-hook-log="${escape(h.id)}">Deliveries</button> <button class="secondary small" data-hook-delete="${escape(h.id)}">Delete</button></td></tr>`)) : '<p class="muted">No webhooks yet.</p>'}
        <div id="hook-output"></div>
        <form id="hook-form"><label class="field">Receiver address<input name="url" type="url" required maxlength="500" placeholder="https://erp.college.edu/smartprint"></label>
        <fieldset class="field"><legend>Events</legend>${hooks.events.filter(e => e !== 'ping').map(e => `<label style="margin-right:14px"><input type="checkbox" name="event" value="${escape(e)}" ${['job.completed', 'job.failed', 'job.uncertain'].includes(e) ? 'checked' : ''}> ${escape(e)}</label>`).join('')}</fieldset>
        <button class="primary">Add webhook</button></form></section>`);
      const out = html => { document.querySelector('#hook-output').innerHTML = html; };
      document.querySelector('#hook-form').onsubmit = async event => {
        event.preventDefault();
        const f = event.target, events = [...f.querySelectorAll('[name=event]:checked')].map(i => i.value);
        try { const r = await api('/api/v2/edu/webhooks', { method: 'POST', body: { url: f.url.value.trim(), events } }); out(`<div class="notice-inline">Signing secret (shown once): <code>${escape(r.secret)}</code></div>`); f.reset(); }
        catch (err) { notify(err.message); }
      };
      const hookAct = (attr, run) => act(`[${attr}]`, async el => { try { await run(el.getAttribute(attr)); } finally { el.disabled = false; } });
      hookAct('data-hook-test', async id => { await api(`/api/v2/edu/webhooks/${id}/test`, { method: 'POST' }); notify('Test event queued. It is sent within a minute; check Deliveries.'); });
      hookAct('data-hook-rotate', async id => { const r = await api(`/api/v2/edu/webhooks/${id}/rotate-secret`, { method: 'POST' }); out(`<div class="notice-inline">New signing secret (shown once; the old one no longer works): <code>${escape(r.secret)}</code></div>`); });
      hookAct('data-hook-delete', async id => { if (confirm('Delete this webhook and its delivery history?')) { await api(`/api/v2/edu/webhooks/${id}`, { method: 'DELETE' }); await refresh(); } });
      document.querySelectorAll('[data-hook-toggle]').forEach(b => b.onclick = async () => { try { await api(`/api/v2/edu/webhooks/${b.dataset.hookToggle}`, { method: 'PATCH', body: { status: b.dataset.status === 'active' ? 'disabled' : 'active' } }); await refresh(); } catch (err) { notify(err.message); } });
      hookAct('data-hook-log', async id => { const rows = await api(`/api/v2/edu/webhooks/${id}/deliveries`); out(rows.length ? table(['Event', 'Result', 'Tries', 'Detail', 'When'], rows.map(r => `<tr><td>${escape(r.type)}</td><td>${escape(r.status)}</td><td>${r.attempts}</td><td>${escape(r.lastError || (r.lastStatus ? `HTTP ${r.lastStatus}` : ''))}</td><td>${escape(when(r.created))}</td></tr>`)) : '<p class="muted">No deliveries yet.</p>'); });
    }
    {
      const sessions = await api('/api/auth/sessions').catch(() => []);
      document.querySelector('main').insertAdjacentHTML('beforeend', `<section class="panel"><h2>Where you are signed in</h2>
        ${table(['Device', 'Last active', ''], sessions.map(s => `<tr><td>${escape(s.device)}${s.current ? ' <strong>(this device)</strong>' : ''}</td><td>${escape(when(s.lastSeen || s.created))}</td><td>${s.current ? '' : `<button class="secondary small" data-session-end="${escape(s.handle)}">Sign out</button>`}</td></tr>`))}
        ${sessions.length > 1 ? '<button class="secondary" id="end-others">Sign out all other devices</button>' : ''}
        <p class="muted">Administrator sessions end automatically after an hour without activity.</p></section>`);
      document.querySelectorAll('[data-session-end]').forEach(b => b.onclick = async () => { try { await api(`/api/auth/sessions/${b.dataset.sessionEnd}`, { method: 'DELETE' }); await refresh(); } catch (err) { notify(err.message); } });
      document.querySelector('#end-others')?.addEventListener('click', async () => { try { const r = await api('/api/auth/sessions/revoke-others', { method: 'POST' }); notify(`Signed out ${r.revoked} other device(s).`); await refresh(); } catch (err) { notify(err.message); } });
    }
    document.querySelector('#policies').onsubmit = async event => {
      event.preventDefault();
      const f = event.target, num = n => Number(f[n].value);
      try {
        await api('/api/v2/edu/institution/policies', { method: 'PUT', body: { version: info.version, policies: { studentPrinting: f.studentPrinting.value, maxPagesPerJob: num('maxPagesPerJob'), maxCopies: num('maxCopies'), colourStudents: f.colourStudents.checked, colourStaff: f.colourStaff.checked, onlineTopups: f.onlineTopups.checked, retentionHoursAfterPrint: num('retentionHoursAfterPrint'), studentRateBwMinor: num('studentRateBwMinor'), studentRateColourMinor: num('studentRateColourMinor') } } });
        notify('Policies saved.'); await refresh();
      } catch (err) { notify(err.message); }
    };
  } else if (current === 'agents') {
    const agents = await api('/api/v2/edu/agents');
    shell(`<section class="panel"><h2>Agents</h2><p class="muted">An agent is the SmartPrint program on a Windows PC that has printers attached.</p>
      ${table(['Name', 'Status', 'Version', 'Last seen', ''], agents.map(a => `<tr><td>${escape(a.name)}<br><small class="muted">${escape(a.hostname || '')}</small></td><td>${a.online ? 'Online' : escape(a.status)}</td><td>${escape(a.version || '')}</td><td>${escape(time(a.last_seen))}</td><td>${a.status !== 'revoked' ? `<button class="secondary small" data-revoke="${escape(a.id)}">Revoke</button>` : ''}</td></tr>`))}
      <form id="new-agent" class="inline-form"><label class="field">Name of the PC<input name="name" required maxlength="100" placeholder="Library PC"></label><button class="primary">Add agent</button></form><div id="agent-code"></div></section>`);
    document.querySelector('#new-agent').onsubmit = async event => {
      event.preventDefault();
      try { const r = await api('/api/v2/edu/agents', { method: 'POST', body: { name: event.target.name.value } }); document.querySelector('#agent-code').innerHTML = `<div class="notice-inline">Enrolment code (shown once, valid ${r.expiresInMinutes} minutes): <strong>${escape(r.enrolmentCode)}</strong><br>Enter it in the SmartPrint agent on the PC.</div>`; }
      catch (err) { notify(err.message); }
    };
    act('[data-revoke]', async el => { if (!confirm('Revoke this agent? It stops printing immediately.')) { el.disabled = false; return; } await api(`/api/v2/edu/agents/${el.dataset.revoke}/revoke`, { method: 'POST' }); await refresh(); });
  } else if (current === 'printers') {
    const printers = await api('/api/v2/edu/printers');
    // Colour and two-sided are choices the administrator can always make; detection only pre-fills them.
    const capSelect = (p, kind) => {
      const value = kind === 'color' ? p.cap_color : p.cap_duplex, labels = kind === 'color' ? ['Black &amp; white only', 'Colour'] : ['One-sided only', 'Two-sided (automatic)'];
      const unset = value === null || value === undefined;
      return `<select data-cap="${escape(p.id)}" data-kind="${kind}" aria-label="${kind === 'color' ? 'Colour' : 'Two-sided'} for ${escape(p.display_name)}">${unset ? '<option value="" selected disabled>Not detected: choose</option>' : ''}<option value="false" ${!unset && !value ? 'selected' : ''}>${labels[0]}</option><option value="true" ${!unset && value ? 'selected' : ''}>${labels[1]}</option></select>`;
    };
    shell(`<section class="panel"><h2>Printers</h2><p class="muted">Say what each printer can do: black &amp; white only or colour, one-sided only or two-sided. Colour and two-sided jobs only go to printers set up for them. The agent pre-fills what it detects; what you choose is kept.</p>
      ${table(['Printer', 'Agent', 'Colour', 'Two-sided', 'State', ''], printers.map(p => `<tr><td>${escape(p.display_name)}</td><td>${escape(p.agent_name)}</td><td>${capSelect(p, 'color')}</td><td>${capSelect(p, 'duplex')}${p.cap_source === 'admin' ? `<br><small class="muted">set by you · <a href="#" data-detect="${escape(p.id)}">use detected</a></small>` : ''}</td><td>${p.paused ? 'Paused' : p.online ? 'Online' : 'Offline'}</td><td><button class="secondary small" data-pause="${escape(p.id)}" data-paused="${p.paused}">${p.paused ? 'Resume' : 'Pause'}</button> <button class="secondary small" data-test="${escape(p.id)}">Test page</button></td></tr>`), 'No printers yet. Install the SmartPrint agent on the PC the printer is connected to (Agents tab). Its printers appear here by themselves.')}</section>`);
    document.querySelectorAll('select[data-cap]').forEach(select => select.onchange = async () => {
      const row = select.closest('tr'), get = kind => row.querySelector(`select[data-kind=${kind}]`).value;
      const body = {};
      for (const kind of ['color', 'duplex']) if (get(kind) !== '') body[kind === 'color' ? 'capColor' : 'capDuplex'] = get(kind) === 'true';
      try { await api(`/api/v2/edu/printers/${select.dataset.cap}`, { method: 'PATCH', body }); notify('Printer abilities saved.'); await refresh(); } catch (err) { notify(err.message); }
    });
    document.querySelectorAll('[data-detect]').forEach(link => link.onclick = async event => {
      event.preventDefault();
      try { await api(`/api/v2/edu/printers/${link.dataset.detect}`, { method: 'PATCH', body: { useDetected: true } }); notify('This printer will use what the agent detects.'); await refresh(); } catch (err) { notify(err.message); }
    });
    // Printer groups: which printers belong to a group and which departments may use it (no department = open to everyone).
    const [pools, depts] = await Promise.all([api('/api/v2/edu/pools'), api('/api/v2/edu/departments').catch(() => [])]);
    document.querySelector('main .panel').insertAdjacentHTML('afterend', `<section class="panel"><h2>Printer groups</h2>
      <p class="muted">A group is a set of printers. Leave every department unticked to make a group open to everyone; tick departments to reserve it for them. Several departments can share a group, and a department can have several groups.</p>
      ${pools.map(g => `<form class="pool" data-pool="${escape(g.id)}" style="border-top:1px solid #ddd;padding:10px 0"><strong>${escape(g.name)}</strong> <small class="muted">${g.departmentIds.length ? 'reserved for the ticked departments' : 'open to everyone'}</small>
        <div><small class="muted">Printers</small><br>${printers.map(p => `<label style="margin-right:14px"><input type="checkbox" name="printer" value="${escape(p.id)}" ${g.printerIds.includes(p.id) ? 'checked' : ''}> ${escape(p.display_name)}</label>`).join('') || '<small class="muted">No printers yet.</small>'}</div>
        ${depts.length ? `<div><small class="muted">Departments</small><br>${depts.map(d => `<label style="margin-right:14px"><input type="checkbox" name="dept" value="${escape(d.id)}" ${g.departmentIds.includes(d.id) ? 'checked' : ''}> ${escape(d.name)}</label>`).join('')}</div>` : ''}
        <button class="secondary small">Save group</button></form>`).join('')}
      <form id="new-pool" class="inline-form"><label class="field">New group<input name="name" required maxlength="80" placeholder="Physics lab"></label><button class="primary">Create group</button></form></section>`);
    document.querySelectorAll('form.pool').forEach(form => form.onsubmit = async event => {
      event.preventDefault();
      const ids = name => [...form.querySelectorAll(`[name=${name}]:checked`)].map(i => i.value);
      try {
        await api(`/api/v2/edu/pools/${form.dataset.pool}/members`, { method: 'PUT', body: { printerIds: ids('printer') } });
        await api(`/api/v2/edu/pools/${form.dataset.pool}/access`, { method: 'PUT', body: { departmentIds: ids('dept') } });
        notify('Group saved.'); await refresh();
      } catch (err) { notify(err.message); }
    });
    document.querySelector('#new-pool').onsubmit = async event => {
      event.preventDefault();
      try { await api('/api/v2/edu/pools', { method: 'POST', body: { name: event.target.name.value } }); await refresh(); } catch (err) { notify(err.message); }
    };
    act('[data-pause]', async el => { await api(`/api/v2/edu/printers/${el.dataset.pause}/${el.dataset.paused === '1' ? 'resume' : 'pause'}`, { method: 'POST' }); await refresh(); });
    act('[data-test]', async el => { await api(`/api/v2/edu/printers/${el.dataset.test}/test-print`, { method: 'POST' }); notify('Test page queued.'); el.disabled = false; });
  } else if (current === 'people') {
    const [users, departments] = await Promise.all([api('/api/v2/edu/users'), api('/api/v2/edu/departments').catch(() => [])]);
    const canCreate = can('users.create'), canImport = can('users.import');
    shell(`<section class="panel"><h2>People (${users.length})</h2>
      ${table(['Name', 'ID', 'Role', 'Status', ''], users.map(u => `<tr><td>${escape(u.name)}</td><td>${escape(u.college_id)}</td><td>${escape(ROLE_LABEL(u.role))}</td><td>${escape(u.status)}</td><td>${can('users.reset_password') ? `<button class="secondary small" data-reset="${escape(u.user_id)}">Reset password</button>` : ''}</td></tr>`))}
      <div id="link-box"></div></section>
      ${canCreate ? `<section class="panel"><h2>Add a person</h2><form id="add-person">
        <label class="field">Role<select name="role"><option value="student">Student</option><option value="staff">Staff</option>${org.role === 'institution_admin' ? '<option value="print_operator">Print operator</option><option value="department_admin">Department admin</option>' : ''}</select></label>
        <label class="field">College / staff ID<input name="collegeId" required maxlength="40"></label><label class="field">Name<input name="name" required maxlength="100"></label>
        <label class="field">E-mail (optional)<input name="email" type="email" maxlength="254"></label>
        ${departments.length ? `<label class="field">Department<select name="departmentId"><option value="">None</option>${departments.map(d => `<option value="${escape(d.id)}">${escape(d.name)}</option>`).join('')}</select></label>` : ''}
        <button class="primary">Add</button></form></section>` : ''}
      ${canImport ? `<section class="panel"><h2>Import from a spreadsheet</h2><p class="muted">Paste CSV rows: <code>ID,name,e-mail,department,role</code> (e-mail, department and role optional).</p>
        <textarea id="csv" rows="6" style="width:100%" placeholder="21CS001,Asha Rao,asha@college.edu,CSE,student"></textarea>
        <p><button class="secondary" id="dry">Check</button> <button class="primary" id="run">Import valid rows</button></p><div id="import-result"></div></section>` : ''}`);
    const box = document.querySelector('#link-box');
    const showLinks = (title, items) => { box.innerHTML = `<div class="notice-inline"><strong>${escape(title)}</strong><br>Give each person their link; it works once.<ul>${items.map(i => `<li>${escape(i.name || '')} ${escape(i.collegeId || '')}: <input readonly style="width:70%" value="${escape(i.activationLink)}" onclick="this.select()"></li>`).join('')}</ul></div>`; };
    act('[data-reset]', async el => { const r = await api(`/api/v2/edu/users/${el.dataset.reset}/reset-password`, { method: 'POST' }); showLinks('Password reset link (24 hours)', [{ activationLink: r.activationLink }]); el.disabled = false; });
    const form = document.querySelector('#add-person');
    if (form) form.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      try { const r = await api('/api/v2/edu/users', { method: 'POST', body: data }); showLinks('Person added', [r]); form.reset(); await new Promise(r2 => setTimeout(r2, 0)); }
      catch (err) { notify(err.message); }
    };
    const rows = () => document.querySelector('#csv').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => { const [collegeId, name, email, department, role] = line.split(',').map(s => s.trim()); return { collegeId, name, email: email || undefined, department: department || undefined, role: role || undefined }; });
    const runImport = async dryRun => {
      const result = document.querySelector('#import-result');
      try {
        const r = await api('/api/v2/edu/users/import', { method: 'POST', body: { rows: rows(), dryRun, skipInvalid: !dryRun } });
        result.innerHTML = `<p>${r.summary.valid ?? r.summary.created} valid, ${r.summary.invalid} with problems.</p>${r.results.filter(x => !x.ok).map(x => `<div class="error">Row ${x.row} (${escape(x.collegeId)}): ${escape(x.error)}</div>`).join('')}`;
        if (!dryRun) showLinks(`${r.summary.created} people added`, r.activations);
      } catch (err) { result.innerHTML = `<div class="error">${escape(err.message)}</div>`; }
    };
    if (canImport) { document.querySelector('#dry').onclick = () => runImport(true); document.querySelector('#run').onclick = () => runImport(false); }
  } else if (current === 'queue') {
    const jobs = await api('/api/v2/edu/queue');
    const canResolve = can('jobs.resolve_uncertain');
    shell(`<section class="panel"><h2>Print queue</h2><button class="secondary small" id="reload">Refresh</button>
      ${table(['Job', 'Class', 'Pages', 'Status', 'Queued', ''], jobs.map(j => `<tr><td>${escape(j.id.slice(0, 8))}${j.requires_color ? ' 🎨' : ''}</td><td>${escape(j.class)}</td><td>${j.pages_printed ?? ''}${j.pages_printed != null ? ' / ' : ''}${j.pages}</td><td>${escape(STATUS_TEXT[j.status] || j.status)}</td><td>${escape(time(j.enqueued_at))}</td><td>${j.status === 'failed' ? `<button class="secondary small" data-job="${escape(j.id)}" data-do="retry">Retry</button> ` : ''}${['queued', 'claimed', 'failed'].includes(j.status) ? `<button class="secondary small" data-job="${escape(j.id)}" data-do="cancel">Cancel</button>` : ''}${j.status === 'uncertain' && canResolve ? `<button class="primary small" data-job="${escape(j.id)}" data-do="printed">It printed</button> <button class="secondary small" data-job="${escape(j.id)}" data-do="notprinted">Not printed / partial</button>` : ''}</td></tr>`))}</section>`);
    document.querySelector('#reload').onclick = refresh;
    act('[data-job]', async el => {
      const id = el.dataset.job, what = el.dataset.do;
      if (what === 'retry' || what === 'cancel') await api(`/api/v2/edu/jobs/${id}/${what}`, { method: 'POST' });
      else {
        let pages; if (what === 'notprinted') { const answer = prompt('How many pages came out? (0 if none)', '0'); if (answer === null) { el.disabled = false; return; } pages = Number(answer); }
        await api(`/api/v2/edu/jobs/${id}/resolve-uncertain`, { method: 'POST', body: { printed: what === 'printed', pages } });
      }
      await refresh();
    });
  } else if (current === 'wallet') {
    const w = await api('/api/v2/edu/wallet'), rupees = v => `₹${(v / 100).toFixed(2)}`;
    const label = { credit: 'Credit added', debit: 'Debit', hold: 'Reserved for a print', capture: 'Print charged', release: 'Reservation returned' };
    shell(`<section class="panel"><h2>My wallet</h2><p><strong style="font-size:1.6em">${rupees(w.available)}</strong> available${w.held ? ` · ${rupees(w.held)} reserved for prints in progress` : ''}</p>
      <p class="muted" id="topup-note">Ask the counter to add money to your wallet.</p><p id="topup-slot"></p>
      ${table(['When', 'What', 'Amount'], w.ledger.map(e => `<tr><td>${escape(time(e.created))}</td><td>${escape(label[e.kind] || e.kind)}${e.note ? `<br><small class="muted">${escape(e.note)}</small>` : ''}</td><td>${e.available_delta + e.held_delta === 0 ? '' : ''}${rupees(e.available_delta)}${e.held_delta ? ` <small class="muted">(${e.held_delta > 0 ? '+' : ''}${rupees(e.held_delta)} reserved)</small>` : ''}</td></tr>`))}</section>`);
    // Online top-up through the institution's own payment account, when it has been switched on.
    api('/api/v2/edu/wallet/topups/info').then(info => {
      if (!info.enabled) return;
      document.querySelector('#topup-note').textContent = 'Add money online, or ask the counter.';
      const slot = document.querySelector('#topup-slot'); slot.innerHTML = '<button class="primary" id="topup">Add money</button>';
      document.querySelector('#topup').onclick = async event => {
        const rupeesText = prompt(`Amount in rupees (at least ₹${(info.minMinor / 100).toFixed(0)}):`, '100'); if (!rupeesText) return;
        event.target.disabled = true;
        try {
          const order = await api('/api/v2/edu/wallet/topups', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { amountMinor: Math.round(Number(rupeesText) * 100) } });
          if (!window.Razorpay) await new Promise((resolve, reject) => { const tag = document.createElement('script'); tag.src = 'https://checkout.razorpay.com/v1/checkout.js'; tag.onload = resolve; tag.onerror = () => reject(new Error('The payment page could not be loaded.')); document.head.appendChild(tag); });
          new window.Razorpay({ key: order.keyId, order_id: order.orderId, amount: order.amount, currency: order.currency, name: org.name, description: 'Wallet top-up',
            handler: async response => { try { await api(`/api/v2/edu/wallet/topups/${order.intentId}/confirm`, { method: 'POST', body: response }); notify('Money added to your wallet.'); await refresh(); } catch (err) { notify(err.message); } },
            modal: { ondismiss: () => { event.target.disabled = false; } } }).open();
        } catch (err) { notify(err.message); event.target.disabled = false; }
      };
    }).catch(() => {});
  } else if (current === 'wallets') {
    const wallets = await api('/api/v2/edu/wallets'), check = await api('/api/v2/edu/wallets/verify'), rupees = v => `₹${(v / 100).toFixed(2)}`;
    shell(`<section class="panel"><h2>Student wallets</h2><p class="muted">Ledger check: ${check.ok ? '✅ balanced' : `⚠️ ${escape(check.problems.join('; '))}`}</p>
      ${table(['Student', 'ID', 'Available', 'Reserved', ''], wallets.map(w => `<tr><td>${escape(w.name)}</td><td>${escape(w.college_id)}</td><td>${rupees(w.available)}</td><td>${rupees(w.held)}</td><td><button class="secondary small" data-credit="${escape(w.user_id)}">Add money</button></td></tr>`))}</section>`);
    act('[data-credit]', async el => {
      const rupeesText = prompt('Amount received, in rupees:'); if (!rupeesText) { el.disabled = false; return; }
      const note = prompt('Reason / receipt number:', 'Cash at the counter'); if (!note) { el.disabled = false; return; }
      const amountMinor = Math.round(Number(rupeesText) * 100);
      await api(`/api/v2/edu/wallets/${el.dataset.credit}/credit`, { method: 'POST', body: { amountMinor, note, idempotencyKey: crypto.randomUUID() } });
      notify('Money added.'); await refresh();
    });
  } else if (current === 'reports') {
    const r = await api('/api/v2/edu/reports/usage');
    const rows = Object.entries(r.byClass).map(([k, v]) => `<tr><td>${escape(k)}</td><td>${v.jobs}</td><td>${v.completed}</td><td>${v.pagesPrinted}</td><td>${v.colourJobs}</td></tr>`);
    shell(`<section class="panel"><h2>Usage</h2><p>${r.total.jobs} jobs, ${r.total.pagesPrinted} pages printed.</p>${table(['Class', 'Jobs', 'Printed', 'Pages', 'Colour jobs'], rows)}</section>`);
  } else {
    const [jobs, pools] = await Promise.all([api('/api/v2/edu/jobs'), api('/api/v2/edu/pools/available').catch(() => [])]);
    shell(`<section class="panel"><h2>Print a document</h2>
      <form id="print-form">
        <label class="file-pick" id="file-pick"><span class="file-pick-title" id="file-pick-title">Choose the document to print</span><span class="file-pick-sub">PDF, PNG or JPEG, up to 20 MB</span><input class="visually-hidden" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required></label>
        <div class="print-options">
          <fieldset class="seg-field"><legend>Colour</legend><div class="seg"><label><input type="radio" name="color" value="bw" checked><span>Black &amp; white</span></label><label><input type="radio" name="color" value="color"><span>Colour</span></label></div></fieldset>
          <fieldset class="seg-field"><legend>Sides</legend><div class="seg"><label><input type="radio" name="duplex" value="false" checked><span>One-sided</span></label><label><input type="radio" name="duplex" value="true"><span>Both sides</span></label></div></fieldset>
          <label class="field">Copies<input name="copies" type="number" min="1" max="100" value="1" inputmode="numeric"></label>
          <label class="field">Pages <small class="muted">(for example 1-3, 5; empty = all)</small><input name="range" maxlength="200" inputmode="text"></label>
        </div>
        ${pools.length > 1 ? `<label class="field">Printer group<select name="poolId"><option value="">Automatic</option>${pools.map(g => `<option value="${escape(g.id)}">${escape(g.name)}</option>`).join('')}</select></label>` : ''}
        <div id="quote" class="notice-inline" hidden></div>
        <div class="print-actions"><button class="secondary" id="quote-btn" type="button">Check price</button><button class="primary" id="print-btn">Send to printer</button></div></form></section>
      <section class="panel"><h2>My prints</h2>${table(['File', 'Pages', 'Status', 'When', ''], jobs.map(j => `<tr><td>${escape(j.fileName || 'Document')}</td><td>${j.pages}</td><td>${escape(STATUS_TEXT[j.status] || j.status)}</td><td>${escape(time(j.enqueued_at))}</td><td>${j.status === 'queued' ? `<button class="secondary small" data-cancel="${escape(j.id)}">Cancel</button>` : ''}</td></tr>`))}</section>`);
    const form = document.querySelector('#print-form'), quoteBox = document.querySelector('#quote');
    const optionsOf = () => ({ copies: Number(form.copies.value), color: form.color.value, duplex: form.duplex.value === 'true', range: form.range.value.trim() });
    form.file.addEventListener('change', () => { const f = form.file.files[0]; document.querySelector('#file-pick-title').textContent = f ? f.name : 'Choose the document to print'; document.querySelector('#file-pick').classList.toggle('has-file', Boolean(f)); });
    const upload = async () => {
      const file = form.file.files[0]; if (!file) throw new Error('Choose a file.');
      const response = await fetch('/api/v2/edu/documents', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Upload failed.');
      return body.documentId;
    };
    document.querySelector('#quote-btn').onclick = async event => {
      event.target.disabled = true;
      try { const q = await api('/api/v2/edu/jobs/quote', { method: 'POST', body: { documentId: await upload(), options: optionsOf() } }); quoteBox.hidden = false; quoteBox.textContent = `${q.pages} pages, ${q.sheets} sheets${q.payer === 'student' ? (q.charged ? `, ₹${(q.costMinor / 100).toFixed(2)} from your wallet${q.shortfallMinor ? ` — you are ₹${(q.shortfallMinor / 100).toFixed(2)} short` : ''}` : `, rate value ₹${(q.costMinor / 100).toFixed(2)} (not charged)`) : ', no charge'}.`; }
      catch (err) { notify(err.message); }
      event.target.disabled = false;
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const button = document.querySelector('#print-btn'); button.disabled = true;
      try { await api('/api/v2/edu/jobs', { method: 'POST', body: { documentId: await upload(), fileName: form.file.files[0].name, options: optionsOf(), ...(form.poolId?.value ? { poolId: form.poolId.value } : {}) } }); notify('Sent to the printer queue.'); await refresh(); }
      catch (err) { notify(err.message); button.disabled = false; }
    };
    act('[data-cancel]', async el => { await api(`/api/v2/edu/my-jobs/${el.dataset.cancel}/cancel`, { method: 'POST' }); await refresh(); });
  }
}
