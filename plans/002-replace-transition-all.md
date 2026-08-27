# 002 — Replace `transition-all` with explicit property lists

- **Status**: TODO
- **Commit**: 26c1b2f
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 1 file (`public/app.js`), 53 edits — 51 mechanical, 2 special-cased

## Problem

`transition-all` appears 60 times in `public/app.js`. Tailwind compiles it to
`transition-property: all`, which tells the browser to watch **every** animatable
property — including layout properties like `width`, `height`, `padding` and
`top`. Any change to one of those during the transition window triggers layout
and paint instead of a compositor-only update.

The damage is worst where `transition-all` is combined with a hover lift and a
shadow, because all three properties animate together through the slow path:

```jsx
/* public/app.js:2154 — current */
<div className={`bg-navy2 border-2 ${ring} rounded-xl px-5 py-3 text-center min-w-[160px] sm:min-w-[200px] shadow-xl hover:shadow-2xl hover:-translate-y-0.5 transition-all duration-200`}>

/* public/app.js:9863 — current */
className="ca-fade-in group relative bg-navy2 hover:bg-navy3 border border-cream/10 hover:border-gold/40 rounded-2xl p-5 flex flex-col items-center gap-3 transition-all duration-200 active:scale-95 w-full hover:-translate-y-1 hover:shadow-lg hover:shadow-black/30"

/* public/app.js:189 — current — the shared Btn, the highest-frequency element in the app */
className={`px-4 py-2 rounded-md text-sm transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 ${variants[variant]} ${className}`}
```

`Btn` at line 189 is rendered on essentially every screen, so this is the single
highest-leverage line in the file.

## Target

Swap `transition-all` for Tailwind's plain `transition` utility. `transition`
sets an explicit property list — `color, background-color, border-color,
text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter,
backdrop-filter` — which covers every property these components actually animate
while **excluding all layout properties**. Same visual result, compositor-safe.

```jsx
/* target — public/app.js:2154 */
<div className={`bg-navy2 border-2 ${ring} rounded-xl px-5 py-3 text-center min-w-[160px] sm:min-w-[200px] shadow-xl hover:shadow-2xl hover:-translate-y-0.5 transition duration-200`}>
```

The edit is mechanical and identical at every site: the token `transition-all`
becomes `transition`. Nothing else on the line changes.

## Repo conventions to follow

- Tailwind classes are written inline in JSX `className` strings, frequently
  inside template literals with `${}` interpolation. Edit only the literal text
  `transition-all`; never restructure the string.
- Duration is expressed as a sibling utility (`duration-150`, `duration-200`).
  Leave every `duration-*` exactly as it is — plan 001 owns the duration scale
  and does not depend on this plan.
- Exemplar of the target pattern already in the codebase: `public/app.js:10330`
  uses `transition-colors` (a narrow, explicit list) rather than
  `transition-all`. That is the shape to move toward.

## Steps

1. Edit the **55 lines listed below**, replacing the single token
   `transition-all` with `transition`. Each line contains exactly one
   occurrence.

   Sites that also animate a transform (`translate`/`scale`) — highest priority:
   ```
   189  1386 1523 2154 3143 3229 3435 4308 4989 4993 4998
   6348 6983 8491 8499 8505 8513 9863 10236 11338
   ```

   Sites that also animate a shadow:
   ```
   1372 1374 2060 2121 2914 2966
   ```

   Sites that animate only colors and borders:
   ```
   102  1254 1565 1592 2723 5392 5802 6604 6733 6875
   7017 7209 7726 8076 8907 8998 9336 10348 11874 12349
   12697 12830 12904 13129 13149
   ```

   That is 20 + 6 + 25 = **51** lines taking the plain `transition` swap.

