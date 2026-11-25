# Deterministic measurement checks

Run from `apps/desktop`:

```sh
node scripts/upclose/checks/cli.ts /path/to/run
```

The CLI reads every `captures/**/measure-*.json`, runs the seven measurement checks,
writes `findings/measure.json`, then combines every `findings/*.json` into
`report.json` and `report.md`. It exits 0 when no findings remain open, 2 when there
are open findings, and 1 on invalid input or an I/O error. It never starts Electron.
An empty capture folder is an error, not a successful run.

The report retains raw `open` and `waived` observations and their instance totals
in `counts`. `groups.open` and `groups.waived` list root causes, sorted by instance
count: check, component, normalized selector, measured value and expected value.
Normalization removes positional indices, React IDs, transient state classes
and text-run offsets. Equal
observations across states, themes and scales share a group; different values do
not. Each group lists its instance count, distinct elements, states, themes,
scales and an example artifact. The top-level `summary` gives group and instance
counts by check and component, with the largest group counts first.

Capture records `owners` from the nearest ancestor-or-self matching an inventory
selector on that gym scene. More constrained selectors win equal-root ties, then
component ID breaks aliases deterministically. A view retains its own structure
and peer comparisons; nested elements belong to their smaller component. Old
runs without owners are rechecked using the captured target paths from that same
gym scene. This fallback cannot recover uncaptured DOM attributes or targets;
a fresh capture supplies the authoritative ownership map.

`scope.json` defines the only exclusions, each with a reason. Third-party
Excalidraw, xterm and PDF.js DOM is excluded from every check. The app's frames
and surrounding controls remain in scope. Faces and the wordmark are drawings,
excluded from the icon portions of size, whole-pixel, alignment and drawing
checks. Their border and text checks remain active. New captures pause working
icon rotation at time zero before the screenshot and measurement. Running
rotations in old captures are excluded from alignment and drawing. The report
shows excluded element/check observations per rule, after ownership. These are
not waivers. No rule exempts remaining app findings.

`src/renderer/gym/waivers.json` is a `Waiver[]`, initially empty. The shared
`waived()` function matches check and component exactly, with optional state,
theme and selector filters. Scale is intentionally not a waiver filter. Every
reason must contain non-whitespace text. Invalid waiver files stop reporting.

## Capture integration

All old contract fields keep their original meaning. Coordinates stay in CSS
pixels relative to the viewport. `files.crop` is relative to the run folder;
`scale` maps it to device pixels. Raster checks run on the 2x measurement only.
The 1x measurement supplies whole-pixel checks. Capture must supply both scales.
The runner decodes one crop at a time and retains only numeric optical samples.

These optional fields were appended to `Measurement`. Capture should fill them
when the default inference cannot identify the intended relationship:

