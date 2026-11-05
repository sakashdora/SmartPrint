# SmartPrint agent v3

The agent is the program on a Windows PC that has printers attached. It talks to `/api/agent/v2` and prints institution jobs. It is separate from the older shop connector (`connector/`), which keeps working unchanged for Business shops; the two use different folders (`%LOCALAPPDATA%\SmartPrintAgent` vs `SmartPrintConnector`) and different server protocols.

## Install and run

1. In SmartPrint, open **Agents → Add agent** and copy the enrolment code (valid 15 minutes, works once).
2. On the printer PC (Node.js 24 installed, repository checked out):
   ```powershell
   node agent/index.js enroll --url https://your-smartprint-server --code THE-CODE
   .\scripts\install-agent-task.ps1 -Portal 17640   # start at every sign-in, restart if it stops (omit -Portal for no outage page)
   ```
   Or run it by hand: `node agent/launcher.js` (keeps it running and handles updates) or `node agent/index.js run`.
3. Printers appear under **Printers** with the capabilities Windows reports. A printer whose driver cannot answer stays *unknown*: it never receives a colour or two-sided job until an administrator sets it. A printer Windows reports as *Offline* is never offered work.
4. `node agent/index.js status` shows enrolment and any unfinished jobs. `.\scripts\install-agent-task.ps1 -Remove` uninstalls the task.

The task runs the launcher as **you** (no administrator needed), because the agent's credential is protected with Windows DPAPI for your user. It does not touch the older shop connector.

## Updates (signed)

The agent installs a new version only if the release manifest is signed with the private key whose public half ships in `agent/update-public-key.pem`, and the downloaded package matches the signed SHA-256 and size. A hijacked server, bucket or link cannot make an agent run foreign code; equal or older versions are refused.

- **One-time setup (you):** `node scripts/sign-agent-release.mjs --init --key C:\securegent-signing.pem` creates the key pair (keep the private key secret and backed up; commit only `agent/update-public-key.pem`). Until that public key is committed and agents are updated to include it, **updates are switched off**.
- **Publishing a release:** build a `.tgz` containing an `agent/` folder, upload it somewhere reachable over HTTPS, then `node scripts/sign-agent-release.mjs --package agent-3.1.0.tgz --version 3.1.0 --url https://.../agent-3.1.0.tgz --key C:\securegent-signing.pem --out agent-release.json`, and set `AGENT_RELEASE_FILE` on the server to that file.
- **What the agent does:** when idle (never mid-job) it verifies, unpacks the release beside the current one, exits with code 75, and the launcher starts the new version. The new version is *unconfirmed* until it reaches the server; if it does not within 2 minutes the launcher goes back to the previous version and deletes the bad one.
- A code-signing certificate for Windows (to avoid SmartScreen warnings on a packaged `.exe`) is a separate, optional step and is not needed for this source-based install.

## What it guarantees

- **Never prints a job twice.** For every job: download (checksum verified, stored encrypted) → journal `about_to_submit` → server accepts `submitted` → only then the printer. After a crash: before the server accepted, it asks again (and drops the job if the lease was lost); after it accepted, it never reprints and reports the job as *uncertain* for a person to decide.
- **No result is lost.** Outcomes wait in a local outbox until the server is reachable and are delivered in order.
- **Secrets are not stored in plain text.** The credential and the cache key are protected with Windows DPAPI (bound to the Windows user). Documents are cached encrypted and written in clear only while printing.
- **One installation per credential.** A second machine using the same credential is refused; a revoked agent stops immediately and keeps its journal.
- **Credential rotation** every 30 days (the old one works for 24 more hours).
- **Pages printed are reported** (from the Windows queue) so partial prints can be charged and handled correctly.

## Outage printing page (LAN portal)

`node agent/index.js run --portal 17640` also serves a small web page on the campus network (`http://<this PC>:17640`). It exists for outages only:

- It **accepts work only while the agent cannot reach the server**. While the internet works it tells people to use the website, so the normal queue, wallet and audit trail are never bypassed.
- **Students** enter their ID and the PIN they chose when reserving money (Wallet → reserve for offline use at this print point). The cost comes out of that reservation and never exceeds it.
- **Staff** enter their ID and the offline PIN they set while online (`PUT /api/v2/edu/me/offline-pin`); no charge, limited to a daily number of pages (policy `offlineStaffDailyPages`).
- Five wrong PINs lock the ID until the agent is back online. Everything is written to the numbered local log and applied by the server once, when the connection returns.
- Colour goes only to a colour printer; a printer Windows reports as Offline is never chosen; a job that did not print is not charged, and a partly printed one is charged only for the pages that came out.
- **The page is plain HTTP on the local network, so the PIN crosses that network unencrypted.** Use it on a trusted network or behind a TLS proxy. The page needs no internet; the file is processed on the agent PC.
- It has been tested over real HTTP with a simulated printer, not yet with a real printer in an outage.

## Not included yet

- A packaged single-file `.exe` installer (the agent currently runs from the repository with Node).
- Running as a true Windows *service* (the scheduled task covers start-at-sign-in and restart; a service would also run with nobody signed in, but then DPAPI would need machine scope).

## Tested on real hardware (2026-11-05)

On this PC (HP laptop; Brother DCP-T820DW and HP LaserJet 1020), against a throwaway local server, never production:
- Enrolment, **real DPAPI vault**, and printer discovery: the Brother (USB copy) reported colour + two-sided, its network copy reported *Offline*, and the HP reported mono + simplex (driver-verified).
- **The HP was not detected on USB** (powered off / unplugged) although Windows said "Normal". The agent waited 90 s, saw the spooler job make no progress, removed it from the Windows queue, reported a clean failure, and left no document behind: no surprise print later.
- **One black-and-white test page on the Brother completed**: the job ended *completed*, pages printed = 1 (from the Windows queue), journal, encrypted cache and outbox empty afterwards.
- Finding fixed: an Offline printer used to stay routable; it no longer does.
- **Agent killed mid-print (second session):** the process was killed the moment the server showed the job as *submitted*. After restart the journal said "submitted", the agent started **no print**, and the job became *uncertain* for a person to resolve. (Whether a page had already left the printer at the moment of the kill is exactly the case this state exists for.)
- **Real outage:** with the server stopped, the agent's outage page said the internet was down, refused a wrong PIN (no print), and printed one page on the Brother for the right PIN, charging ₹3 from a ₹15 reservation. When the server returned, one spend was applied (no repeat), and the wallet ledger check reported no problems.
Still to do with a person present: unplugging the USB cable mid-job (step 5 below), and the colour and two-sided paths on real paper.

## Real-printer test plan (needs a person at the printer)

1. Enrol the agent on a PC with one USB printer; confirm the printer and its colour/duplex answers on the Printers screen.
2. **Test page** from the Printers screen → one page prints; job shows *Printed* with pages = 1.
3. Staff job of 3 pages, 2 copies → 6 sheets, job completes, no document left in `%LOCALAPPDATA%\SmartPrintAgent\cache`.
4. Colour job with only a mono printer enrolled → refused at submit with a clear message.
5. Unplug USB mid-job → job ends *uncertain* (never silently retried); operator resolves it with the page count.
6. Kill the agent process mid-print → after restart nothing prints again; the job is *uncertain*.
7. Disconnect the network after printing starts → on reconnect the result arrives and the job completes.
