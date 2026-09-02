# Vision 360 — Mobile clickable prototype

A single-file, offline-capable clickable prototype of the Vision 360 field technician app.
Every screen from the accepted design board (`Vision 360 Mobile - standalone.html`) is
carried over verbatim and wired into a working app: real router, real navigation stack,
real transitions, plus the auth flow and app shell that the design board didn't cover.

**Live:** https://vision360-mobile.vercel.app · https://solomiyahavrylyshyn.github.io/Vision360---mobile/

It's an installable PWA — open the live link on a phone and use the browser's
**Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome). It then
launches full-screen with its own icon, no browser chrome, and keeps working
offline once opened.

**Deliverable:** [`Vision360-Mobile-Prototype.html`](Vision360-Mobile-Prototype.html) — a single
file, no install needed: open it in any browser, or drop it on any static host. No build
step, no server, no dependencies (fonts come from Google Fonts; everything else is
inline). This one is not the installable PWA — that's `dist/`, below — it's the
"send the whole app as one file" version.

Run the installable build locally:

```bash
node build.js
node server.js
```

It renders as the app itself — full-bleed, no device mockup, no presentation chrome — so it
reads the way the Flutter build should.

## What's inside

| | |
|---|---|
| Screens from the design board | 54 |
| Screens added here (auth + shell) | 9 |
| Wired tap targets | ~540 |
| Named flow actions | 18 |

### Added on top of the design board

* **Splash → Sign in** — company code, email, password with show/hide, "keep me signed in",
  inline validation, Face ID path. Any password of 6+ characters signs in.
* **Reset password → SMS code → New password** — 6-box OTP with auto-advance and a resend
  countdown, password strength meter, mismatch validation.
* **Chat** — conversation list with unread counts, and a thread you can actually type into.
* **Timesheet** — live clocked-in timer, week totals, per-day rows.
* **More** — profile, sync status, equipment/assets/price book, settings, log out.

### Stateful, not just linked

The prototype tracks where the job actually is, so the tabs resolve to the right screen:

* `est`: `none → draft → review → ready → approved` — the **Estimate** tab lands on the
  current stage, not always the empty state.
* `inv`: `none → sent → paid` — same for **Finance**.
* `onsite` — after **Start**, the Home tab shows the in-progress dashboard with the timer.

### Live interactions, not static images

* Segmented controls (Week/Month/Quarter/Year, Furnace/Condenser/Refrigerant,
  Good/Attention/Immediate, radio lists, month/quarter/week pickers) switch by swapping the
  design's own active and inactive styles — no hand-written second state.
* Catalog **Add / Added** pills toggle and move the "N items added / Subtotal" line.
* Qty steppers recalculate the line price and the section total.
* Report Card switches, checkboxes and the filter chips toggle.
* Bottom sheets render over the real screen underneath — dimming the status bar and tab
  bar, as the artboards show — instead of being separate flat screens.

## Getting around

* Tab bar, back arrows, close buttons and sheet scrims all work.
* `←` or `Backspace` — back.
* **Screen index**: press `/` on a keyboard, or triple-tap the status bar on a phone.
  It lists all 63 screens grouped by section and jumps straight to any of them. Hidden by
  default so the app reads as an app.

## Repo layout

```
src/shell.html      page skeleton, tab bar, and the 9 screens added here
src/app.css         app styling
src/app.js          router, wiring tables, interactions
src/screens.json         the 54 design screens, extracted from the design board
src/manifest.webmanifest PWA manifest — name, icons, standalone display
src/sw.js                service worker: precaches the shell, works offline
tools/make-icons.js      draws the icon set as real PNGs (pure Node, no deps)
build.js                 assembles everything into Vision360-Mobile-Prototype.html and dist/
server.js                zero-dependency static server for local runs (serves dist/)
```

Rebuild after editing anything under `src/`:

```bash
node build.js
```

That writes `Vision360-Mobile-Prototype.html` (the standalone file above) and a `dist/`
folder — `dist/` is git-ignored and rebuilt on every deploy, both on GitHub Pages (via
[`.github/workflows/pages.yml`](.github/workflows/pages.yml)) and on Vercel (via
[`vercel.json`](vercel.json)'s build command: `node build.js`, output directory `dist`).
`dist/` holds:

* `index.html` — the installable PWA (manifest + icons + service worker registration)
* `manifest.webmanifest`, `icons/*.png`, `sw.js`
* `artifact.html` — the same page with no `<head>`, for hosts that supply their own

### How the design screens are wired

`src/screens.json` holds each artboard's markup with the status bar and tab bar stripped
(those are now global chrome, so they stay put while screens change). `src/app.js` then
attaches behaviour by *finding* elements in that untouched markup rather than editing it:

* `'Save'` — element whose text is exactly that
* `'~This week'` — element whose own text nodes are exactly that (ignores child icons)
* `'@arrow_back'` — a Material icon by name
* `'@add^1'` — that icon's parent, i.e. the pill around it
* `'@expand_more#0'` — the first match

So the design markup is never hand-edited, and a re-export of the design board only needs
`screens.json` regenerated. Any selector that stops matching is reported in the console as
`[proto] unmatched selectors` — currently zero.
