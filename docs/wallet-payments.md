# Student wallet and online payments

## How money moves

- Every student has a wallet. Printing in **wallet mode** first *holds* the job's price (available → reserved); when the job printed it is *charged* (reserved → institution revenue), a partly printed job is charged only for the pages that came out, and a job that never printed is released. See `server/wallet.js`; the ledger is append-only (database triggers refuse edits and deletes) and `GET /api/v2/edu/wallets/verify` recomputes every balance from it.
- Money gets into a wallet in two ways: an administrator adds it (cash at the counter, with a reason and an idempotency key), or the student pays **online** through the institution's **own Razorpay account**.

## Online top-ups: setup (institution administrator)

1. In your Razorpay dashboard create an API key pair (start with **test** keys) and a **webhook secret**.
2. In SmartPrint → Overview → *Online payments*, save the Key ID, key secret and webhook secret. They are stored encrypted with your institution's own key and are never shown again.
3. Copy the **webhook address** shown there into Razorpay (Settings → Webhooks) and subscribe it to `payment.captured`, `payment.failed` and `refund.processed`.
4. Tick *Students may add money online* in the printing policies and, to charge for printing, set *Student printing* to *charged from the student wallet*.
5. Live keys need an explicit confirmation that you are authorised to take real payments.

Students then see **Add money** on *My wallet*. Nothing is offered until steps 2 and 4 are done.

## Guarantees

- Money settles to the institution; it never passes through the platform.
- A payment credits the wallet **exactly once**, whether it arrives as the student's signed confirmation, Razorpay's webhook, a repeated webhook, or all of them at once (they share one ledger key: the payment id).
- Webhooks are verified with the institution's webhook secret over the raw body, deduplicated by event id, and a payment that matches no top-up (or the wrong amount/currency) is **never credited to a guessed account**: it becomes a reconciliation case (`Wallets → reconciliation`).
- **Refund to the original payment method:** the amount leaves the wallet first (so it cannot be spent meanwhile), then Razorpay is asked; if Razorpay refuses, the wallet is restored. Partial refunds are supported up to the amount of the top-up; money the student already spent cannot be refunded.

## What has and has not been verified

- Verified by automated tests against a **fake Razorpay server**: request signing and credentials, idempotent orders, signature checks, duplicate and simultaneous deliveries, orphan and mismatching payments, partial/over/failed refunds, secrecy of stored keys, role and tenant isolation.
- **Not verified against real Razorpay** (no keys were available). Before enabling live payments: run the whole flow in test mode with a real test key, then a small live payment and refund of your own.

## Before taking real student money (not engineering decisions)

A prepaid wallet is stored value. Confirm with a qualified adviser, for your institution and jurisdiction: whether closed-loop prepaid rules apply, GST/invoicing on printing and on top-ups, your refund and balance-expiry policy, how long to keep payment records, and the privacy notice and data-processing terms for student data. This software supports refunds, deletion and retention settings but does not decide these for you.
