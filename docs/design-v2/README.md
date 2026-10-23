# SmartPrint — premium interface concepts

23 October 2026. These image mockups preceded the approved visual redesign. Their fictional sample data remains illustrative. The design is now implemented in the application; see [current page specification](../05-page-designs.md) and [actual screenshots](../screenshots/premium/). API-backed totals and available destinations replace illustrative metrics and links.

## Screens

| Screen | Focus | Image |
| --- | --- | --- |
| Customer desktop | Large document preview, clear print choices and visible price | [Open mockup](customer-desktop.png) |
| Customer mobile | Image preview, crop and enhance controls, accessible checkout | [Open mockup](customer-mobile.png) |
| Shop owner | Print queue, manual payment verification and printer status | [Open mockup](shop-owner-desktop.png) |
| Platform admin | Shop approval, service status and recent activity | [Open mockup](admin-desktop.png) |

## Design direction

Use white and soft neutral surfaces, dark text and a restrained blue accent. Prefer clear headings, generous space, thin borders and small consistent outline icons. Keep the customer focused on their document and the next step; make queues and review actions the centre of operational pages.

Suggested implementation tokens: background #F7F8FA, surface #FFFFFF, text #111827, secondary text #526072, border #E2E6EC, primary #1558C0. Validate actual text/background combinations for accessibility in the implemented interface. Use a system sans-serif font stack, 8px spacing increments, 8px standard corner radii and at least 44px touch targets. Images are visual references; implementation must use semantic HTML, keyboard focus states and responsive layouts.

## Implementation notes

- Keep real document previews and server-computed prices. Never replace operational content with sample data from these images.
- Use one consistent existing brand mark across every screen; generated illustrations vary slightly between mockups.
- On mobile, expose Crop only once in the editing toolbar. Use an ordinary adjustments icon for Enhance. Keep the bottom action accessible without obscuring content, including when the keyboard is open.
- Sidebars collapse into an accessible navigation menu on narrow screens. Tables become readable order summaries without losing status or available actions.
- A customer-submitted UPI reference requires shop verification of actual bank credit. Print submission and confirmed physical output remain separate states.
- Illustrative service metrics and additional navigation destinations need corresponding authorized API data and functioning routes before shipping. They are not evidence of implemented features.
- Include empty, loading, offline, failure and permission states during implementation. Reconcile displayed record counts with real filtered data.
- File deletion copy must match confirmed-print deletion and configured expiry behaviour. Transaction records remain available.

Created with the built-in image-generation tool. [Exact prompt set](prompts.md).
