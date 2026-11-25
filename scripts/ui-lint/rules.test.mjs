import { test, expect } from "vitest";
import { parseSync } from "oxc-parser";
import { checkCss } from "./css.mjs";
import { checkTsx } from "./tsx.mjs";
import { countFindings, compareBaseline } from "./baseline.mjs";
const cssRules = (source) => checkCss(source, "test.css").map((h) => h.rule);
const tsxRules = (source, file = "apps/desktop/src/renderer/views/Test.tsx") =>
  checkTsx(parseSync(file, source).program, file).map((h) => h.rule);

test("tokens reject raw colors, pixels, times, radii and z-index but allow tokens and zero", () => {
  expect(
    cssRules(
      ":root{--size:12px;--color:red;--time:120ms}.a{width:var(--size);color:currentColor;margin:0;transition:opacity var(--time)}",
    ),
  ).toEqual([]);
  expect(
    cssRules(
      ".a{width:2px;color:rebeccapurple;transition:opacity .1s;border-radius:50%;z-index:2}",
    ).filter((r) => r === "css/tokens"),
  ).toHaveLength(5);
  expect(cssRules(".a{width:var(--size,12px)}")).toContain("css/tokens");
});
test("spacing, type and icon sizes use their own scale rather than arbitrary aliases", () => {
  expect(
    cssRules(".a{gap:var(--space-8);font-size:var(--font-13)}.icon{width:var(--icon-16)}"),
  ).toEqual([]);
  expect(
    cssRules(".a{padding:1rem;font-size:var(--space-8)}.icon{height:var(--size)}").filter(
      (r) => r === "css/scale",
    ),
  ).toHaveLength(3);
});
test("an outline reset needs a visible replacement for every selector in the same context", () => {
  expect(cssRules(".a,.b{outline:0}.a:focus-visible{outline:2px solid var(--text)}")).toContain(
    "css/focus-visible",
  );
  expect(
    cssRules(".a{outline:none}.a:focus-visible{box-shadow:0 0 0 var(--focus-width) var(--text)}"),
  ).not.toContain("css/focus-visible");
  expect(
    cssRules(".a{outline:none}@media(min-width:2px){.a:focus-visible{outline:solid}}"),
  ).toContain("css/focus-visible");
});
test("transition all and layout properties are rejected, including longhands", () => {
  expect(
    cssRules(".a{transition:all var(--motion-fast);transition-property:margin-left,width}"),
  ).toEqual(["css/transition-all", "css/transition-layout"]);
  expect(
    cssRules(".a{transition:transform var(--motion-fast),opacity var(--motion-fast)}"),
  ).toEqual([]);
});
test("important exceptions name the exact file, selector and property with a reason", () => {
  const source = ".x{color:var(--text)!important}";
  expect(cssRules(source)).toEqual(["css/no-important"]);
  expect(
    checkCss(source, "test.css", [
      {
        file: "test.css",
        selector: ".x",
        property: "color",
        rule: "css/no-important",
        reason: "Third party inline color",
      },
    ]),
  ).toEqual([]);
});
test("accent stripes catch physical and logical sides and split declarations", () => {
  expect(
    cssRules(
      ".card{border-left:3px solid var(--accent)}.row{border-inline-end-width:2px;border-inline-end-color:red}",
    ).filter((r) => r === "css/no-side-stripe"),
  ).toHaveLength(2);
  expect(
    cssRules(
      ".a{border-left:1px solid var(--accent)}.md blockquote{border-left:3px solid var(--line)}",
    ),
  ).not.toContain("css/no-side-stripe");
});
test("malformed CSS fails closed", () =>
  expect(cssRules(".a {color: rgb(}")).toContain("css/syntax"));
test("inline SVG is forbidden except in named artwork files", () => {
  expect(tsxRules("export const A=()=> <svg/>")).toContain("no-inline-svg");
  expect(
    tsxRules("export const A=()=> <svg/>", "apps/desktop/src/renderer/components/Wordmark.tsx"),
  ).not.toContain("no-inline-svg");
});
test("emoji in controls is rejected but message prose and reaction content are allowed", () => {
  expect(tsxRules('const a=<button type="button">🚀 Go</button>')).toContain("no-emoji-icon");
  expect(tsxRules("const a=<p>Hi 🚀</p>")).not.toContain("no-emoji-icon");
  expect(
    tsxRules(
      'const a=<button>{"👍"}</button>',
      "apps/desktop/src/renderer/components/chat/Reactions.tsx",
    ),
  ).not.toContain("no-emoji-icon");
});
test("inline pixel styles include strings, templates and React numeric lengths, not unitless values", () => {
  expect(
    tsxRules('const a=<div style={{width:"12px",height:12,opacity:0.5,top:`2px`}}/>').filter(
      (r) => r === "no-inline-px",
    ),
  ).toHaveLength(3);
  expect(tsxRules("const a=<div style={{width:0,opacity:0.5}}/>")).toEqual([]);
});
test("Icon size follows the shared scale", () => {
  expect(tsxRules("const a=<Icon size={17}/>")).toContain("icon-scale");
  expect(tsxRules("const a=<Icon size={14}/>")).toEqual([]);
});
const icon = (shape, sw = 1.5, viewBox = "0 0 16 16") =>
  `const stroke={strokeWidth:${sw}} as const; const PATHS={test:(${shape})}; function Icon(){return <svg viewBox="${viewBox}"/>}`;
