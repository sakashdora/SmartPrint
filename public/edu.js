// Institution workspace for Education organizations. Loaded on demand; the shop and customer screens do not use it.
const TABS = [
  ['overview', 'Overview', 'institution.profile.edit'], ['print', 'Print', 'jobs.submit'], ['queue', 'Queue', 'jobs.view_queue'],
  ['people', 'People', 'users.read'], ['printers', 'Printers', 'printers.manage'], ['agents', 'Agents', 'agents.manage'], ['reports', 'Reports', 'reports.view_org']
];
const ROLE_LABEL = r => String(r).replaceAll('_', ' ');
const STATUS_TEXT = { queued: 'Waiting', claimed: 'Starting', submitted: 'Printing', completed: 'Printed', failed: 'Failed', uncertain: 'Check output', cancelled: 'Cancelled' };

export async function collegeLogin({ api, mount, escape, notify, setMe, route }) {
  mount(`<main class="auth panel"><span class="eyebrow">STUDENTS &amp; STAFF</span><h1>Sign in with your College ID</h1>
    <p class="muted">Use the institution code your college gave you.</p>
    <form id="college-form">
      <label class="field">Institution code<input name="institutionCode" required maxlength="80" autocapitalize="none" autocomplete="organization"></label>
      <label class="field">College / staff ID<input name="collegeId" required maxlength="40" autocomplete="username"></label>
      <label class="field">Password<input name="password" type="password" required maxlength="128" autocomplete="current-password"></label>
      <label class="field" id="code-field" hidden>Authenticator code<input name="code" inputmode="numeric" maxlength="19" autocomplete="one-time-code"></label>
      <div id="college-error" class="inline-error" style="display:none" role="alert"></div>
      <button class="primary wide">Sign in →</button>
    </form>
    <p class="foot"><a href="#forgot-password">Forgot your password?</a> · <a href="#login">Sign in with e-mail</a></p></main>`);
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
  const shell = body => mount(`<main class="container"><div class="workhead"><div><span class="eyebrow">${escape(ROLE_LABEL(org.role)).toUpperCase()}</span><h1>${escape(org.name)}</h1></div><button class="secondary" id="logout">Sign out</button></div>
    <nav class="tabs" aria-label="Institution" style="display:flex;gap:18px;flex-wrap:wrap;margin:14px 0">${tabs.map(([id, label]) => `<a href="#edu/${id}" class="${id === current ? 'active' : ''}" style="${id === current ? 'font-weight:700;border-bottom:2px solid currentColor' : ''}" ${id === current ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>${body}</main>`);
  const time = v => v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const act = (selector, fn) => document.querySelectorAll(selector).forEach(el => { el.onclick = async event => { event.preventDefault(); el.disabled = true; try { await fn(el); } catch (e) { notify(e.message); el.disabled = false; } }; });
  const refresh = () => route();
  const table = (head, rows) => rows.length ? `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="muted">Nothing here yet.</p>';

  if (current === 'overview') {
    const info = await api('/api/v2/edu/institution');
    const p = info.policies, step = (done, text) => `<li>${done ? '✅' : '⬜'} ${text}</li>`;
    shell(`<section class="panel"><h2>Get started</h2><ul>${step(info.setup.agents > 0, 'Install the SmartPrint agent on the printer PC <a href="#edu/agents">(Agents)</a>')}${step(info.setup.printers > 0, 'Printers appear automatically once the agent runs <a href="#edu/printers">(Printers)</a>')}${step(info.setup.people > 1, 'Add staff and students <a href="#edu/people">(People)</a>')}</ul>
      <p class="muted">Departments and campuses are optional; add them whenever you need them. Students and staff sign in at <strong>#college-login</strong> with the institution code <strong>${escape(info.loginCode)}</strong> and their ID.</p></section>
      <section class="panel"><h2>Printing policies</h2><form id="policies">
        <label class="field">Student printing<select name="studentPrinting"><option value="disabled" ${p.studentPrinting === 'disabled' ? 'selected' : ''}>Off (until the wallet is available)</option><option value="free" ${p.studentPrinting === 'free' ? 'selected' : ''}>On, free of charge (pilot)</option></select></label>
        <label class="field">Max pages per job<input name="maxPagesPerJob" type="number" min="1" max="500" value="${p.maxPagesPerJob}"></label>
        <label class="field">Max copies<input name="maxCopies" type="number" min="1" max="100" value="${p.maxCopies}"></label>
        <label class="field"><span><input type="checkbox" name="colourStudents" ${p.colourStudents ? 'checked' : ''}> Students may print in colour</span></label>
        <label class="field"><span><input type="checkbox" name="colourStaff" ${p.colourStaff ? 'checked' : ''}> Staff may print in colour</span></label>
        <label class="field">Keep printed documents (hours, 0 = delete at once)<input name="retentionHoursAfterPrint" type="number" min="0" max="720" value="${p.retentionHoursAfterPrint}"></label>
        <label class="field">Student rate, black &amp; white (paise per side)<input name="studentRateBwMinor" type="number" min="0" value="${p.studentRateBwMinor}"></label>
        <label class="field">Student rate, colour (paise per side)<input name="studentRateColourMinor" type="number" min="0" value="${p.studentRateColourMinor}"></label>
        <button class="primary">Save policies</button></form></section>`);
    document.querySelector('#policies').onsubmit = async event => {
      event.preventDefault();
      const f = event.target, num = n => Number(f[n].value);
      try {
        await api('/api/v2/edu/institution/policies', { method: 'PUT', body: { version: info.version, policies: { studentPrinting: f.studentPrinting.value, maxPagesPerJob: num('maxPagesPerJob'), maxCopies: num('maxCopies'), colourStudents: f.colourStudents.checked, colourStaff: f.colourStaff.checked, retentionHoursAfterPrint: num('retentionHoursAfterPrint'), studentRateBwMinor: num('studentRateBwMinor'), studentRateColourMinor: num('studentRateColourMinor') } } });
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
    const cap = v => v === null || v === undefined ? 'unknown' : v ? 'yes' : 'no';
    shell(`<section class="panel"><h2>Printers</h2><p class="muted">Colour and two-sided jobs only go to printers that report those abilities.</p>
      ${table(['Printer', 'Agent', 'Colour', 'Two-sided', 'State', ''], printers.map(p => `<tr><td>${escape(p.display_name)}</td><td>${escape(p.agent_name)}</td><td>${cap(p.cap_color)}</td><td>${cap(p.cap_duplex)}</td><td>${p.paused ? 'Paused' : p.online ? 'Online' : 'Offline'}</td><td><button class="secondary small" data-pause="${escape(p.id)}" data-paused="${p.paused}">${p.paused ? 'Resume' : 'Pause'}</button> <button class="secondary small" data-test="${escape(p.id)}">Test page</button></td></tr>`))}</section>`);
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
  } else if (current === 'reports') {
    const r = await api('/api/v2/edu/reports/usage');
    const rows = Object.entries(r.byClass).map(([k, v]) => `<tr><td>${escape(k)}</td><td>${v.jobs}</td><td>${v.completed}</td><td>${v.pagesPrinted}</td><td>${v.colourJobs}</td></tr>`);
    shell(`<section class="panel"><h2>Usage</h2><p>${r.total.jobs} jobs, ${r.total.pagesPrinted} pages printed.</p>${table(['Class', 'Jobs', 'Printed', 'Pages', 'Colour jobs'], rows)}</section>`);
  } else {
    const jobs = await api('/api/v2/edu/jobs');
    shell(`<section class="panel"><h2>Print a document</h2>
      <form id="print-form">
        <label class="field">File (PDF, PNG or JPEG, up to 20 MB)<input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required></label>
        <label class="field">Copies<input name="copies" type="number" min="1" max="100" value="1"></label>
        <label class="field">Colour<select name="color"><option value="bw">Black &amp; white</option><option value="color">Colour</option></select></label>
        <label class="field"><span><input type="checkbox" name="duplex"> Print on both sides</span></label>
        <label class="field">Pages (e.g. 1-3, 5; empty = all)<input name="range" maxlength="200"></label>
        <div id="quote" class="notice-inline" hidden></div>
        <button class="secondary" id="quote-btn" type="button">Check price</button> <button class="primary" id="print-btn">Print</button></form></section>
      <section class="panel"><h2>My prints</h2>${table(['File', 'Pages', 'Status', 'When', ''], jobs.map(j => `<tr><td>${escape(j.fileName || 'Document')}</td><td>${j.pages}</td><td>${escape(STATUS_TEXT[j.status] || j.status)}</td><td>${escape(time(j.enqueued_at))}</td><td>${j.status === 'queued' ? `<button class="secondary small" data-cancel="${escape(j.id)}">Cancel</button>` : ''}</td></tr>`))}</section>`);
    const form = document.querySelector('#print-form'), quoteBox = document.querySelector('#quote');
    const optionsOf = () => ({ copies: Number(form.copies.value), color: form.color.value, duplex: form.duplex.checked, range: form.range.value.trim() });
    const upload = async () => {
      const file = form.file.files[0]; if (!file) throw new Error('Choose a file.');
      const response = await fetch('/api/v2/edu/documents', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Upload failed.');
      return body.documentId;
    };
    document.querySelector('#quote-btn').onclick = async event => {
      event.target.disabled = true;
      try { const q = await api('/api/v2/edu/jobs/quote', { method: 'POST', body: { documentId: await upload(), options: optionsOf() } }); quoteBox.hidden = false; quoteBox.textContent = `${q.pages} pages, ${q.sheets} sheets${q.payer === 'student' ? `, rate value ₹${(q.costMinor / 100).toFixed(2)} (not charged yet)` : ', no charge'}.`; }
      catch (err) { notify(err.message); }
      event.target.disabled = false;
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const button = document.querySelector('#print-btn'); button.disabled = true;
      try { await api('/api/v2/edu/jobs', { method: 'POST', body: { documentId: await upload(), fileName: form.file.files[0].name, options: optionsOf() } }); notify('Sent to the printer queue.'); await refresh(); }
      catch (err) { notify(err.message); button.disabled = false; }
    };
    act('[data-cancel]', async el => { await api(`/api/v2/edu/my-jobs/${el.dataset.cancel}/cancel`, { method: 'POST' }); await refresh(); });
  }
}
