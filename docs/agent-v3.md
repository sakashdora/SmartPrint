# SmartPrint agent v3

The agent is the program on a Windows PC that has printers attached. It talks to `/api/agent/v2` and prints institution jobs. It is separate from the older shop connector (`connector/`), which keeps working unchanged for Business shops; the two use different folders (`%LOCALAPPDATA%\SmartPrintAgent` vs `SmartPrintConnector`) and different server protocols.

## Install and run

1. In SmartPrint, open **Agents → Add agent** and copy the enrolment code (valid 15 minutes, works once).
2. On the printer PC (Node.js 24 installed, repository checked out):
   ```powershell
   node agent/index.js enroll --url https://your-smartprint-server --code THE-CODE
   node agent/index.js run
   ```
3. Printers appear under **Printers** with the capabilities Windows reports. A printer whose driver cannot answer stays *unknown*: it never receives a colour or two-sided job until an administrator sets it.
4. `node agent/index.js status` shows enrolment and any unfinished jobs.

To start at logon, create a Task Scheduler task that runs `node agent/index.js run` for the signed-in user (the credential is protected for that Windows user).

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

- Running as a Windows *service* and a **signed auto-updater**. The server already tells an outdated agent to update (`updateRequired`) but nothing installs updates. Both need a code-signing certificate and a distribution channel.
- **Real-printer validation.** The Windows driver reuses the shop connector's proven SumatraPDF/spooler code, but the v3 agent has only been tested with a simulated printer and with the job-tracking logic on recorded queue states. Before relying on it, run the test plan below with paper.

## Real-printer test plan (needs a person at the printer)

1. Enrol the agent on a PC with one USB printer; confirm the printer and its colour/duplex answers on the Printers screen.
2. **Test page** from the Printers screen → one page prints; job shows *Printed* with pages = 1.
3. Staff job of 3 pages, 2 copies → 6 sheets, job completes, no document left in `%LOCALAPPDATA%\SmartPrintAgent\cache`.
4. Colour job with only a mono printer enrolled → refused at submit with a clear message.
5. Unplug USB mid-job → job ends *uncertain* (never silently retried); operator resolves it with the page count.
6. Kill the agent process mid-print → after restart nothing prints again; the job is *uncertain*.
7. Disconnect the network after printing starts → on reconnect the result arrives and the job completes.
