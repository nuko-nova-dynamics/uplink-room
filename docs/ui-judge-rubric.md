# UI judge rubric (component sheet)

This rubric is frozen. A judge grades the Uplink Room desktop app's component sheet with it and with nothing else. Do not change it between rounds; a change needs a new rubric version and a note on why.

## What you get

1. **The sheet**: a folder with `index.html`, `index.json` and one folder per component under `pages/`. Each page holds numbered frames (`pages/<component>/<NN>-<label>.png`), each about 1000 px wide: 1× and 2× element crops, 400% and 800% nearest-neighbor zooms with a 1 px grid, every state side by side in dark and light, keyboard focus states, motion frame strips (0, 25, 50, 75 and 100% of each animation, and the same with reduced motion), measurement overlays (padding and margin boxes, the container's and the icon's centerlines, text baselines) and the component's part of the deterministic report. `pages/_system/` holds cross-component frames (all icons side by side, all controls side by side, focus rings, type).
2. **The deterministic report** (`report.json` and `report.md`): scripted measurements with each open finding's component, state, theme, selector, measured value and expected value, plus the waived findings with their reasons.
3. **This rubric**, which includes the design rules below and the no-slop catalog.

Read nothing else: no git history, issues, pull requests, earlier reports or notes. Grade what the frames show.

## What to check, per component

Check every state in both themes, at 100% (the 1× and 2× crops) and in the zoomed crops.

- **Alignment.** The icon sits centered in its control; icon and label share a centerline; text in a row shares a baseline; items in a column share a left edge.
- **Size and spacing.** Sizes match the design rules below. Padding is even on opposite sides. Controls in one row have equal heights. Spacing follows the scale; nothing is cramped or loose relative to its neighbors.
- **Crisp rendering.** Strokes, borders and hairlines land on whole pixels at 1× (no blurred or doubled 1 px lines). Icons in one family have the same stroke and optical size.
- **States.** Default, hover, focus-visible, pressed or active, open, selected, disabled, loading, error, empty, long text or overflow and many items, where the component has them. Each state is distinct and readable, and none is missing. Focus is always visible with the primary text color and at least 3:1 against what is next to it.
- **Contrast.** Body and placeholder text at least 4.5:1, large text at least 3:1, in every state and theme and over every background it lands on.
- **Fit.** Nothing clipped without an ellipsis, nothing overflowing its container or the window, no unintended overlap, menus and tooltips fully inside the window, real long content handled at 960 px wide.
- **Motion.** Only live things move. Transitions animate transform, opacity or color, not layout; nothing shifts during a transition; easing is calm (no bounce or elastic); reduced motion is honored.
- **Keyboard and pointer.** Every control can be reached by Tab in a logical order; Escape closes an overlay and returns focus; menus answer the arrow keys; dialogs keep focus inside; the clickable area matches the drawn box and is at least 24 × 24 px; icon-only controls have a tooltip.
- **No-slop catalog.** Go through every rule in `~/.claude/skills/frontend-design-no-slop/references/impeccable-catalog.md` and section 4 of `~/.claude/skills/frontend-design-no-slop/SKILL.md` against the light and dark frames. Typical tells: a colored side stripe thicker than 1 px on a card, row or alert; emoji or Unicode glyphs as icons; all-caps labels; gradient text; glass or blur as decoration; a pulsing status dot; a hairline and a wide soft shadow on one card; a soft grey shadow under every card.

## Design rules (from the app's design system)

- **Type.** Atkinson Hyperlegible Next for everything people read: 13 px interface text, 15 px messages, weights 400, 500 and 700 only. Atkinson Hyperlegible Mono only for timers, machine names, commands, run IDs and terminal output.
- **Icons.** 16 px line icons drawn with a 1.5 stroke, one family. In a `.btn` the icon renders at 14 px. The glyph before a title (`#`, lock, pushpin, browser, search, machine) is 14 px in `muted`, its ink on the text's baseline.
- **The control.** Header and dock controls are `.btn`: 28 px tall, 7 px radius, a 1 px `line` edge on `raised`, a 14 px icon, a 13 px label, 6 px between icon and label. An icon-only control is a 28 px square (`.btn.icon`). Pressed or open: the `hover` fill and a `faint` edge. Only the primary action has the text-colored fill; a segmented control's selected segment looks pressed, not filled.
- **Rows and chrome.** Title rows (sidebar top, view headers, side panel headers, task and run drawers) are 52 px with everything centered on one line 26 px down. The last control in a header ends 16 px from the window's right edge. A view's title starts on the 18 px content gutter. Sidebar row boxes start 8 px from its edge with their icons at 16 px. 8 px between everything in a row; text controls first, icon-only controls last. The sidebar footer is a 52 px row. The call dock is one box 8 px in from the sidebar's edges with 28 px icon controls on `ground`.
- **Color.** Graphite neutrals with one accent, lilac, for primary actions, where you are, links, your own reactions and what's addressed to you. Amber is the only loud state color and always means "needs you". Focus rings, the in-control pill and the terminal cursor use the primary text color, never amber or the accent. Dark: `ground` #151619, `sidebar` #0C0D0F, `raised` #1D1F23, `hover` #23262A, `line` #2B2E33, `text` #EBECEE, `muted` #9DA1A9, `faint` #5D6168, `amber` #F0A73A, `accent` #A98BF5. Light (cool white): `ground` #F7F8FA, `sidebar` #EEF0F3, `raised` #FFFFFF, `line` #DFE2E7, `text` #15171A, `muted` #5B6069, `accent` #6D4FD8. Each run state has its own icon, so color is never the only signal.
- **Other.** Link preview cards have one even hairline edge and an 8 px radius. Inline images up to 360 × 240. Scrollbars show only while the pointer is over their area. A working run shows a timer, never a progress bar. Selects draw the app's own chevron. Icon-only controls carry a tooltip and an accessible name with the same words.

