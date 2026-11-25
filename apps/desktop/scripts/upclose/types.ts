// The up-close gym's shared contract (issue #173): the component inventory, the steps that reach a
// state with real input, the findings every pass writes, the waivers, and the run folder's layout.
// The inventory (src/renderer/gym/inventory.json), the capture and check engine (upclose/run.ts),
// the interaction passes (upclose/passes/) and the sheet (upclose/sheet.ts) all read and write these.
// Change a type here only with every reader updated in the same commit.
import { join } from "node:path";

export type Theme = "dark" | "light";
export type Scale = 1 | 2;

/** The states a component can be in. A component lists those it has; `notApplicable` says why it lacks one. */
export type StateId =
  | "default"
  | "hover"
  | "focus-visible"
  | "pressed"
  | "open"
  | "selected"
  | "disabled"
  | "loading"
  | "error"
  | "empty"
  | "overflow"
  | "many"
  | (string & {});

/**
 * How a capture reaches a state with real input, run in order after the gym state has loaded and
 * scripts/gymPrepare.ts has run. Targets are CSS selectors (Playwright's, so `:has-text()` works).
 * No step forces a state through CSS or by setting attributes.
 */
export type Step =
  /** `page.mouse.move` to the target's center, then wait for transitions to settle. */
  | { do: "hover"; target: string }
  /** Mouse down over the target and hold it (no release) for the pressed state. */
  | { do: "press"; target: string }
  | { do: "click"; target: string }
  /** Press Tab (or Shift+Tab) until `document.activeElement` matches `to`, at most `max` times (default 60). */
  | { do: "tab"; to: string; max?: number }
  | { do: "shift-tab"; to: string; max?: number }
  /** A key or chord as Playwright names it: Enter, Space, Escape, ArrowDown, Shift+Tab, a. */
  | { do: "key"; key: string }
  | { do: "type"; target: string; text: string }
  /** The window's size in CSS pixels (960 × 600 is the smallest the app allows). */
  | { do: "resize"; width: number; height: number }
  | { do: "wait"; for: string };

export type InventoryState = {
  id: StateId;
  /** The gym state to load: `gym.html?state=<gymState>` (src/renderer/gym/states.ts). */
  gymState: string;
  steps?: Step[];
  /** The element to crop when it isn't the component's own selector: an open menu, a tooltip. */
  target?: string;
  /** Which match of the selector, when several match. Default 0. */
  nth?: number;
};

export type InventoryComponent = {
  /** Unique, kebab-case: "button", "icon-button", "sidebar-channel-row", "composer". */
  id: string;
  name: string;
  kind: "primitive" | "component" | "view";
  /** Repo-relative files, and CSS rules as "path#.selector". */
  sources: string[];
  /** CSS selector for one instance's box. */
  selector: string;
  /** 400% and 800% zoomed crops: icons, `.btn`, inputs, chips, pills, avatars and faces, badges, menu rows, checkboxes, toggles, focus rings. */
  zoom: boolean;
  states: InventoryState[];
  /** States this component can't be in, each with the reason ("hides instead of disabling"). */
  notApplicable?: Partial<Record<string, string>>;
  /** For the keyboard pass: overlays and composite widgets have extra rules (Escape, arrows, focus trap). */
  role?: "menu" | "listbox" | "dialog" | "tooltip" | "popover" | "tabs" | "grid";
  /** Keyboard shortcuts DESIGN.md gives it (`A`, `S`, `Z`, `H`, `↵` on Inbox rows). */
  shortcuts?: { key: string; does: string }[];
};

export type Inventory = {
  version: 1;
  components: InventoryComponent[];
  /** Files under the inventoried folders that draw nothing of their own (hooks, helpers), with why. */
  nonVisual: { file: string; reason: string }[];
};

/** A rectangle in CSS pixels relative to the viewport, fractions kept (getBoundingClientRect). */
export type Rect = { x: number; y: number; width: number; height: number };

/** An sRGB color with alpha 0 to 1, as the page computed it. */
export type Rgba = { r: number; g: number; b: number; a: number };

/** The computed styles the checks read, as getComputedStyle gives them (strings, units kept). */
export type Styles = Partial<
  Record<
    | "display"
    | "position"
    | "boxSizing"
    | "width"
    | "height"
    | "minHeight"
    | "minWidth"
    | "paddingTop"
    | "paddingRight"
    | "paddingBottom"
    | "paddingLeft"
    | "marginTop"
    | "marginRight"
    | "marginBottom"
    | "marginLeft"
    | "borderTopWidth"
    | "borderRightWidth"
    | "borderBottomWidth"
    | "borderLeftWidth"
    | "borderTopColor"
    | "borderRightColor"
    | "borderBottomColor"
    | "borderLeftColor"
    | "borderTopLeftRadius"
    | "borderTopRightRadius"
    | "borderBottomRightRadius"
    | "borderBottomLeftRadius"
    | "gap"
    | "columnGap"
    | "rowGap"
    | "alignItems"
    | "justifyContent"
    | "flexDirection"
    | "fontFamily"
    | "fontSize"
    | "fontWeight"
    | "lineHeight"
    | "letterSpacing"
    | "textTransform"
    | "color"
    | "backgroundColor"
    | "backgroundImage"
    | "appearance"
    | "visibility"
    | "clip"
    | "clipPath"
    | "opacity"
    | "cursor"
    | "overflow"
    | "overflowX"
    | "textOverflow"
    | "whiteSpace"
    | "outlineStyle"
    | "outlineWidth"
    | "outlineColor"
    | "outlineOffset"
    | "boxShadow"
    | "transitionProperty"
    | "transitionDuration"
    | "transitionTimingFunction"
    | "transform"
    | "zIndex",
    string
  >