| Field           | Capture supplies                                                                                                                                                                                                                                                              | Default when absent                                                                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iconContexts`  | A selector-keyed map with the icon's actual `container`, optional `labelSelector`, optional optical `family`, and `paintedStrokeWidths` for children whose stroke is painted. Do not include fill-only children with `stroke:none`. An empty stroke list means a filled icon. | A sole icon uses the target. A sole label in a control is paired with it. Multiple icons require their own containers; missing geometry produces a finding. Named icons share the `Icon` optical family. `strokeWidths` is used if painted widths are absent. |
| `textContexts`  | A selector-keyed map with `kind` (`interface`, `message`, `timer`, `machine-name`, `command`, `run-id`, `terminal`), `disabled` ancestry and `effectiveOpacity` (the product of the element and every ancestor's opacity).                                                    | Interface text. The measurement's disabled state and target/element opacity are used.                                                                                                                                                                         |
| `elementKinds`  | A selector-keyed map of `button`, `icon-button`, `title-row`, `control` or `hairline`. Supply title rows and controls that do not expose their role in the captured tag/selector.                                                                                             | `.btn`, `.btn.icon`, known header selectors, native control tags and interactive ARIA roles are recognized.                                                                                                                                                   |
| `extraElements` | Nested controls, visible border/outline boxes and standalone hairlines with rect, computed styles and background.                                                                                                                                                             | Only target, icons, text, row peers and column peers are checked.                                                                                                                                                                                             |
| `textRows`      | One array of text selectors per visual row. Split wrapped text into individual measured runs.                                                                                                                                                                                 | Single-line runs whose vertical spans intersect are grouped. Multi-line runs are excluded.                                                                                                                                                                    |

For a centered labeled button, check the icon-and-label group's horizontal
center, the icon's vertical center and the pair's shared vertical centerline.
Left-aligned navigation rows compare the group's leading content edge instead
of centering it across the row. For an icon
inside a separate wrapper, compare both icon axes with that wrapper's content
box. Both label comparisons use the cap band's center, `baseline - capHeight / 2`,
so descenders do not move the reference. Wrapped runs on the same label use
the midpoint of the first and last cap-band centers. Top- and bottom-aligned
rows use the first and last cap band respectively. Capture measures `H` and `x` with canvas
`actualBoundingBoxAscent` once per computed font and size and records `capHeight`
and `xHeight` on each text run. Old captures use the pinned Atkinson fonts' OS/2
cap height of 668/1000 em (x-height is 496/1000 em); unknown fonts without metrics
cannot supply a label reference. This fallback is unhinted font geometry, while
fresh captures use Chromium's measured metrics.

The raster comparison uses the center of the painted icon bounds, not the
ink-density centroid. Sampling stays inside the SVG path bounds plus half the
painted stroke, so a nearby border cannot count as icon ink. Incomplete drawings
at the crop edge cannot supply an optical area sample.
An icon in a grid is compared with its resolved cell. A column centers an icon
on its horizontal axis, with the raster checked against the icon box vertically.
Positioned input adornments use their own horizontal slot and the field's vertical
center; they are not expected to sit at the field's horizontal center. Screen-reader labels do
not become visible icon labels. Horizontal flex rows record `contentGroup`, the
bounds of their in-flow children, so a trailing chevron or a count badge is checked
as part of the complete group. Legacy captures reconstruct that group from their
captured children. Labels owned by nested components remain available as geometry
for their row's icon without emitting findings against that nested component. Text centered independently inside a flex or
grid box does not share the surrounding row's text baseline. Each text run records
its `layoutRow`; grid cells and flex columns have separate row identities.
Screen-reader-only and zero-opacity text is excluded. Old captures infer rows
from captured ancestors and parent selector paths. Native selects with an app
chevron reserve 18px at the trailing side, which is removed from the padding
symmetry comparison. Positioned input icons reserve their width plus the 6px
icon-label gap. Column peers must overlap horizontally, so adjacent inline media
are not compared as one column. Legacy `.select` and `.select-wrap` selectors supply that reserve; ID-only
select captures use the app's 10px/28px padding signature when appearance was not
recorded. Fresh captures require
`appearance: none` with an SVG background or the separate `.select-wrap` chevron. Its finding says `raster`; DOM geometry findings say `layout`.

The clickable target must have a center sample and a complete 5x5 grid of interior
points. The center can also be one of the grid's points. Each hit must be the
target or its descendant. Capture should make a separate Measurement for each
nested control whose click coverage is to be checked.

## Expected values and tolerances

| Check          | Expected values                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Tolerance and source                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Icon alignment | Icon/container centers and icon/label centerlines agree; labeled groups center horizontally.                                                                                                                                                                                                                                                                                                                                                                                      | 0.5 CSS px on each axis, issue #173 and the frozen rubric. Raster uses the 2x crop and divides device coordinates by 2.                                                                                                                                                                                                                                                             |
| Sizes          | Type 11/12/13/15/20px, Mono 12/13px only for the five purposes in DESIGN.md, weights 400/500/700. `.btn` is 28px, `.btn.small` and `.icon-btn` 24px, stage controls 36px. Radii 6px on 24px controls, 7px on 28px controls, 8px on cards, 12px on dialogs, full pills, zero on full-width rows. Icons 12/14/16/20px with control, chip, heading, row and empty-state context. Keep 13px `.btn` labels, 12px small labels, 6px gaps, 1px edges, 52px title rows and 15px messages. | 0.01 CSS px for geometry and sizes. Weights and primary font family match exactly. DESIGN.md Window chrome/Type, root CSS tokens, and Icon.tsx. Fractional font sizes outside the scale fail. Unknown icon contexts use the icon scale, never their own width as the expected value.                                                                                                |
| Whole pixels   | Icon origins, visible border/outline bounds, 1px painted hairlines, separators and focus rings land on whole CSS pixels at 1x. Transparent borders and plain boxes are not tested.                                                                                                                                                                                                                                                                                                | 0.01 CSS px permits floating-point noise. Issue #173 and the rubric.                                                                                                                                                                                                                                                                                                                |
| Even spacing   | Opposite padding/insets, row control heights, column left edges and same-row text baselines agree.                                                                                                                                                                                                                                                                                                                                                                                | 0.5 CSS px, issue #173. Icon-only controls also compare actual icon insets.                                                                                                                                                                                                                                                                                                         |
| Icon drawing   | Drawn bbox plus half the largest painted stroke stays in the viewBox. Named icons use 0 0 16 16 and 1.5-unit strokes.                                                                                                                                                                                                                                                                                                                                                             | 0.01 SVG units for geometry and stroke serialization. Optical bbox area, normalized by rendered icon box area, must be within 35% of the median of distinct drawings in its family. At least three drawings are needed. Repeated states do not weight the median. The 35% tolerance is an explicit engine policy for shape variation; viewBox and stroke values come from Icon.tsx. |
| Contrast       | Text ≥4.5:1, large text ≥3:1 (24px regular or 18.66px bold), disabled ≥2:1. Focus ≥3:1 against adjacent color, using primary `--text` RGB. Primary-color alpha is allowed.                                                                                                                                                                                                                                                                                                        | Ratios have no rounding allowance. Primary RGB allows one channel level for serialization. WCAG 1.4.3, gym-crawl.ts disabled policy, DESIGN.md Color, and the rubric.                                                                                                                                                                                                               |
| Clickable area | Every control ≥24×24 CSS px; center and grid reach the target.                                                                                                                                                                                                                                                                                                                                                                                                                    | No size allowance; 0.01px identifies the sampled center. Issue #173 applies WCAG 2.5.8's size minimum to all controls; intended exceptions need a waiver.                                                                                                                                                                                                                           |

Thresholds are named constants in the check modules. Missing 2x rasters cause an
error. Invisible icon ink and absent click samples produce findings. Empty or
invalid JSON does not count as a clean run. Optional semantic context cannot be
recovered reliably from pixels alone; capture owns that classification.

## Image tools

`image.ts` uses `fast-png` 8.0.0, pinned exactly, with no native build. `decode()`
normalizes PNGs to eight-bit RGBA; `encode()` returns PNG bytes. `zoom(png, 4 | 8)`
uses nearest-neighbor blocks with a one-device-pixel magenta grid inserted between
source pixels. A dimension of N becomes N×factor + N−1, with no outer grid border.
`overlay(png2x, measurement)` draws padding and margin boxes, content and icon
centerlines, and text baselines, then adds a bitmap legend with no system font.
`inkBounds()` ignores channel differences of 8/255 or less and weights remaining
pixel centers by alpha and contrast from the measured background.

Tests use generated PNGs and synthetic measurements. They run under the desktop
package's normal `vitest run` and cover passing fixtures, each failure class,
waiver matching, cross-pass reports, deterministic output and real CLI exit codes.

## Element capture

Run only on a box cloned from the current `gym173-platform-2` snapshot. The capture entry point refuses
macOS. The box runner sends committed HEAD and writes to `$OUT`:

```sh
apps/desktop/scripts/gym-box/run.sh gym173-capture .scratch/upclose -- \
  bash -c 'node scripts/upclose/run.ts "$OUT"'