2. **Two sites need a different replacement — do NOT give these plain
   `transition`.** Both are carousel dot indicators whose *active* dot is wider,
   so they genuinely animate `width`, which plain `transition` does not cover.
   Using `transition` here would make the dots snap instead of stretch:

   ```jsx
   /* public/app.js:3971 — current */
   className={`h-2 rounded-full transition-all ${i === safeIdx ? 'w-5 bg-gold' : 'w-2 bg-cream/25 hover:bg-cream/50'}`}
   /* target */
   className={`h-2 rounded-full transition-[width,background-color] duration-200 ease-out ${i === safeIdx ? 'w-5 bg-gold' : 'w-2 bg-cream/25 hover:bg-cream/50'}`}
   ```

   ```jsx
   /* public/app.js:13386 — current */
   className={`h-2 rounded-full transition-all ${i === idx ? 'w-6 bg-gold' : 'w-2 bg-cream/25 hover:bg-cream/40'}`}
   /* target */
   className={`h-2 rounded-full transition-[width,background-color] duration-200 ease-out ${i === idx ? 'w-6 bg-gold' : 'w-2 bg-cream/25 hover:bg-cream/40'}`}
   ```

   Animating `width` on an 8px dot is a negligible layout cost and is the
   correct tradeoff — converting these to `scaleX` would distort the pill shape.
   The point of the change is to stop watching *all* properties, not to
   eliminate `width` at any cost.

3. **Do not edit these seven lines** — they are progress bars that animate an
   inline `width` style, and plan 004 rewrites them to use `transform: scaleX()`:
   ```
   7432 7518 7574 11414 12306 12991 13198
   ```
   (Some of these carry the `width` on a following line; identify them by the
   presence of `style={{ width:` within the same JSX element and skip them.)

4. After the edits, confirm the count:
   `grep -c "transition-all" public/app.js` should return **7** — only the
   progress bars from step 3 remain.

   Arithmetic check: 51 plain swaps + 2 special-cased + 7 skipped = **60**, the
   total number of `transition-all` occurrences at commit `26c1b2f`.

## Boundaries

- Do NOT touch `public/index.html` — plan 001 owns it.
- Do NOT change any `duration-*`, `hover:*`, `active:*` or color utility.
- Do NOT change markup, component structure, props, or logic — this plan edits
  one class token per line and nothing else.
- Do NOT convert `transition` to a narrower list like `transition-transform` on
  the shadow or color sites; those elements genuinely animate those properties
  and narrowing further would silently drop the effect.
- Do NOT add dependencies.
- If a listed line does not contain `transition-all`, the file has drifted since
  commit `26c1b2f` — STOP and report rather than guessing which line was meant.

## Verification

- **Mechanical**:
  - `grep -c "transition-all" public/app.js` → expect `7`.
  - `grep -c "transition-\[width,background-color\]" public/app.js` → expect `2`.
  - `npx babel --presets react public/app.js -o /dev/null` if Babel is
    available; otherwise start the app (`npm start`) and load
    `http://localhost:3000`, confirming the console shows no Babel parse error
    (a broken template literal fails loudly at page load, since JSX is compiled
    in the browser).
- **Feel check**: with the app running, confirm:
  - Hovering a stat card (rendered from `public/app.js:2154`) still lifts and
    deepens its shadow — the effect must be unchanged, only cheaper.
  - Pressing any `Btn` still scales down to 95% and springs back.
  - **Click-driven, not hover-driven — do not skip.** On the homepage, click
    through the image carousel (`public/app.js:3971`) and the testimonial
    carousel (`public/app.js:13386`). The active dot must **stretch** from 8px
    to its wider state, not jump. A dot that snaps means it was given plain
    `transition` instead of `transition-[width,background-color]`. Nothing in
    the hover checks above would catch this.
  - In DevTools → Performance, record while hovering across a grid of cards
    (e.g. the roster grid at `public/app.js:4308`). Compare against a
    pre-change recording: "Recalculate Style" and "Layout" entries during hover
    should drop substantially, and no long tasks should appear.
- **Done when**: exactly 7 `transition-all` occurrences remain (all on progress
  bars), exactly 2 `transition-[width,background-color]` occurrences exist (both
  carousel dots), and every hover, press and carousel-dot effect looks identical
  to before the change.

## A note on the property list

This plan rests on Tailwind's plain `transition` utility resolving to
`color, background-color, border-color, text-decoration-color, fill, stroke,
opacity, box-shadow, transform, filter, backdrop-filter` — notably excluding
`width`, `height`, `padding`, `margin`, `top` and `left`. That holds for both
Tailwind v3 and v4.

`public/index.html:22` loads the Play CDN **unpinned** (`https://cdn.tailwindcss.com`),
and that host was unreachable from the sandbox where this plan was written, so
the served version could not be confirmed empirically. The behaviour is the same
across v3 and v4, so this is not expected to matter — but if a transition
unexpectedly stops working at one of the 51 mechanical sites, check the resolved
`transition-property` in DevTools before assuming the line was edited wrong.
