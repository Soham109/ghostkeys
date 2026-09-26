# Ghostkeys pricing

This replaces the $24 Pro line in `docs/pitch/venture.md`. The same matrix, machine-readable, is `features.json` in this folder.

## 1. Tiers

| Tier | Price | For |
| --- | --- | --- |
| **Free** | $0 | Anyone who saw a tap demo |
| **Pro** | $29 once, 12 months of updates | Power users, creators, people on calls all day |
| **Pro Student** | $15 once, same as Pro | Verified students and teachers |
| **Teams** | $49 per seat per year, 3 seat minimum | Finance, consulting, IT-managed fleets |

- **Free beats MacTap on its own turf:** both palm rests, tap, double and triple tap, 10 bindings, everyday actions, full calibration, and browsing all 200+ presets. MacTap stops at counting left or right knocks.
- **Pro is yours forever.** After 12 months you keep your last version. Another year of updates is $15, optional. Checkout also offers lifetime updates for $59.
- **Teams** adds IT management, the finance preset pack and support. 20 percent off from 25 seats.

**Launch offer:** Pro is **$19** for the first 14 days. **Founding users**, the first 1,000 buyers, also get lifetime updates, their name in the credits and a vote on the preset roadmap.

**One-time, not subscription.** Mac utility buyers dislike subscriptions; BetterTouchTool and Keyboard Maestro sell one-time licenses. Ghostkeys has no per-user server cost: detection, calibration and actions run on the laptop. The one recurring cost is the AI composer, so only that is metered: free and unlimited with your own model key, 100 credits included with Pro (one credit is one composed macro), then $5 per 500 credits that never expire. Teams is yearly because companies budget yearly and expect support with it.

## 2. Feature matrix

Blank means not included. Beta means shipped but still improving. Soon means not shipped.

| Feature | Free | Pro | Teams |
| --- | --- | --- | --- |
| **Surfaces** | | | |
| Left and right palm rests | Yes | Yes | Yes |
| Speaker grilles, top strip, edges, lid | | Yes | Yes |
| Zones you draw yourself | | Yes | Yes |
| Light sensor (cover it with a hand) | | Yes | Yes |
| Air above the keyboard (camera, M4 and M5, Beta) | | Yes | Yes |
| **Gestures** | | | |
| Tap, double tap, triple tap | Yes | Yes | Yes |
| Sequence across two zones, rhythm (tap, pause, double) | | Yes | Yes |
| Modifier plus tap (hold Shift, Command and so on) | | Yes | Yes |
| Lid nudge, tilt left or right, cover, cover and hold | | Yes | Yes |
| Sound: knuckle vs fingertip, rubs, hand wave (Beta) | | Yes | Yes |
| Air: pinch, pinch drag, palm swipe (Beta) | | Yes | Yes |
| **Detection** | | | |
| Calibration to your hands (about 3 minutes) | Yes | Yes | Yes |
| Ignores typing, trackpad use and bumps | Yes | Yes | Yes |
| Sensitivity controls, per-zone accuracy report | Yes | Yes | Yes |
| **Actions** | | | |
| Keystroke, text, clipboard, open app or URL | Yes | Yes | Yes |
| Volume, mute, media, brightness | Yes | Yes | Yes |
| Window, app and system controls | Yes | Yes | Yes |
| Shell, AppleScript, Shortcuts | | Yes | Yes, IT can block |
| Macros up to 50 steps | | Yes | Yes |
| **Integrations** | | | |
| Excel formula tools | | Yes | Yes |
| Browser tabs, Music and Spotify, Finder | | Yes | Yes |
| Slides (PowerPoint, Keynote), Zoom and Meet | | Yes | Yes |
| **Intelligence** | | | |
| AI macro composer with your own key | | Yes | Yes |
| Included composer credits | | 100 | 300 per seat monthly |
| **Customization** | | | |
| Bindings | 10 | Unlimited | Unlimited |
| Per-app layers | | Yes | Yes |
| Presets (200+) | Browse all, install palm ones | All | All |
| Saved layouts, import and export | | Yes | Yes |
| HUD (on-screen confirmation) | Yes | Restyle | Restyle |
| Finance preset pack, shared team layouts | | | Yes |
| **Privacy** | | | |
| No network, telemetry or account; never reads typing | Yes | Yes | Yes |
| Offline license check | Yes | Yes | Yes |
| Managed IT profile | | | Yes |
| **Platforms** | | | |
| macOS on Apple silicon | Yes | Yes | Yes |
| Windows, same license (Soon) | Soon | Soon | Soon |
| CLI, SDK, Raycast extension | Yes | Yes | Yes |
| Seat management, invoices, priority support | | | Yes |

