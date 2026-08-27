# 005 — Gate hover motion behind `@media (hover: hover)`

- **Status**: TODO
- **Commit**: 26c1b2f
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 1 file (`public/index.html`), ~12 lines added

## Problem

Eleven elements move on `:hover`. None are gated on the device actually having a
hover-capable pointer:

```jsx
/* public/app.js:2154 */  hover:shadow-2xl hover:-translate-y-0.5
/* public/app.js:3435 */  hover:-translate-y-1 hover:shadow-lg
/* public/app.js:3884 */  group-hover:scale-105
/* public/app.js:4308 */  hover:-translate-y-1 hover:shadow-md
/* public/app.js:4989 */  hover:-translate-y-0.5
/* public/app.js:4993 */  hover:-translate-y-0.5
/* public/app.js:4998 */  hover:-translate-y-0.5
/* public/app.js:6983 */  hover:-translate-y-0.5
/* public/app.js:9863 */  hover:-translate-y-1
/* public/app.js:9865 */  group-hover:scale-110
/* public/app.js:10236 */ hover:-translate-y-0.5
```

On a touch device, tapping any of these fires a synthetic hover that **sticks**
until the user taps elsewhere. The result is a card that lifts on tap and stays
lifted — motion the user did not ask for, on an element they were trying to
activate. This is most visible on the roster grid (`public/app.js:4308`) and the
dashboard shortcut cards (`public/app.js:9863`), both of which are primary touch
targets on mobile.

This is a separate concern from plan 003. Plan 003 suppresses this motion for
users who request reduced motion; this plan suppresses it for users whose
*pointer cannot hover* — an overlapping but distinct group, and the far larger
one.

## Target

A single CSS block in `public/index.html` that neutralizes hover transforms when
the primary pointer is coarse. Add it immediately **before** the
`@media (prefers-reduced-motion: reduce)` block:

```css
/* target */
/* Touch devices fire a sticky synthetic :hover on tap. Movement on hover is
   for real pointers only; colour, border and shadow feedback still apply
   everywhere so tapped elements keep responding. */
@media not all and (hover: hover) {
  [class*="hover:-translate-y"]:hover,
  [class*="hover:translate-y"]:hover,
  [class*="hover:scale-"]:hover,
  .group:hover [class*="group-hover:scale-"] {
    transform: none !important;
  }
}
```

`@media not all and (hover: hover)` is the reliable negation form — plain
`@media (hover: none)` misses hybrid devices that report `hover: hover` for a
stylus but are being driven by touch, and is also mishandled by some older
Android browsers.

Note the fourth selector: `public/app.js:3884` and `:9865` scale a **child** via
Tailwind's `group-hover:` variant, so the hover lands on `.group` while the
transform lands on the descendant. The first three selectors would miss them.

## Repo conventions to follow

- All CSS lives in the single `<style>` element in `public/index.html`
  (lines 58–154). No separate stylesheet, no build step.
- Fix this centrally in CSS rather than by adding Tailwind variants to 11 class
  strings in `app.js`. Tailwind's Play CDN generates variants at runtime, and
  there is no `hover-hover:` variant built in — a per-site fix would mean
  extending the CDN config, which is more code and more risk than one media
  query.
- The attribute-selector approach mirrors what plan 003 does for reduced motion;
  keep the two blocks adjacent and similarly commented so the pattern reads as
  deliberate.
- Exemplar already in the repo: `public/app.js:4459` — `TiltScene` explicitly
  bails on `window.matchMedia('(hover: none)').matches`, i.e. the codebase
  already accepts that pointer capability gates motion. This plan extends that
  same judgement to CSS.

## Steps

1. Open `public/index.html` and locate the
   `@media (prefers-reduced-motion: reduce)` block (line 149 at commit
   `26c1b2f`; later if plan 003 has already run).
2. Insert the `@media not all and (hover: hover)` block from **Target**
   immediately before it, including the explanatory comment.
3. Leave the reduced-motion block itself untouched — the two blocks are
   independent and may both apply.

## Boundaries

- Do NOT touch `public/app.js`. No JSX changes are needed for this fix.
- Do NOT remove or alter any `hover:` utility class — hover motion must keep
  working on real pointers.
- Do NOT gate `hover:shadow-*`, `hover:border-*`, `hover:bg-*` or
  `hover:brightness-*`. Colour and depth feedback on tap is useful; only
  movement is the problem.
- Do NOT gate `active:scale-*`. Press feedback on touch is correct and desirable
  — it confirms the tap registered.
- Do NOT add dependencies or extend the Tailwind CDN config.
- If the reduced-motion block is not present at all, STOP and report — plans 003
  and 005 are being applied out of order.

## Verification

- **Mechanical**: `node -e "const s=require('fs').readFileSync('public/index.html','utf8');
  const o=(s.match(/{/g)||[]).length, c=(s.match(/}/g)||[]).length;
  console.log(o===c ? 'braces balanced' : 'MISMATCH '+o+'/'+c)"` → expect
  `braces balanced`.
- **Feel check**: run `npm start`, open `http://localhost:3000`, then in DevTools
  toggle device emulation to a touch device (e.g. iPhone) so `hover: hover` no
  longer matches, and confirm:
  - Tapping a roster card (`public/app.js:4308`) changes its border but the card
    **does not lift or stay lifted**.
  - Tapping a dashboard shortcut (`public/app.js:9863`) does not lift it, and
    its icon (`:9865`) does not grow.
  - A gallery thumbnail (`public/app.js:3884`) does not zoom on tap.
  - Pressing any `Btn` still scales down briefly — `active:` feedback must
    survive.
  - Then switch emulation back to a desktop viewport and confirm **every** hover
    lift, shadow and icon zoom returns exactly as before.
- **Done when**: under touch emulation no element translates or scales on tap,
  while border/shadow/background hover styling and all `active:` press feedback
  still apply; and desktop hover behaviour is byte-for-byte unchanged.