```

`run.ts <run-folder>` accepts comma-separated `--components` and `--states`,
`--shard i/n` (one-based), and `--skip-checks`. A component belongs to one shard.
Passive captures share a scene load; each input sequence gets a fresh scene.
Each shard opens one gym window per scale and closes it by PID in `finally`.
For a full run on the 8 vCPU box, run four shards under separate Xvfb displays:

```sh
bash scripts/upclose/parallel.sh "$OUT" 4
```

The runner reaches hover and held press with Playwright mouse input, and focus
with Tab or Shift+Tab. It checks the actual pseudo-class before and after the
screenshot. The pinned Chromium clears hover and active state when capturing a
small clip. A full-viewport `page.screenshot` preserves them; `crop.ts` cuts that
PNG on whole device pixels without resampling. The saved PNG remains an element
crop with a five CSS pixel margin, bounded by the viewport.

Capture fills `iconContexts`, `textContexts`, `elementKinds`, `extraElements` and
`textRows`. SVG names come from the owning Icon's React props. Text nodes are
split into visual lines with DOM Ranges; alphabetic baselines use the installed
font's DOM ascent, measured with a zero-size inline baseline marker in a temporary
probe outside the target. Probes are removed immediately and run only after the
crop is taken. Native input values use canvas metrics because a Range cannot
address an input's internal text. Collection leaves the DOM as it was.
PDF captures wait for the sandboxed viewer's existing rendered-page marker, so
an iframe's visible box does not substitute for finished document content.
`inputState` adds the actual hover, active and focus-visible state and the focused
element selector to `Measurement`. `layoutRects` records boxes before their own
CSS transform when no ancestor is transformed, so a rotating working icon does
not acquire fractional layout origins or a larger declared size.

`state-rules-<shard>.json` records matching CSS state rules on default captures.
`inventory-diagnostics-<shard>.json` records failed selectors and steps with the
rendered page's text and controls. These are inventory findings, so other
captures continue. `capture-summary-<shard>.json` records counts and elapsed time.
`determinism-<shard>-<scale>.json` contains two measurements of one fresh scene;
fixture time is fixed while timers and real input continue to run.

The Icon drawing check applies the family stroke and bounds contract to named
icons and explicit icon families. Character illustrations have their own masked
coordinates and stroke scale. Text runs share their painted parent's geometry;
geometry checks count that parent once while retaining each text baseline and
contrast sample.

## Visual sheet

From `apps/desktop`, run on the Linux capture box:

```sh
node scripts/upclose/sheet.ts /path/to/run --inventory /path/to/inventory.json
```

The default inventory is `src/renderer/gym/inventory.json`. The builder reads the shared `runPaths` layout and writes `sheet/index.html`, `sheet/index.json` and numbered PNGs under `sheet/pages`. Rendering uses headless Playwright Chromium at device scale 1. Set `CHROMIUM_PATH` to use the box's installed Chromium. Rendering is refused on macOS.

Each component starts with `01-summary.png`: its states at 1× in both themes,
its icon regions at 800%, and its open-finding count. Large summaries continue
onto numbered summary frames without shrinking the images. Detail frames pack
2× states by theme, region zooms, focus captures, measurement overlays, normal
and reduced motion, overflow captures, keyboard order, and report findings.
Empty groups produce no frames. Missing inputs appear as notes in both indexes.
Keyboard and motion videos are linked from the index when present.

Zooms come from the 1× crop and `measure-1x.json`. Each icon gets its measured box
plus 2 px on each side. Each component gets a 24×24 px top-left region and side
edge; focus-visible states also get a ring corner and edge. Only crops at most
120×60 px get a whole-crop zoom. Regions use `image.ts`'s nearest-neighbor `zoom()`
at 800%, with 400% also supplied when a region exceeds 60 px wide or 40 px tall.
The 1 px grid sits between enlarged source pixels, preserving their colors.
Labels give component, state, theme, scale, displayed tile coordinates, and the
original 1× source region. Missing measurements are noted rather than guessed.

Frames are 1000 px wide and at most 1250 px high. Images keep their native pixel
dimensions. Oversized images split into nonoverlapping tiles, without losing
pixels. Many small crops share a frame. The budget is 10 frames per primitive
or component, or 16 per view. Frames containing only tiles of a crop wider than
the frame are marked as exempt in the index. Selection aims for the stricter
total-frame target, including these tiles, to keep the sheet short. Selection keeps summaries, open findings, the report, a region-zoom frame,
2× states and focus ahead of auxiliary evidence. Open findings are
never dropped, even if their text alone requires exceeding the budget.
`index.json` lists every omitted frame and its image labels or text in `dropped`;
the last retained frame also names the omitted groups. The `_system` page is
outside the per-component budget and compares icons, controls, focus and type.

The report reader accepts `open` (or `findings`) arrays and a separate `waived` array. Waived entries may carry `reason` or `waiver.reason`; a wrapped `{ finding, reason }` entry is also accepted. The `summary` value is copied unchanged into the index. The run and its report remain untouched.

For a synthetic run, on the box:

```sh
node scripts/upclose/fixtures/make-run.ts /tmp/sheet-fixture
node scripts/upclose/sheet.ts /tmp/sheet-fixture --inventory /tmp/sheet-fixture/inventory.json
```

This fixture tests sheet presentation, not application behavior. Its three components include deliberately wide menu crops, two themes, focus, grid zooms, overlays, motion sequences, two open findings and one waiver. The frames are generated graphics, not captures of Uplink Room. The motion samples use a static crop to check ordering and labels.

For the current inventory (330 components, 645 states, 44 zoom-enabled components
with 135 states), a planning estimate is **2,406 component frames**. This assumes
one summary, two 2× state frames, two overlay frames, one report and one keyboard
frame per component; one focus frame for each of the 28 components with a
focus-visible state; and one region frame per 16 regions, allowing three regions
per state and theme. Apply each component's budget to that estimate. The regular
frame ceiling is **3,480** (300 × 10 + 30 × 16). These figures exclude `_system`,
wide-crop tiles and extra open-finding pages. Actual counts depend on measured
sizes, icon counts, motion passes and missing inputs; inventory alone cannot
predict those.

## Full run

Create a fresh box from `gym173-platform-2`, then run from the repository root:

```sh
instabox create --snapshot gym173-platform-2 --name gym173-calibrate-passes --vcpus 8 --mem-mib 16384 --auto-suspend 30m --no-vault --secrets none
apps/desktop/scripts/gym-box/run.sh gym173-calibrate-passes .scratch/173-full -- \
  bash -c 'bash scripts/upclose/full-run.sh "$OUT" 4 6'
instabox rm --yes gym173-calibrate-passes
```

Commit first: the box runner sends committed HEAD. `full-run.sh` captures every
inventory state at both scales, runs measurement checks, runs all five interaction
passes, and writes the shared report. Its final report counts root-cause groups
and their raw instances. UI findings do not stop the run; a failed capture or
pass process does. Output and logs are pulled into the local run folder. No
Electron process starts on the Mac.