>;

/** One element the checks look at: the component's box, an icon in it, a text run, a peer in its row. */
export type MeasuredElement = {
  /** A selector that finds this element again on the same page (for findings). */
  selector: string;
  tag: string;
  rect: Rect;
  styles: Styles;
  /** The color it actually sits on: its own background, else the nearest painted ancestor's, alpha composited. */
  background: Rgba;
  role?: string;
  /** Accessible name, when the element has one. */
  name?: string;
};

export type MeasuredIcon = MeasuredElement & {
  /** The svg's viewBox and the width and height attributes it was given. */
  viewBox: string | null;
  attrWidth: string | null;
  attrHeight: string | null;
  /** Computed stroke width of each drawn child (path, circle, line, rect, polyline, polygon, ellipse), in user units. */
  strokeWidths: number[];
  /** Union of the drawn children's getBBox(), in user units, before stroke. */
  bbox: { x: number; y: number; width: number; height: number } | null;
  /** The icon's name when it came from <Icon name=...> (data attribute or the nearest known source); null for other svgs. */
  iconName: string | null;
};

export type MeasuredText = MeasuredElement & {
  text: string;
  /** Range.getBoundingClientRect() of the text itself, which differs from the element's box. */
  inkRect: Rect;
  /** The alphabetic baseline's y in CSS pixels relative to the viewport. */
  baseline: number;
  /** Whether the text is cut off: scrollWidth > clientWidth (or height) on its element. */
  clipped: boolean;
  /** Heights of H and x above the alphabetic baseline, in CSS pixels. */
  capHeight?: number;
  xHeight?: number;
  /** Nearest layout row or grid cell; independent columns have separate keys. */
  layoutRow?: string;
};

/**
 * What capture writes to `measure.json` for one component, state, theme and scale, and what every check reads.
 * Raster checks read the crop PNGs; `crop` maps CSS pixels to the PNG's device pixels:
 * px = (cssX - crop.x) * scale, py = (cssY - crop.y) * scale.
 */
export type Measurement = {
  component: string;
  state: string;
  theme: Theme;
  scale: Scale;
  gymState: string;
  /** The window's inner size in CSS pixels. */
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  /** The region the crop PNGs show, in CSS pixels: the target's box plus a margin. */
  crop: Rect & { margin: number };
  target: MeasuredElement;
  icons: MeasuredIcon[];
  texts: MeasuredText[];
  /** Sibling controls in the same row (same flex or grid parent), the target included, for equal heights and gaps. */
  rowPeers: MeasuredElement[];
  /** Items in the same column as the target (a list's rows), for shared left edges. */
  columnPeers: MeasuredElement[];
  /** document.elementFromPoint at the target's center and at a 5 × 5 grid inside its box: does each hit the target or a descendant? */
  hits: { x: number; y: number; hitsTarget: boolean; hit: string }[];
  /** The element that has focus, when the state is focus-visible, with its outline or ring and what's beside it. */
  focus?: {
    element: MeasuredElement;
    ringColor: Rgba | null;
    ringWidth: number;
    adjacent: Rgba;
  } | null;
  /** Every custom property on :root with its resolved value (`--line`: "#2B2E33"). */
  tokens: Record<string, string>;
  /** The PNGs, relative to the run folder. */
  files: { crop: string; zoom400?: string; zoom800?: string; overlay?: string };
  /** Actual icon wrappers and paired labels; family groups icons with comparable intended optical size. */
  iconContexts?: Record<
    string,
    {
      container: MeasuredElement;
      /** The icon's resolved grid cell when its parent lays out several rows or columns. */
      alignmentRect?: Rect;
      /** Union of in-flow children in a horizontal flex row, including sibling adornments. */
      contentGroup?: Rect;
      labelSelector?: string;
      family?: string;
      /** Widths of children with a painted stroke only. Excludes fill-only children with stroke:none. */
      paintedStrokeWidths?: number[];
    }
  >;
  /** Text purpose, disabled ancestry and product of ancestor opacities (including the element). */
  textContexts?: Record<
    string,
    {
      kind:
        | "interface"
        | "emoji"
        | "message"
        | "timer"
        | "machine-name"
        | "command"
        | "run-id"
        | "terminal"
        | "code"
        | "url";
      disabled?: boolean;
      effectiveOpacity?: number;
      /** Backgrounds and opacities from the text's element outward, for compositing as the browser does. */
      layers?: { background: Rgba; opacity: number }[];
    }
  >;
  /** Semantic roles for selectors that cannot be identified from their captured tag or selector. */
  elementKinds?: Record<string, "button" | "icon-button" | "title-row" | "control" | "hairline">;
  /** Nested controls and hairlines, including their computed styles, for geometry checks. */
  extraElements?: MeasuredElement[];
  /** Text selectors on each single visual row; wrapped text belongs in separate rows. */
  textRows?: string[][];
  /** Layout boxes before an element's own CSS transform, when its ancestors are untransformed. */
  layoutRects?: Record<string, Rect>;
  /** Nearest captured inventory owner for each element, recorded against the rendered DOM. */
  owners?: Record<string, { component: string; root: string }>;
  /** Rotation status at measurement time. Paused rotations have been sought to time zero. */
  rotations?: Record<string, "paused-at-zero" | "running">;
  /** Scope rules matched through DOM ancestry, including ancestors hidden by an element ID. */
  scopeMatches?: Record<string, string[]>;
  /** Actual pseudo-class and focus evidence at the instant of measurement. */
  inputState?: {
    hovered: boolean;
    active: boolean;
    focusVisible: boolean;
    focusedSelector: string | null;
  };
};

