# 004 — Drive progress bars with `scaleX()` instead of `width`

- **Status**: TODO
- **Commit**: 26c1b2f
- **Severity**: MEDIUM *(revised down from HIGH — see "Honest scoping" below)*
- **Category**: Performance
- **Estimated scope**: 1 file (`public/app.js`), 7 elements

## Honest scoping

The audit table first graded this HIGH on the general rule that animating
`width` triggers layout while `transform` does not. Reading the seven call
sites in context, that grade was too strong: these bars re-render when data
loads or a value changes, **not** on a continuous rAF loop, so each transition
costs one reflow of a small, isolated subtree rather than sustained frame drops.

It is still worth fixing — it is the last `transition-all` cluster in the file
and the fix is contained — but it should be scheduled after plans 001–003, and
it carries a real visual tradeoff documented under **Target**. If the tradeoff
is judged not worth it, closing this plan as WONTFIX is a legitimate outcome.

## Problem

All seven progress bars animate an inline `width` percentage:

```jsx
/* public/app.js:7432 — current */
<div className="h-full rounded-full bg-gold transition-all" style={{ width: `${pct}%` }} />

/* public/app.js:7518 — current */
<div
  className={`h-full rounded-full transition-all ${colors[i % colors.length]}`}
  style={{ width: `${pct}%` }}
/>

/* public/app.js:7574 — current */
<div className={`h-full ${color} rounded transition-all duration-500`} style={{ width: `${Math.max(pct, count > 0 ? 3 : 0)}%` }} />

/* public/app.js:11414 — current */
<div className="bg-gold h-1.5 rounded-full transition-all" style={{ width: `${(done/CHECKLIST.length)*100}%` }} />

/* public/app.js:12306 — current */
<div className="h-full bg-gold rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />

/* public/app.js:12991 — current */
<div className="h-full bg-gold/60 rounded-full transition-all"
  style={{ width: `${totals.totalAmount > 0 ? Math.min(100, (row.totalAmount / totals.totalAmount) * 100) : 0}%` }} />

/* public/app.js:13198 — current */
<div className="h-full bg-gold/70 rounded-full transition-all" style={{ width: `${pct}%` }} />
```

Each also still carries `transition-all`, which plan 002 deliberately skipped
because the fix here is structural rather than a token swap.

## Target

Give the fill a full-width box and scale it horizontally from its left edge:

```jsx
/* target — public/app.js:7432 */
<div className="h-full w-full bg-gold origin-left transition-transform duration-500 ease-out"
     style={{ transform: `scaleX(${pct / 100})` }} />
```

The transformation at every site is the same four-part change:

1. Remove `style={{ width: … }}`; add `style={{ transform: \`scaleX(${<expr> / 100})\` }}`
   using the **same expression** that produced the percentage, divided by 100.
2. Add `w-full` and `origin-left`.
3. Replace `transition-all` with `transition-transform`.
4. Remove `rounded-full` / `rounded` **from the fill** (see tradeoff below).

**The tradeoff — read before starting.** `scaleX` scales the fill's border-radius
along with it, turning a `rounded-full` pill into a distorted ellipse. The fix is
to drop rounding from the fill and let the track's existing
`rounded-full overflow-hidden` clip it. The visible consequence: the fill's
**right edge becomes square instead of rounded** at values below 100%.

- On the six thin bars (`h-1.5`, `h-2`, `h-2.5`) this is essentially invisible.
- On the one tall bar, `public/app.js:7574` (`h-5`), it **is** noticeable.
  For that site only, either accept the square edge or leave the bar on `width`
  and skip it. State which you chose in your report.

Track elements at lines 7431, 7517, 12305, 12990, 13197 already have
`overflow-hidden`. The track at **`public/app.js:11413`** does not:

```jsx
/* public/app.js:11413 — current */
<div className="flex-1 bg-navy rounded-full h-1.5">
/* target */
<div className="flex-1 bg-navy rounded-full h-1.5 overflow-hidden">
```

## Repo conventions to follow

- Tailwind utilities inline in JSX; dynamic values go through the `style` prop.
  Both patterns are already used together at every site listed above.
- Duration: bars at 7574 and 12306 use `duration-500`; the rest use Tailwind's
  default 150ms. Standardize all seven on `duration-500` — a progress bar is a
  value change worth watching, and 500ms reads as deliberate without feeling
  slow. This is the one place in the app where a long duration is correct,
  because the bar is explanatory rather than interactive.
- Easing: add `ease-out` explicitly. A bar filling should decelerate into its
  final value.
- Exemplar: `public/app.js:1374` already animates a transform via a Tailwind
  class (`translate-x-5`) on a toggle knob rather than repositioning it.

## Steps

1. `public/app.js:11413` — add `overflow-hidden` to the track div.
2. For each of the seven fill elements (7432, 7518, 7574, 11414, 12306, 12991,
   13198), apply the four-part change from **Target**. Work bottom-up
   (13198 first, 7432 last) so earlier edits do not shift later line numbers.
3. At `public/app.js:12991`, the width expression spans two lines; preserve the
   full conditional intact inside the `scaleX(…)` call, dividing the final result
   by 100.
4. At `public/app.js:7574`, the expression is
   `Math.max(pct, count > 0 ? 3 : 0)` — keep the `Math.max` floor (it guarantees
   a visible sliver for nonzero counts) and divide the whole thing by 100.
5. If you chose to skip 7574 per the tradeoff note, leave it entirely unchanged
   including its `transition-all`, and say so in your report.

## Boundaries

- Do NOT touch `public/index.html`.
- Do NOT change any track element other than adding `overflow-hidden` at 11413.
- Do NOT change the arithmetic that computes each percentage — only divide the
  existing expression by 100.
- Do NOT convert any other `width`/`height` animation in the file; only these
  seven progress bars are in scope.
- Do NOT add dependencies.
- If a listed line does not match the code quoted under **Problem**, STOP and
  report.

## Verification

- **Mechanical**:
  - `grep -c "transition-all" public/app.js` → expect `0` (or `1` if you skipped
    7574), assuming plan 002 has already run.
  - Start the app (`npm start`) and load `http://localhost:3000`; confirm no
    Babel parse error in the console.
- **Feel check**: navigate to each bar and confirm:
  - A bar at 0% is invisible, at 100% fills the track exactly edge to edge, and
    at intermediate values ends where it did before (compare against a
    screenshot taken before the change — an off-by-100 error shows as a bar
    that is always full or always empty).
  - The fill grows **from the left**, never from the centre. A bar growing from
    the centre means `origin-left` is missing.
  - The fill's colour band is not vertically squashed or blurred — that would
    mean `w-full` is missing and the element is being scaled up from a narrow
    box.
  - In DevTools → Animations at 10% playback, the fill decelerates into its
    final value rather than moving linearly.
- **Done when**: all seven bars (or six, if 7574 was skipped) animate via
  `transform`, land at visually identical resting positions, and no bar animates
  `width` any more.
