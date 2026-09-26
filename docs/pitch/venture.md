# Open Venture case: Ghostkeys

For the Strato VC "Open Venture" bonus challenge: who has the problem, what the market is already telling us, how this is different from what exists, and what's next. (Founder-market fit isn't addressed here since it's about the specific people on the team, not the product; add that separately if the judges ask.)

## The problem

A MacBook has more surface area doing nothing than doing something: both palm rests, both speaker grilles, the strip above the keyboard, both edges, the lid. Anyone who wants more shortcuts than the keyboard gives them currently has two bad options: buy dedicated hardware (a Stream Deck starts around $150 and takes up desk space and a cable), or fight existing apps for whatever keyboard combinations aren't already taken. Neither is a real answer for someone who just wants "tap here, do that" on the machine they already own.

This isn't a niche complaint. It shows up for streamers who want a mute button without leaving frame, for anyone on video calls all day who wants one motion instead of a menu, and for people who have real difficulty reaching a keyboard shortcut reliably and want a bigger, more forgiving target than a key combo. The friction is real and it's been sitting there since these sensors first shipped in Apple silicon.

## Who pays

Individual MacBook owners buying for themselves, not an enterprise sale:

- **Power users and developers** who live in keyboard shortcuts already and want more of them without more fingers.
- **Streamers and creators** who need a control they can hit without looking, mid-take.
- **Students and professionals in constant video calls**, where "mute, unmute, screenshot, next slide" are all one tap away from being one motion instead of a hunt.
- **Anyone for whom a hidden, generously-sized tap zone is easier to hit reliably than a precise key combo.** This is a real accessibility angle, not a marketing one, and it's worth taking seriously on its own terms rather than as an afterthought.

This is a "prosumer" purchase (a serious hobbyist or power user buying for themselves, not a company buying for a team): one person decides, and pays once.

## Pricing

The full feature matrix and licensing model live in `docs/pricing/PRICING.md`; the tiers:

| Tier | Price | For |
| --- | --- | --- |
| Free | $0 | Both palm rests, tap/double/triple tap, 10 bindings, full calibration, browsing all 200+ presets |
| Pro | $29 one-time, with 12 months of updates (launch price $19 for the first 14 days) | Every surface and zone you draw, the full gesture grammar, per-app layers, macros, app integrations, sound mode, camera add-on, and the AI macro composer |
| Pro Student | $15 one-time, same as Pro | Verified students and teachers |
| Teams | $49 per seat per year, 3 seat minimum | Everything in Pro, plus IT deployment, the finance preset pack, and priority support |

After the first 12 months, Pro buyers keep whatever version they're on; another year of updates is $15, optional, or $59 once for updates forever. The first 1,000 buyers are "Founding" users: lifetime updates, a name in the credits, and a vote on the preset roadmap.

One-time, not a subscription, matches how Mac utility buyers already spend: BetterTouchTool and Keyboard Maestro both sell one-time licenses. Ghostkeys has no per-user server cost (detection, calibration, and actions all run on the laptop), so the one genuinely recurring cost is the optional AI macro composer, and that's the only thing metered: free and unlimited with your own model key, 100 credits included with Pro, then $5 per 500 credits that never expire.

## Market signal

The clearest signal is that this category is already proving itself out from underneath us: **MacTap**, a free app that does knock-counting for left/right taps only (no drawn zones, no per-zone classification, no gesture grammar beyond counting knocks), went viral in September 2026. *The specific reach and download numbers below are MacTap's own self-reported figures and need to be pulled fresh from their launch thread / Product Hunt page before this doc goes in front of anyone. Placeholder, not verified by us:*

> `[FILL IN: MacTap's self-reported download count / X (Twitter) impressions / Product Hunt ranking from their launch week, with a link to the source post.]`

Two other signals worth having on hand alongside that number:
- **Knock** already charges $1.99 for essentially the same two-zone knock-counting idea, and people pay it. That's proof that willingness to pay exists even at the simplest possible version of this feature.
- At least two more entrants (**spank**, a novelty single-gesture app, and **sonar.cool**, hand-wave gestures sensed a different way) have shown up in the same window. When four separate teams converge on "use the sensors already in the laptop as input" in the same month, that's a category forming, not a coincidence. And every one of them has shipped a much narrower version of the idea than what's in `docs/PROTOCOL.md` here.

## What the numbers could look like

These come straight from `docs/pricing/PRICING.md` and are labeled there, and here, as assumptions: nothing below has been through real app-store or checkout data yet.