export type CheckId =
  | "icon-alignment"
  | "sizes"
  | "whole-pixels"
  | "even-spacing"
  | "icon-drawing"
  | "contrast"
  | "clickable-area"
  | "overflow"
  | "motion"
  | "keyboard"
  | "mouse"
  | "detector"
  | "inventory";

/** One deterministic finding. Every pass writes an array of these to `findings/<pass>.json` in the run folder. */
export type Finding = {
  /** Stable across runs: a hash of check, component, state, theme and selector (see findingId). */
  id: string;
  check: CheckId;
  component: string;
  state: string;
  theme: Theme;
  scale?: Scale;
  gymState: string;
  selector: string;
  /** What was measured, with units: { centerOffsetX: 0.75 } or "1.5px". */
  measured: unknown;
  /** What DESIGN.md or the tokens require: { centerOffsetX: "≤ 0.5" } or "28px". */
  expected: unknown;
  message: string;
  /** Run-folder-relative path of the image or video that shows it. */
  artifact?: string;
};

/** src/renderer/gym/waivers.json: findings left as intended. Omitted fields match anything. */
export type Waiver = {
  check: CheckId;
  component: string;
  state?: string;
  theme?: Theme;
  selector?: string;
  reason: string;
};

export function findingId(
  f: Pick<Finding, "check" | "component" | "state" | "theme" | "selector">,
): string {
  const text = [f.check, f.component, f.state, f.theme, f.selector].join("\u0000");
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function waived(f: Finding, waivers: Waiver[]): Waiver | undefined {
  return waivers.find(
    (w) =>
      w.check === f.check &&
      w.component === f.component &&
      (w.state === undefined || w.state === f.state) &&
      (w.theme === undefined || w.theme === f.theme) &&
      (w.selector === undefined || w.selector === f.selector),
  );
}

/**
 * A run folder's layout. Every writer uses these paths, so the report and the sheet find everything.
 *
 *   captures/<component>/<state>/<theme>/1x.png, 2x.png        element crops at device scale 1 and 2
 *   captures/<component>/<state>/<theme>/zoom-400.png, zoom-800.png   nearest-neighbor, 1 px grid
 *   captures/<component>/<state>/<theme>/overlay.png            padding and margin boxes, centerlines, baselines (on the 2× crop)
 *   captures/<component>/<state>/<theme>/measure-1x.json, measure-2x.json   a Measurement each: what the checks read
 *   keyboard/<gymState>/<theme>/order.json, tab.webm            the tab order and its video
 *   mouse/<gymState>/<theme>/...                                tooltips, cursors and hit areas
 *   motion/<component>/<animation>/<theme>/f000.png … f100.png, reduced/…, live.webm
 *   overflow/<gymState>/<variant>/<theme>.png                   long names, long messages, many members, 960 px
 *   detector/<gymState>-<theme>.json                            npx impeccable detect
 *   findings/<pass>.json                                        Finding[] per pass
 *   report.json, report.md                                      every finding, waived ones apart
 *   sheet/                                                      the visual sheet (docs/ui-judge-rubric.md)
 */
export const runPaths = (run: string) => ({
  capture: (component: string, state: string, theme: Theme, file: string) =>
    join(run, "captures", component, state, theme, file),
  keyboard: (gymState: string, theme: Theme, file: string) =>
    join(run, "keyboard", gymState, theme, file),
  mouse: (gymState: string, theme: Theme, file: string) =>
    join(run, "mouse", gymState, theme, file),
  motion: (component: string, animation: string, theme: Theme, file: string) =>
    join(run, "motion", component, animation, theme, file),
  overflow: (gymState: string, variant: string, theme: Theme) =>
    join(run, "overflow", gymState, variant, `${theme}.png`),
  detector: (gymState: string, theme: Theme) => join(run, "detector", `${gymState}-${theme}.json`),
  findings: (pass: string) => join(run, "findings", `${pass}.json`),
  report: (ext: "json" | "md") => join(run, `report.${ext}`),
  sheet: join(run, "sheet"),
});