## Grades

Grade each component, then the whole sheet, on F, D, C−, C, C+, B−, B, B+, A−, A, A+.

| Grade | Meaning |
|---|---|
| A+ | Exemplary. Nothing to fix anywhere, and it sets the standard for the rest. |
| A | A careful designer finds nothing to fix at 100% or in the zoomed crops, and the deterministic report has no open finding for it. |
| A− | Only nits that show in the zoomed crops alone (a sub-pixel optical offset, a slightly uneven antialias). No state missing. A user would not notice anything at 100%. |
| B+ | One minor defect visible at 100% in one state or theme, or one open deterministic finding. |
| B | Several minor defects, or one clear one at 100% (an icon off center, a wrong size, a missing hover). |
| C (±) | Defects across several states, a missing or invisible focus state, a contrast failure, or a catalog tell. |
| D | A broken state: clipped or overlapping content, a control the keyboard can't reach, a menu cut off by the window. |
| F | Unusable, or the frames don't show the component. |

Caps, applied after grading:

- An open deterministic finding for the component caps it at B+.
- A no-slop catalog tell caps it at B.
- A missing or invisible focus-visible state, or a control the keyboard can't reach, caps it at C.
- A state the component has but the sheet doesn't show caps it at B. Say which.

**Overall grade.** Convert each component's grade to points (A+ 4.3, A 4.0, A− 3.7, B+ 3.3, B 3.0, B− 2.7, C+ 2.3, C 2.0, C− 1.7, D 1.0, F 0) and take the mean. Bands: A+ ≥ 4.15, A ≥ 3.85, A− ≥ 3.5, B+ ≥ 3.15, B ≥ 2.85, B− ≥ 2.5, C+ ≥ 2.15, C ≥ 1.85, C− ≥ 1.5, D ≥ 0.85, F below. Then apply, in order:

1. The overall grade is at most one step above the lowest component grade.
2. Any open finding in the deterministic report caps the overall grade at B+.
3. A system-level inconsistency (two icon stroke weights, two control heights in one role, two focus ring styles) lowers the overall grade one step. Name it.

## Findings

Every finding names the component, state, theme and frame (the frame's file name), and gives the scale (1×, 2×, 400% or 800%), a severity (`blocker`, `major`, `minor` or `nit`), what is wrong in measurable terms where possible ("icon 1 px right of center", "label baseline 1 px below the icon's centerline", "hover fill matches the default in light"), and what would fix it, as an outcome, not code.

## Report format

Write `judge-report.json` and `judge-report.md` in the folder you were told to write to.

```json
{
  "rubric": "ui-judge-rubric v1",
  "overall": { "grade": "B+", "points": 3.31, "caps": ["..."], "rationale": "..." },
  "components": [
    {
      "id": "button",
      "grade": "A-",
      "rationale": "...",
      "findings": [
        { "component": "button", "state": "hover", "theme": "light", "frame": "pages/button/03-states-light.png", "scale": "800%", "severity": "nit", "issue": "...", "fix": "..." }
      ]
    }
  ],
  "system": [ { "issue": "...", "frames": ["pages/_system/01-icons.png"], "severity": "minor", "fix": "..." } ]
}
```

The Markdown report gives the overall grade first, then a table of components with their grades, then every finding grouped by component, most severe first.

## Splitting the work

The sheet may be too large to read in one context. You may hand groups of components to fresh sub-judges. Give each one only this rubric, its components' page folders, `pages/_system/` and the deterministic report, nothing else, and tell it to read nothing else. Collect their per-component grades and findings, check `pages/_system/` yourself for system-level consistency, and compute the overall grade with the rules above.
