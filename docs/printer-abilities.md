# Printer abilities: colour, black & white, one-sided, two-sided

A printer is either **Black & white only** or **Colour**, and either **One-sided only** or **Two-sided (automatic)**.
Customers, students and staff are only offered, and only routed to, what the printers can really do.

## Who decides

The person who connects the printer decides. Detection only pre-fills the choice, because Windows drivers sometimes
claim colour or duplex that the printer does not have (an HP LaserJet 1020 claims both; a manual-duplex laser claims
two-sided).

| | Shop owner (Business) | College administrator (Education) |
|---|---|---|
| When adding a printer | The *Printers on this PC* card shows two selects (Prints, Sides), pre-filled from the driver. What is shown when you press **Connect** is saved as your choice | The agent reports the printer; if the driver could not say, the printer shows *Not detected: choose* |
| Changing later | The same two selects on each connected printer; saved on change | Colour and Two-sided selects in the Printers tab; saved on change |
| Does a later scan overwrite it? | No. A choice made by the owner is kept (`devices.cap_source = 'manual'`) | No. A choice made by the administrator is kept (`printers.cap_source = 'admin'`) |
| Go back to detection | **Use detected** link (`PATCH /api/owner/devices/:id {useDetected:true}`) | **use detected** link (`PATCH /api/v2/edu/printers/:id {useDetected:true}`) |

## What follows from the choice

* **QR / order page (Business).** `GET /api/shops/:slug` returns `colorAvailable`, `duplexAvailable` and `printerCount`.
  When the shop has printers but none does colour, the Colour option is greyed out with "This shop prints in black &
  white only"; likewise "This shop prints one-sided only". A printer that is merely offline does not hide an option.
* **Routing.** A colour job is only sent to a colour printer and a two-sided job only to a two-sided one. A job nobody
  can do is refused before payment with a clear message instead of failing at the printer. Black & white and one-sided
  jobs run on any printer.
* **Unknown.** A printer whose abilities are unknown is treated as black & white, one-sided until someone chooses.

## API

* `PATCH /api/owner/devices/:id` body `{ color?: boolean, duplex?: boolean }` or `{ useDetected: true }`
* `POST /api/owner/printers/autoconnect` body `{ name, color, duplex, manual: true }`
* `PATCH /api/v2/edu/printers/:id` body `{ capColor?, capDuplex? }` or `{ useDetected: true }`

Tests: `test/printer-abilities.test.js` (shop owner), `test/printer-abilities-college.test.js` (college).
