// Organization registration, review, invitations and password reset screens. Loaded on demand so the
// existing customer and shop screens are untouched.
const field = (label, name, { type = 'text', required = true, attrs = '', hint = '' } = {}) =>
  `<label class="field">${label}<input name="${name}" type="${type}" ${required ? 'required' : ''} ${attrs}>${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;
const card = (eyebrow, title, body) => `<main class="auth panel"><span class="eyebrow">${eyebrow}</span><h1>${title}</h1>${body}</main>`;

export async function orgPage(name, arg, { api, mount, escape, notify, me, route, setMe }) {
  const done = (eyebrow, title, message, linkHtml = '<a href="#login">Sign in</a>') => mount(card(eyebrow, title, `<p class="muted">${escape(message)}</p><p class="foot">${linkHtml}</p>`));

  if (name === 'register-org') {
    mount(card('JOIN SMARTPRINT', 'Register your organization', `
      <p class="muted">Tell us who you are. Your application is reviewed before the organization is activated.</p>
      <form id="org-form">
        <label class="field">Organization type<select name="type" id="org-type"><option value="business">Print shop / business</option><option value="education">College / university</option></select></label>
        ${field('Organization name', 'orgName', { attrs: 'maxlength="150"' })}
        <div id="business-fields">${field('Shop location', 'location', { required: true, attrs: 'maxlength="200"' })}</div>
        <div id="education-fields" hidden>
          ${field('Institution type (college, university, school…)', 'institutionType', { required: false, attrs: 'maxlength="60"' })}
          ${field('Registration / affiliation number', 'registrationNumber', { required: false, attrs: 'maxlength="80"' })}
          ${field('Address', 'address', { required: false, attrs: 'maxlength="300"' })}
          ${field('Website', 'website', { required: false, attrs: 'maxlength="200"' })}
          ${field('Your designation', 'repDesignation', { required: false, attrs: 'maxlength="100"' })}
        </div>
        <h2>Authorized representative</h2>
        ${field('Full name', 'repName', { attrs: 'maxlength="100" autocomplete="name"' })}
        ${field('Official e-mail', 'repEmail', { type: 'email', attrs: 'maxlength="254" autocomplete="email"' })}
        ${field('Phone', 'repPhone', { required: false, type: 'tel', attrs: 'maxlength="30"' })}
        <h2>Initial administrator</h2>
        <label class="field"><span><input type="checkbox" id="same-admin" checked> Same as the representative</span></label>
        <div id="admin-fields" hidden>${field('Administrator name', 'adminName', { required: false, attrs: 'maxlength="100"' })}${field('Administrator e-mail', 'adminEmail', { required: false, type: 'email', attrs: 'maxlength="254"' })}</div>
        <div id="org-error" class="inline-error" style="display:none" role="alert"></div>
        <button class="primary wide">Submit application →</button>
      </form>
      <p class="foot"><a href="#login">Already registered? Sign in</a></p>`));
    const form = document.querySelector('#org-form'), type = form.querySelector('#org-type');
    const sync = () => {
      const edu = type.value === 'education';
      document.querySelector('#education-fields').hidden = !edu;
      document.querySelector('#business-fields').hidden = edu;
      form.querySelector('[name=location]').required = !edu;
      for (const n of ['institutionType', 'address']) form.querySelector(`[name=${n}]`).required = edu;
    };
    type.onchange = sync; sync();
    document.querySelector('#same-admin').onchange = event => { document.querySelector('#admin-fields').hidden = event.target.checked; };
    form.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (document.querySelector('#same-admin').checked) { delete data.adminName; delete data.adminEmail; }
      const error = document.querySelector('#org-error'); error.style.display = 'none';
      try {
        const result = await api('/api/v2/registrations', { method: 'POST', body: data });
        try { localStorage.setItem('sp-application', JSON.stringify({ id: result.id, token: result.statusToken })); } catch {}
        done('APPLICATION SENT', 'Check your e-mail', result.message, '<a href="#application">Track your application</a>');
      } catch (err) { error.textContent = err.message; error.style.display = 'block'; }
    };
    return;
  }

  if (name === 'verify-email') {
    mount(card('CONFIRMING', 'Confirming your e-mail…', '<p class="muted">One moment.</p>'));
    try { const r = await api('/api/v2/registrations/verify-email', { method: 'POST', body: { token: arg } }); done('DONE', 'E-mail confirmed', r.message, '<a href="#application">Track your application</a>'); }
    catch (err) { done('LINK PROBLEM', 'We could not confirm this link', err.message, '<a href="#register-org">Register again</a>'); }
    return;
  }

  if (name === 'application') {
    let saved = null; try { saved = JSON.parse(localStorage.getItem('sp-application') || 'null'); } catch {}
    if (!saved) return done('APPLICATION', 'No application on this device', 'Open this page on the device where you applied.', '<a href="#register-org">Register an organization</a>');
    let status;
    try { status = await api(`/api/v2/registrations/${saved.id}/status`, { token: saved.token }); }
    catch (err) { return done('APPLICATION', 'Application not found', err.message, '<a href="#register-org">Register an organization</a>'); }
    const labels = { submitted: 'Waiting for e-mail confirmation', under_review: 'Under review', needs_info: 'More information needed', approved: 'Approved — check your e-mail for the sign-in link', rejected: 'Not approved' };
    mount(card('APPLICATION', escape(status.orgName), `
      <p><strong>${escape(labels[status.status] || status.status)}</strong></p>
      ${status.reason ? `<p class="muted">${escape(status.reason)}</p>` : ''}
      ${status.status === 'needs_info' ? '<form id="respond"><label class="field">Your reply<textarea name="message" required maxlength="1000" rows="4"></textarea></label><button class="primary wide">Send reply</button></form>' : ''}
      <p class="foot"><a href="#login">Sign in</a></p>`));
    const reply = document.querySelector('#respond');
    if (reply) reply.onsubmit = async event => {
      event.preventDefault();
      try { await api(`/api/v2/registrations/${saved.id}/respond`, { method: 'POST', token: saved.token, body: { message: new FormData(reply).get('message') } }); notify('Reply sent.'); await route(); }
      catch (err) { notify(err.message); }
    };
    return;
  }

  if (name === 'invite') {
    let info;
    try { info = await api(`/api/v2/invitations/${arg}`); }
    catch (err) { return done('INVITATION', 'This invitation cannot be used', err.message); }
    mount(card('WELCOME', `Set up ${escape(info.orgName)}`, `
      <p class="muted">You are joining as <strong>${escape(info.role.replaceAll('_', ' '))}</strong> with ${escape(info.email)}. Choose a password of at least 12 characters.</p>
      <form id="invite-form">${field('Password', 'password', { type: 'password', attrs: 'minlength="12" maxlength="128" autocomplete="new-password"' })}
      <div id="invite-error" class="inline-error" style="display:none" role="alert"></div><button class="primary wide">Create account →</button></form>`));
    const form = document.querySelector('#invite-form');
    form.onsubmit = async event => {
      event.preventDefault();
      try { const r = await api(`/api/v2/invitations/${arg}/accept`, { method: 'POST', body: { password: new FormData(form).get('password') } }); done('ALL SET', 'Account created', r.message); }
      catch (err) { const e = document.querySelector('#invite-error'); e.textContent = err.message; e.style.display = 'block'; }
    };
    return;
  }

  if (name === 'forgot-password') {
    mount(card('ACCOUNT', 'Reset your password', `<form id="forgot">${field('E-mail', 'email', { type: 'email', attrs: 'autocomplete="username"' })}<button class="primary wide">Send reset link</button></form><p class="foot"><a href="#login">Back to sign in</a></p>`));
    const form = document.querySelector('#forgot');
    form.onsubmit = async event => {
      event.preventDefault();
      try { const r = await api('/api/v2/auth/password/forgot', { method: 'POST', body: { email: new FormData(form).get('email') } }); done('CHECK YOUR E-MAIL', 'Reset link sent', r.message); }
      catch (err) { notify(err.message); }
    };
    return;
  }

  if (name === 'reset-password') {
    mount(card('ACCOUNT', 'Choose a new password', `<form id="reset">${field('New password', 'password', { type: 'password', attrs: 'minlength="12" maxlength="128" autocomplete="new-password"' })}<button class="primary wide">Change password</button></form>`));
    const form = document.querySelector('#reset');
    form.onsubmit = async event => {
      event.preventDefault();
      try { const r = await api('/api/v2/auth/password/reset', { method: 'POST', body: { token: arg, password: new FormData(form).get('password') } }); done('DONE', 'Password changed', r.message); }
      catch (err) { notify(err.message); }
    };
    return;
  }

  if (name === 'edu') {
    if (!me) { location.hash = 'login'; return; }
    const workspace = await import('./edu.js');
    return workspace.eduApp(arg, { api, mount, escape, notify, route });
  }
  if (name === 'college-login') {
    const workspace = await import('./edu.js');
    return workspace.collegeLogin({ api, mount, escape, notify, route, setMe });
  }
}

export async function registrationsView({ api, escape, time, notify, refresh }) {
  const [rows, outbox] = await Promise.all([api('/api/v2/platform/registrations'), api('/api/v2/platform/outbox').catch(() => [])]);
  const labels = { submitted: 'Unconfirmed e-mail', under_review: 'Under review', needs_info: 'Info requested', approved: 'Approved', rejected: 'Rejected' };
  const html = `<div class="workhead"><div><h1>Registrations</h1><p class="muted">Review organizations that applied through the common registration page.</p></div><button class="secondary" id="admin-refresh">Refresh</button></div>
    <section class="panel"><div class="panel-heading"><h2>Applications (${rows.length})</h2></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Organization</th><th>Type</th><th>Representative</th><th>Status</th><th>Received</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><strong>${escape(r.org_name)}</strong><br><small class="muted">${escape(r.org_type === 'education' ? (r.details.address || '') : (r.details.location || ''))}</small></td>
        <td>${r.org_type === 'education' ? 'College / University' : 'Business'}</td>
        <td>${escape(r.rep_name)}<br><small class="muted">${escape(r.rep_email)}</small></td>
        <td>${escape(labels[r.status] || r.status)}${r.decision_reason ? `<br><small class="muted">${escape(r.decision_reason)}</small>` : ''}</td>
        <td>${escape(time(r.created))}</td>
        <td>${['under_review', 'needs_info'].includes(r.status) ? `${r.status === 'under_review' ? `<button class="primary small" data-act="approve" data-id="${escape(r.id)}">Approve</button> ` : ''}<button class="secondary small" data-act="request-info" data-id="${escape(r.id)}">Ask info</button> <button class="secondary small" data-act="reject" data-id="${escape(r.id)}">Reject</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No applications yet.</p>'}
    </section>
    <section class="panel"><div class="panel-heading"><h2>Queued e-mails</h2></div>
      <p class="muted">Messages contain single-use links. If no e-mail provider is configured, deliver them yourself from here.</p>
      ${outbox.length ? `<ul>${outbox.slice(0, 20).map(m => `<li><strong>${escape(m.subject)}</strong> → ${escape(m.to_email)} <small class="muted">${escape(m.status)} · ${escape(time(m.created))}</small><details><summary>Show message</summary><pre style="white-space:pre-wrap">${escape(m.body)}</pre></details></li>`).join('')}</ul>` : '<p class="muted">Nothing queued.</p>'}
    </section>`;
  const bind = () => document.querySelectorAll('[data-act]').forEach(button => {
    button.onclick = async () => {
      const action = button.dataset.act;
      const body = action === 'approve' ? {} : { reason: window.prompt(action === 'reject' ? 'Reason for rejection (sent to the applicant):' : 'What information do you need?') };
      if (action !== 'approve' && !body.reason) return;
      button.disabled = true;
      try { await api(`/api/v2/platform/registrations/${button.dataset.id}/${action}`, { method: 'POST', body }); notify(action === 'approve' ? 'Approved. The invitation e-mail is queued.' : 'Saved.'); await refresh(); }
      catch (err) { notify(err.message); button.disabled = false; }
    };
  });
  return { html, bind };
}