## 3. Why these prices

Marked verified: re-read on the vendor site on 26 Sep 2026. Others come from earlier research.

- **MacTap (free), Knock ($1.99), Haptyk ($8):** simple tap-trigger apps. Free matches them; Pro is a bigger product, so it prices above.
- **BetterTouchTool ($15, or $25 lifetime; verified):** what Mac power users already pay. $29 sits just above because Ghostkeys adds new input surface instead of remapping old input. Our $59 lifetime is about twice theirs.
- **Keyboard Maestro ($36, $25 upgrade; verified):** Ghostkeys is a trigger layer for tools like it. Under $36 keeps Pro an easy second purchase.
- **Raycast Pro ($10 monthly, $96 yearly; verified):** Pro costs less than three months of it, once.
- **Stream Deck MK.2 ($149.99), MX Creative Console ($199.99):** hardware buttons. Pro is a fifth of the price with nothing on the desk.
- **LightningXL ($50 yearly; verified), Macabacus ($200 to $360 per user yearly):** finance teams already pay per seat yearly for Excel speed. Teams at $49 matches LightningXL and is far under Macabacus.

**Willingness to pay:** an impulse Mac utility tops out near $30. Free is the trial: once a palm rest does Play/Pause, buying Pro is about more zones, not belief.

**Assumptions, not yet measured:** 50 percent of downloads finish calibration; 4 percent of those buy Pro within 90 days (freemium utilities usually land at 2 to 5 percent); blended Pro price about $24 after launch, student and founding sales; 30 percent renew updates in year two.

## 4. Licensing

**Store: Lemon Squeezy.** It is the merchant of record (it collects sales tax and VAT) and has license keys and discount codes built in. Paddle, which BetterTouchTool uses, is the fallback with the same design.

**Activation:**
1. After purchase, a small webhook we run turns the store's key into a **signed license file** (name, email, tier, updates-until date).
2. The user pastes the key, and the app makes **one** request to fetch the file. Or they drop in the file from the receipt email: **zero** requests.
3. From then on the app checks the signature against a public key built into the app. No check-ins, ever, so the no-network promise holds.
4. One personal license covers every computer the buyer personally uses.

**Refunds:** 30 days, no questions. Refunded licenses go on a revocation list shipped inside the next app update, so still no network.

**Upgrades:** Free to Pro in the app, no reinstall. Renew updates for $15 at any time. Student licenses stay valid after graduation. Pro buyers moving to Teams get their Pro price credited.

**Education:** a code sent to a school email address, or a student or staff ID reviewed by hand.

**Teams IT profile:** a macOS configuration profile pushed by the company's device management system. It installs the license, locks shared layouts, and can switch off scripts and composer network access.

## 5. Website copy

**Headline:** Your laptop already has more buttons. Pay once to use them all.

**Subhead:** Free forever for the basics. No subscription for Pro. Everything runs on your Mac.

**Free, $0.** Two hidden buttons on your palm rests, free forever.
- Tap, double tap and triple tap on either palm rest
- 10 bindings: volume, media, apps, windows, keystrokes
- Tuned to your hands in about 3 minutes

**Pro, $29 once.** Every surface, every gesture, every action.
- Grilles, top strip, edges, lid, light sensor, or zones you draw
- Sequences, rhythms, modifiers, lid nudge, tilt, cover
- Macros, scripts, Shortcuts and per-app layers
- Excel, browser, music, Finder, slides and Zoom controls
- Sound mode, camera add-on and AI macro composer

**Teams, $49 per seat per year.** Pro for the whole desk, managed by IT.
- Everything in Pro, plus the finance preset pack
- Deploy and lock settings through device management
- Invoices, seat management and priority support

**FAQ**
- **Is Free really free?** Yes. No trial clock, no account.
- **Is Pro a subscription?** No. Pay once, keep it. More updates later are optional.
- **Does the license phone home?** No. It is a signed file checked on your Mac. Activation makes at most one request.
- **What if it does not work well on my Mac?** Try Free first. Refunds within 30 days, no questions.
- **Do I need an AI subscription?** No. The composer includes 100 credits, works with your own key, and more are $5 for 500.
- **Is there a student price?** Yes, $15 with a school email or ID.

## 6. Open Venture numbers

All assumptions, first 12 months: 200,000 downloads riding the MacTap wave; 100,000 finish calibration; 4,000 Pro sales at about $24 is **about $96,000**; 25 Teams of 10 seats at $49 is **about $12,000** yearly. Total **about $108,000** with store fees near 7 percent and close to zero server cost.
