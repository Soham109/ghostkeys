/** Website copy for the tiers, from docs/pricing/PRICING.md section 5. Prices and flags come from content/features.json. */
export const PRICING_COPY = {
  headline: ["Your laptop already has more buttons.", "Pay once to use them"],
  headlineSerif: "all.",
  sub: "Free forever for the basics. No subscription for Pro. Everything runs on your Mac.",
  bullets: {
    free: ["Tap, double tap and triple tap on either palm rest", "10 bindings: volume, media, apps, windows, keystrokes", "Tuned to your hands in about 3 minutes"],
    pro: [
      "Grilles, top strip, edges, lid, light sensor, or zones you draw",
      "Sequences, rhythms, modifiers, lid nudge, tilt, cover",
      "Macros, scripts, Shortcuts and per-app layers",
      "Excel, browser, music, Finder, slides and Zoom controls",
      "Sound mode, camera add-on and AI macro composer",
    ],
    teams: ["Everything in Pro, plus the finance preset pack", "Deploy and lock settings through device management", "Invoices, seat management and priority support"],
  } as Record<string, string[]>,
  faq: [
    { q: "Is Free really free?", a: "Yes. No trial clock, no account." },
    { q: "Is Pro a subscription?", a: "No. Pay once, keep it. More updates later are optional." },
    { q: "Does the license phone home?", a: "No. It is a signed file checked on your Mac. Activation makes at most one request." },
    { q: "What if it does not work well on my Mac?", a: "Try Free first. Refunds within 30 days, no questions." },
    { q: "Do I need an AI subscription?", a: "No. The composer includes 100 credits, works with your own key, and more are $5 for 500." },
    { q: "Is there a student price?", a: "Yes, $15 with a school email or ID." },
  ],
};
