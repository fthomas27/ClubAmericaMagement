# 003 — Close the `prefers-reduced-motion` coverage gap

- **Status**: TODO
- **Commit**: 26c1b2f
- **Severity**: HIGH
- **Category**: Accessibility
- **Estimated scope**: 1 file (`public/index.html`), ~25 lines added

## Problem

A reduced-motion block exists, but it covers only five ambient/decorative
classes. Every **entrance** animation in the app, and all Tailwind
transform-based motion, is exempt from it:

```css
/* public/index.html:149–153 — current, the entire reduced-motion policy */
@media (prefers-reduced-motion: reduce) {
  .ca-star-twinkle, .ca-scroll-cue, .ca-pulse { animation: none; }
  .ca-reveal { opacity: 1; transform: none; transition: none; }
  .ca-card3d { transform: none !important; transition: none; }
}
```

Not covered:

- `.ca-fade-in` (`index.html:92`), `.ca-slide-up` (`:102`),
  `.ca-scale-in` (`:103`), `.ca-slide-down` (`:104`), `.ca-hero-title` (`:124`)
  — these run on every modal, login card, form panel and dropdown in the app.
  `.ca-slide-up` and `.ca-hero-title` translate; `.ca-scale-in` scales.
- Every Tailwind `hover:-translate-y-*`, `active:scale-*` and `hover:scale-*` in
  `public/app.js` (31 sites total).

A user who has asked their OS to reduce motion still gets a scaling modal on
every dialog and a lifting card on every hover. The JS-driven motion is handled
correctly already (`public/app.js:4458` and `:13331` both check the media
query), which makes the CSS gap the only remaining exposure.

Per the accessibility bar, reduced motion means **fewer and gentler**
animations, not zero — opacity transitions aid comprehension and should survive;
position and scale changes should not.

## Target

Replace the block at lines 149–153 with one that keeps opacity feedback and
removes movement:

```css
/* target */
@media (prefers-reduced-motion: reduce) {
  /* Ambient motion: off entirely. */
  .ca-star-twinkle, .ca-scroll-cue, .ca-pulse { animation: none; }
  .ca-card3d { transform: none !important; transition: none; }

  /* Entrances: keep the fade, drop the movement. A 1ms-delayed opacity-only
     animation preserves the "appears" beat without any translate or scale. */
  .ca-slide-up,
  .ca-slide-down,
  .ca-scale-in,
  .ca-hero-title {
    animation-name: ca-fade-in;
    animation-duration: var(--dur-fast);
    animation-timing-function: var(--ease-out);
  }

  /* Scroll reveals: show immediately, no travel. */
  .ca-reveal { opacity: 1; transform: none; transition: none; }

  /* Tailwind transform utilities across app.js: neutralize movement, keep
     color/shadow/opacity feedback so buttons and cards still respond. */
  [class*="hover:-translate-y"]:hover,
  [class*="hover:translate-y"]:hover,
  [class*="hover:scale-"]:hover,
  [class*="active:scale-"]:active {
    transform: none !important;
  }
}
```

The entrance rules work by **re-pointing** the four moving animations at the
existing `ca-fade-in` keyframe, which only touches `opacity`. The keyframe
already exists at `index.html:69–72`; no new keyframes are needed.

## Repo conventions to follow

- All CSS lives in the single `<style>` element in `public/index.html`
  (lines 58–154). No separate stylesheet, no build step.
- This plan **depends on plan 001** for `var(--dur-fast)` and `var(--ease-out)`.
  If plan 001 has not been applied, substitute the literals `160ms` and
  `cubic-bezier(0.23, 1, 0.32, 1)` respectively and note the substitution in
  your report.
- Custom classes use the `ca-` prefix. The attribute selectors above deliberately
  target Tailwind's generated classes instead, because those class names live in
  `public/app.js` and cannot be centrally renamed.
- Exemplar of correct reduced-motion handling already in this repo:
  `public/app.js:4456–4459` (`TiltScene` bails out on both
  `prefers-reduced-motion: reduce` and `hover: none`).

## Steps

1. In `public/index.html`, replace lines 149–153 in their entirety with the
   `@media (prefers-reduced-motion: reduce)` block from **Target** above.
2. Keep the block in its current position — last inside the `<style>` element,
   after `.ca-stripes`. Source order matters for the `!important`-free
   `animation-name` overrides to win over the base rules at lines 92–105.
3. Do not add `transition: none` globally. Color, border and shadow transitions
   are comprehension aids and must keep working.

## Boundaries

- Do NOT touch `public/app.js`. The attribute selectors are specifically chosen
  so that no JSX has to change.
- Do NOT add `motion-reduce:` Tailwind variants to `app.js` — that would mean
  editing 31 class strings, and the Play CDN generates those variants at runtime,
  making the change harder to verify.
- Do NOT set `animation: none` on the entrance classes — that removes the fade
  as well, which over-corrects. Re-point them at `ca-fade-in` as specified.
- Do NOT change the `@keyframes` definitions at lines 69–128.
- Do NOT add dependencies.
- If lines 149–153 do not contain the current block shown under **Problem**,
  STOP and report.

## Verification

- **Mechanical**: `node -e "const s=require('fs').readFileSync('public/index.html','utf8');
  const o=(s.match(/{/g)||[]).length, c=(s.match(/}/g)||[]).length;
  console.log(o===c ? 'braces balanced' : 'MISMATCH '+o+'/'+c)"` → expect
  `braces balanced`.
- **Feel check**: run `npm start`, open `http://localhost:3000`, then in DevTools
  → Rendering → "Emulate CSS media feature prefers-reduced-motion" set to
  `reduce`, and confirm:
  - Opening a modal (the confirm dialog at `public/app.js:273`) **fades in
    without scaling** — no size change at all.
  - The notification dropdown (`public/app.js:10339`) fades without sliding.
  - Hovering a roster card (`public/app.js:4308`) still changes its border and
    shadow but **does not lift**.
  - Pressing any `Btn` (`public/app.js:189`) still dims/recolors but **does not
    shrink**.
  - The homepage hero title fades in without travelling or letter-spacing drift.
  - Stars do not twinkle and the scroll cue does not bob.
  - Then set the emulation back to `no-preference` and confirm every one of those
    motions returns.
- **Done when**: under `reduce`, no element in the app translates, scales or
  rotates, while opacity, color, border and shadow feedback all still respond.