const iconFile = "apps/desktop/src/renderer/components/Icon.tsx";
test("icon drawing validates viewBox and each stroke override", () => {
  expect(tsxRules(icon('<path {...stroke} strokeWidth={2} d="M2 2L14 14"/>'), iconFile)).toContain(
    "icon-geometry",
  );
  expect(
    tsxRules(icon('<circle {...stroke} cx="8" cy="8" r="5"/>', 1.5, "0 0 24 24"), iconFile),
  ).toContain("icon-geometry");
});
test("icon bounds include curved extrema and half the stroke, and allow filled silhouettes", () => {
  expect(tsxRules(icon('<path {...stroke} d="M1 8 A7.5 7.5 0 0 1 16 8"/>'), iconFile)).toContain(
    "icon-geometry",
  );
  expect(tsxRules(icon('<circle {...stroke} cx="8" cy="8" r="7.5"/>'), iconFile)).toContain(
    "icon-geometry",
  );
  expect(
    tsxRules(icon('<rect x="0" y="0" width="16" height="16" fill="currentColor"/>'), iconFile),
  ).toEqual([]);
});
test("baseline counts per file and rule, independent of lines", () => {
  expect(
    countFindings([
      { file: "b", rule: "x", line: 1 },
      { file: "b", rule: "x", line: 100 },
    ]),
  ).toEqual({ b: { x: 2 } });
});
test("normal lint rejects both growth and stale decreases; updater only accepts decreases", () => {
  expect(compareBaseline({ a: { x: 2 } }, { a: { x: 1 } }, true)).toHaveLength(1);
  expect(compareBaseline({ a: { x: 1 } }, { a: { x: 2 } })).toHaveLength(1);
  expect(compareBaseline({ a: { x: 1 } }, { a: { x: 2 } }, true)).toEqual([]);
  expect(compareBaseline({}, { a: { x: 2 } }, true)).toEqual([]);
  expect(compareBaseline({ b: { x: 1 } }, { a: { x: 1 } }, true)).toHaveLength(1);
});

test("a tokenized side width still cannot hide a stripe", () => {
  expect(
    cssRules(":root{--space-4:4px}.alert{border-right:var(--space-4) solid var(--failed)}"),
  ).toContain("css/no-side-stripe");
});
test("a later focus-visible reset cannot cancel its replacement", () => {
  expect(cssRules(".a:focus-visible{outline:solid}.a:focus-visible{outline:none}")).toContain(
    "css/focus-visible",
  );
});
test("oxlint runs the four native accessibility rules and the local plugin", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { resolve, join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "ui-lint-test-"));
  try {
    const fixture = join(dir, "probe.tsx");
    await writeFile(
      fixture,
      "export const A=()=> <><button/><div onClick={()=>{}}>Go</div><svg/></>",
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/oxlint/bin/oxlint"),
        "-c",
        resolve("scripts/ui-lint/oxlint.json"),
        "--format",
        "json",
        fixture,
      ],
      { encoding: "utf8" },
    );
    const codes = JSON.parse(result.stdout).diagnostics.map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "react(button-has-type)",
        "jsx-a11y(control-has-associated-label)",
        "jsx-a11y(click-events-have-key-events)",
        "jsx-a11y(no-static-element-interactions)",
        "ui(no-inline-svg)",
      ]),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("font family tokens are valid alongside a font scale size", () => {
  expect(cssRules(".a{font:400 var(--font-13)/1.4 var(--ui)}")).toEqual([]);
});
test("imported styles use the shared root width when detecting stripes", () => {
  expect(
    checkCss(".alert{border-left:var(--space-4) solid var(--accent)}", "alert.css", [], {
      "--space-4": 4,
    }).map((h) => h.rule),
  ).toContain("css/no-side-stripe");
});