- Downloads in the first 12 months, riding the MacTap wave: 200,000 (assumption)
- Finish calibration, the real "activated" number, not just a download: 100,000, an assumed 50 percent of downloads
- Buy Pro within 90 days: 4,000, an assumed 4 percent of activated users (freemium utilities typically land at 2 to 5 percent)
- Blended average price actually collected per Pro sale, once the $19 launch window, the $15 student price, and Founding-user pricing mix in: about $24. That's a blended average, not the sticker price; the sticker price is $29.
- Pro revenue: about $96,000 (4,000 sales times the ~$24 blended price)
- Teams: 25 teams of 10 seats at $49 per seat per year, about $12,000 per year
- Total, year one: about $108,000, against store fees near 7 percent and close to zero server cost (Lemon Squeezy is the store; the app itself runs entirely on the buyer's Mac)
- Update-renewal assumption for year two: about 30 percent of Pro buyers pay the optional $15 renewal

Worth being direct about which levers matter most: the 200,000-download figure and the 4 percent conversion rate move this outcome more than anything else here, and neither is proven. They're a reasonable starting assumption given MacTap's reach and typical freemium conversion rates, not a forecast to defend under pressure.

## Competition

| Product | Price | Zones / range | Sensing | What it's missing |
| --- | --- | --- | --- | --- |
| **Ghostkeys** | Free / $29 one-time (Pro), $19 at launch | User-drawn zones anywhere on the case, full gesture grammar, per-app layers | Motion sensor + gyro (learned per-user model), lid angle, light | N/A (our own product) |
| MacTap | Free | Left/right knock only, no drawn zones | Knock counting | Zone granularity, gesture range, per-app behavior |
| Knock | $1.99 | ~2 fixed zones | Knock counting | Same ceiling as MacTap, plus it's paid for less |
| spank | Free / novelty | 1 gesture | Single-purpose | Not a general input surface |
| sonar.cool | `[FILL IN: current price]` | Air gestures near the machine, not case taps | Hand-wave sensing | Different category (proximity, not touch); no zones at all |
| BetterTouchTool | `[FILL IN: current price]` | Trackpad/mouse/keyboard gesture remapping | Existing input hardware | Doesn't turn blank case surface into input at all |
| Stream Deck | $150+ hardware | Dedicated physical buttons | Physical switches | Extra hardware, desk space, a cable, no case-tap story |

The pattern across every direct competitor: they've all found the same insight (motion sensor on a MacBook can feel a tap) and stopped at "count knocks left or right." None of them classify *where* on the case a tap landed beyond a binary split, none of them have a gesture grammar past "tap" and "count," and none of them support per-app behavior or macros.

## Moat

- **Zone count, not zone binary.** Localizing a tap to more than left/right requires more than raw knock timing: it needs the gyro's twist signal and a model trained on that specific machine's resonance, which is why every competitor has stalled at two zones. That's the actual hard engineering problem in this category, and it's the one this project solved first.
- **A learned, per-user model instead of a fixed threshold.** Calibration means the false-positive rate (rejecting typing, trackpad use, and general handling) is tuned to *your* hands and *your* typing style, not a one-size-fits-all heuristic. That's the difference between a novelty and something people leave running all day.
- **A real gesture grammar.** Doubles, triples, sequences across two zones, a tap-then-double rhythm, lid nudges, tilts, and cover gestures, each with modifier-key support. This is an input system, not a single trigger.
- **Per-app layers and macros.** The same tap can mean something different in a video call versus a spreadsheet, and a single tap can run up to 50 chained steps. That's retention: once someone has five app-specific layers set up, switching away costs them real configuration.
- **A preset library as distribution.** 200+ presets (in progress) turn "draw your own zone" from a chore into a one-click install for the common cases, which matters enormously for anyone who isn't going to sit through a manual setup, and that's most people.
- **Open source, on a privacy-sensitive surface.** A background process that continuously reads a motion sensor is exactly the kind of tool people are right to be suspicious of. Being auditable, having a written safety contract (no `sudo`, no kernel extensions, no network access beyond a loopback socket, nothing written outside one config folder), and being able to point at the actual source is a trust advantage a closed competitor can't easily match.
- **Timing.** The category is proven and hot right now because of MacTap's launch, and the field hasn't converged on a materially better version of the idea yet. Moving while that attention is live is worth more than moving after it cools.

## Next 3 to 6 months

- Ship 1.0: finish the renderer UI (onboarding, zone editor, live laptop map, HUD), the preset library, and a notarized installer (Apple's automated check that lets an app open without a security warning). Everything past the daemon core is currently in progress.
- Wire the optional sound mode (telling a fingertip tap from a knuckle or nail tap by its sound) and the camera add-on for Macs with Desk View into the running daemon as Pro-tier differentiators; both already exist as their own tested libraries and just need to be hooked into the live action pipeline.
- Distribution push timed to the open category window: Product Hunt, Hacker News, r/macapps, and campus-level word of mouth starting from this weekend's validation conversations.
- Take the accessibility angle seriously as its own track, not a footnote: talk to disability services or accessible-computing groups about whether generously-sized, user-placed tap zones solve a real reachability problem better than existing switch-access tools.
- Use real calibration data (with explicit consent, kept local per the existing privacy model) to shrink the default calibration time and ship better cross-user starting models, so the free tier's first-run experience gets faster without weakening the privacy stance.
- Build one or two vertical preset packs (video editing, presenting, developer workflows) so the value of Pro is obvious in the first five minutes, not after a user builds their own layers from scratch.
