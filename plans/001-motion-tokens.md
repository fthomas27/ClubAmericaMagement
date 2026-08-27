# 001 — Introduce easing and duration tokens

- **Status**: TODO
- **Commit**: 26c1b2f
- **Severity**: HIGH
- **Category**: Easing & duration / Cohesion & tokens
- **Estimated scope**: 1 file (`public/index.html`), ~20 lines added, ~6 lines changed

## Problem

The app has no motion tokens. Every curve is either a weak CSS built-in or a
hand-typed cubic-bezier, and three near-identical curves already exist.

Built-in `ease-out` is too weak for deliberate UI motion — it barely
differentiates from linear over a 200ms window:

```css
/* public/index.html:92 — current */
.ca-fade-in  { animation: ca-fade-in  0.22s ease-out both; }
/* public/index.html:102 — current */
.ca-slide-up { animation: ca-slide-up 0.22s ease-out backwards; }
/* public/index.html:104 — current */
.ca-slide-down { animation: ca-slide-down 0.16s ease-out backwards; }
```

And three separate hand-typed curves that nearly match each other:

```css
/* public/index.html:103 — current */
.ca-scale-in { animation: ca-scale-in 0.2s cubic-bezier(0.34, 1.15, 0.64, 1) backwards; }
/* public/index.html:124 — current */
.ca-hero-title { animation: ca-hero-title 0.9s cubic-bezier(0.22, 1, 0.36, 1) both; }
/* public/index.html:132 — current */
.ca-reveal { transition: opacity 0.6s ease-out, transform 0.6s cubic-bezier(0.22, 1, 0.36, 1); }
```

This matters because every later plan needs a shared vocabulary to reference.
Without tokens, each fix invents its own curve and the drift gets worse.

## Target

Add a token block at the top of the existing `<style>` element, then reference
the tokens from the existing rules. Exact values:

```css
/* target — add immediately after the `<style>` open tag, before the `body` rule */
:root {
  /* Curves */
  --ease-out:     cubic-bezier(0.23, 1, 0.32, 1);      /* entrances, exits, default */
  --ease-in-out:  cubic-bezier(0.77, 0, 0.175, 1);     /* movement across the screen */
  --ease-spring:  cubic-bezier(0.34, 1.15, 0.64, 1);   /* subtle overshoot — modals only */

  /* Durations */
  --dur-press:    140ms;  /* button press feedback */
  --dur-fast:     160ms;  /* dropdowns, small popovers */
  --dur-base:     220ms;  /* cards, panels, standard entrances */
  --dur-modal:    260ms;  /* modal + backdrop */
  --dur-reveal:   600ms;  /* homepage scroll reveals (marketing budget) */
}
```

Then rewrite the six rules above to consume them:

```css
/* target */
.ca-fade-in    { animation: ca-fade-in  var(--dur-base) var(--ease-out) both; }
.ca-slide-up   { animation: ca-slide-up var(--dur-base) var(--ease-out) backwards; }
.ca-scale-in   { animation: ca-scale-in var(--dur-modal) var(--ease-spring) backwards; }
.ca-slide-down { animation: ca-slide-down var(--dur-fast) var(--ease-out) backwards; }
.ca-hero-title { animation: ca-hero-title 0.9s var(--ease-out) both; }
.ca-reveal {
  opacity: 0; transform: translateY(22px);
  transition: opacity var(--dur-reveal) var(--ease-out),
              transform var(--dur-reveal) var(--ease-out);
}
```

Note `--ease-spring` keeps the existing `(0.34, 1.15, 0.64, 1)` value verbatim —
that gentle overshoot on modals is deliberate and stays. `.ca-hero-title` and
`.ca-reveal` both collapse onto `--ease-out`, which is a stronger curve than the
`(0.22, 1, 0.36, 1)` they used and reads as the same gesture.

## Repo conventions to follow

- All shared CSS lives in the single `<style>` element in `public/index.html`
  (lines 58–154). There is **no** separate stylesheet and no build step — do not
  create one.
- Custom classes are prefixed `ca-`. Keep that prefix; token names are new and
  use the `--ease-*` / `--dur-*` shape above.
- Tailwind is loaded via the Play CDN with a config block at `index.html:23–42`.
  Do **not** move these tokens into the Tailwind config — the CDN config is for
  colors and fonts only, and CSS custom properties are usable from both plain CSS
  and Tailwind arbitrary values (`duration-[var(--dur-fast)]`).
- Exemplar of a well-commented motion rule to imitate in tone:
  `public/index.html:93–101` (the `backwards` vs `both` explanation).

## Steps

1. In `public/index.html`, immediately after the `<style>` open tag on line 58
   and before the `body { … }` rule on line 59, insert the `:root { … }` block
   from **Target** above, with a short comment header
   (`/* ── Motion tokens ── */`).
2. Replace line 92 (`.ca-fade-in`) with the target version.
3. Replace line 102 (`.ca-slide-up`) with the target version. **Leave the
   comment block at lines 93–101 exactly as it is** — it explains the
   `backwards` keyword, which is unchanged.
4. Replace line 103 (`.ca-scale-in`) with the target version. Note the duration
   changes from `0.2s` to `var(--dur-modal)` (260ms) — modals are allowed
   200–500ms and the extra 60ms lets the overshoot read.
5. Replace line 104 (`.ca-slide-down`) with the target version.
6. Replace line 124 (`.ca-hero-title`) with the target version, keeping the
   `0.9s` literal (marketing hero, outside the token scale on purpose).
7. Replace lines 130–133 (`.ca-reveal`) with the target version.

## Boundaries

- Do NOT touch `public/app.js` in this plan. Tailwind utility classes are
  handled by plan 002.
- Do NOT change any `@keyframes` body — only the shorthand rules that reference
  them.
- Do NOT change the `@media (prefers-reduced-motion: reduce)` block at lines
  149–153; plan 003 owns it.
- Do NOT add dependencies or a build step.
- If the line numbers don't match what you find, locate the rules by selector
  name instead; if a selector is missing entirely, STOP and report.

## Verification

- **Mechanical**: no typecheck or build exists for this project. Run
  `node -e "const s=require('fs').readFileSync('public/index.html','utf8');
  const o=(s.match(/{/g)||[]).length, c=(s.match(/}/g)||[]).length;
  console.log(o===c ? 'braces balanced' : 'MISMATCH '+o+'/'+c)"` and expect
  `braces balanced`.
- Start the app with `npm start` and load `http://localhost:3000` — confirm no
  console errors and that the page renders styled (a malformed `<style>` block
  shows as unstyled dark-on-dark text).
- **Feel check**: open any modal (e.g. the confirm dialog rendered at
  `public/app.js:273`) and confirm:
  - The panel still scales up with a slight overshoot, now very slightly slower.
  - The login card at `public/app.js:465` fades and slides in with a snappier
    start than before — the motion should front-load, decelerating into place.
  - In DevTools → Animations, set playback speed to 10% and confirm the
    entrance curves decelerate hard at the end rather than moving evenly.
- **Done when**: no literal `cubic-bezier(` and no bare `ease-out` remain in the
  six rules listed in Steps; `grep -c "var(--ease-" public/index.html` returns
  at least 6.