test("named border widths cannot hide stripes and a neutral edge stays neutral", () => {
  expect(cssRules(".a{border-left:medium solid var(--accent)}")).toContain("css/no-side-stripe");
  expect(
    cssRules(":root{--space-4:4px}.a{border-left:var(--space-4) solid var(--line)}"),
  ).not.toContain("css/no-side-stripe");
  expect(cssRules(".a{border-radius:1em}")).toContain("css/tokens");
});

test("zero-width focus replacements do not satisfy the focus guard", () => {
  expect(cssRules(".a{outline:none}.a:focus-visible{outline-width:0px}")).toContain(
    "css/focus-visible",
  );
});

test("a standalone emoji glyph or image-role span is an icon too", () => {
  expect(tsxRules("const a=<span>🚀</span>")).toContain("no-emoji-icon");
  expect(tsxRules('const a=<span role="img">{"🚀"}</span>')).toContain("no-emoji-icon");
});

test("timing-function commas and duration-first named transitions remain valid", () => {
  expect(cssRules(".a{transition:opacity var(--motion-fast) cubic-bezier(.1,.2,.3,1)}")).toEqual(
    [],
  );
  expect(cssRules(".a{transition:120ms opacity}")).not.toContain("css/transition-all");
  expect(cssRules(".a{transition:120ms cubic-bezier(.1,.2,.3,1)}")).toContain("css/transition-all");
});
test("emoji in a nested tooltip is not rendered icon content", () => {
  expect(tsxRules('const a=<button><span title="👍">React</span></button>')).not.toContain(
    "no-emoji-icon",
  );
});

test("an outline reset may rely on a reviewed exception when focus shows elsewhere", () => {
  const source = ".box:focus-within{border-color:var(--text)}.box input{outline:0}";
  expect(cssRules(source)).toContain("css/focus-visible");
  const exception = {
    file: "test.css",
    selector: ".box input",
    property: "outline",
    rule: "css/focus-visible",
    reason: "The box shows focus with :focus-within.",
  };
  expect(checkCss(source, "test.css", [exception]).map((h) => h.rule)).not.toContain("css/focus-visible");
  expect(checkCss(source, "test.css", [{ ...exception, reason: "" }]).map((h) => h.rule)).toContain(
    "css/focus-visible",
  );
});

test("an exception covers only the selectors it names", () => {
  const exception = { file: "test.css", selector: ".old", property: "color", rule: "css/no-important", reason: "Third party" };
  expect(checkCss(".old{color:var(--text)!important}", "test.css", [exception])).toEqual([]);
  expect(checkCss(".old,.new{color:var(--text)!important}", "test.css", [exception]).map((h) => h.rule)).toContain(
    "css/no-important",
  );
});

test("a transition with a token duration and no property transitions all", () => {
  expect(cssRules(".a{transition:var(--motion-fast)}")).toContain("css/transition-all");
  expect(cssRules(".a{transition:var(--motion-fast) ease-out}")).toContain("css/transition-all");
  expect(cssRules(".a{transition:opacity var(--motion-fast)}")).not.toContain("css/transition-all");
});

test("inline pixel styles include inset, corner radii and signed numbers", () => {
  expect(tsxRules("const A = () => <div style={{ inset: 12 }} />;")).toContain("no-inline-px");
  expect(tsxRules("const A = () => <div style={{ borderTopLeftRadius: 8 }} />;")).toContain("no-inline-px");
  expect(tsxRules("const A = () => <div style={{ top: -12 }} />;")).toContain("no-inline-px");
  expect(tsxRules("const A = () => <div style={{ opacity: 0.5, lineHeight: 1.4 }} />;")).not.toContain("no-inline-px");
});

test("an emoji in an expression or template renders as an icon too", () => {
  expect(tsxRules('const A = () => <span>{"\u{1F680}"}</span>;')).toContain("no-emoji-icon");
  expect(tsxRules("const A = () => <button type=\"button\">{`\u{1F680}`}</button>;")).toContain("no-emoji-icon");
  expect(tsxRules('const A = () => <p>{"Launch \u{1F680} today"}</p>;')).not.toContain("no-emoji-icon");
});

test("only rendered text counts: not a nested tooltip or a comparison operand", () => {
  expect(tsxRules('const A = ({ on }) => <button type="button">{on ? <span title="\u{1F680}">Launch</span> : null}</button>;')).not.toContain("no-emoji-icon");
  expect(tsxRules('const A = ({ s }) => <button type="button">{s === "\u{1F680}" ? "Launch" : "Wait"}</button>;')).not.toContain("no-emoji-icon");
  expect(tsxRules('const A = ({ on }) => <button type="button">{on ? "\u{1F680}" : "Wait"}</button>;')).toContain("no-emoji-icon");
});
