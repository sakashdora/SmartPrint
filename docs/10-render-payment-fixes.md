# Render and direct UPI printing

The live service is https://smartprint-ieks.onrender.com/. On 24 October 2026 its health endpoint reported production mode with gateway payments disabled.

Customer checkout uses each shop's own UPI ID and QR, or cash. No Razorpay setup is required. UPI is selected by default when the shop has saved its payment details under UPI payments. The payee and amount are included in the order's QR and UPI app link.

A QR starts payment but does not give the server trusted bank confirmation. Customer references and screenshots do not mark orders paid. The owner checks the bank credit and confirms the reference once; the paired printer connector then claims the paid job automatically. No additional print acceptance is needed.

Fully unattended printing requires a trusted payment-status API or webhook from the shop's bank or merchant provider. Availability and charges must be confirmed with that provider. SmartPrint adds no payment gateway fee for direct UPI; bank/provider charges follow their terms.

The updates also separate shop registration, owner sign-in and administrator sign-in, and prevent retrying a print while output may still be running. Keep the Windows connector running with a compatible printer. Physical output confirmation remains separate from payment verification.

Deploy the updated source to the existing Render service and confirm npm run build succeeds. Preserve database and encryption settings. No schema migration is required. Changes have not yet been deployed by this chat.

Verification: npm run build and npm test. Tests cover direct UPI reference verification, tenant isolation, paid printer leases and duplicate-output protection. Live bank receipt and physical printing still require validation.
