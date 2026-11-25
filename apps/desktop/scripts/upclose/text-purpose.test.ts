import { expect, it } from "vitest";
import { measurement, text } from "./fixtures.ts";
import { withTextPurposes } from "./text-purpose.ts";

it("recognizes command output, machine fields and durations without allowing Mono everywhere", () => {
  const selectors = [
    ".cmd-word",
    ".thread-fold > span.mono",
    "#machine-name",
    ".activity .mono",
    ".browser-url",
    ".file-size.mono",
  ];
  const m = measurement({
    texts: selectors.map((s, i) => ({
      ...text(s),
      text: ["pnpm test", "rg -n height", "Studio Mac", "25m", "https://example.com", "2 KB"][i]!,
    })),
  });
  const contexts = withTextPurposes(m).textContexts!;
  expect(selectors.map((s) => contexts[s]!.kind)).toEqual([
    "command",
    "command",
    "machine-name",
    "timer",
    "url",
    "interface",
  ]);
});

it("knows editable source, machine fields, single machine tokens and interface text inside messages", () => {
  const cases: [string, string, string][] = [
    ["textarea.doc-source::value", "# Harbor stations", "code"],
    ["div.task-fact > span.task-fact-value.mono::text", "studio mini", "machine-name"],
    ["p > span.mono::text", "mini", "machine-name"],
    ["p > span.mono::text(1)", "2 KB", "interface"],
  ];
  const m = measurement({ texts: cases.map(([s, t]) => ({ ...text(s), text: t })) });
  const contexts = withTextPurposes(m).textContexts!;
  expect(cases.map(([s]) => contexts[s]!.kind)).toEqual(cases.map(([, , k]) => k));
  const hint = measurement({
    texts: [
      { ...text("div.msg-body > span.agent-answer-hint::text"), text: "Or write your answer" },
    ],
  });
  hint.textContexts = { "div.msg-body > span.agent-answer-hint::text": { kind: "message" } };
  expect(
    withTextPurposes(hint).textContexts!["div.msg-body > span.agent-answer-hint::text"]!.kind,
  ).toBe("interface");
});

it("classifies emoji content independently from its surrounding UI labels", () => {
  const cases = [
    ["div.emoji-grid > button::text", "👍"],
    ["span.reaction-emoji::text", "❤️"],
    ["span.emoji-foot-glyph::text", "🎉"],
    ["button.quick-react::text", "😂"],
    ["div.emoji-picker > input::value", "Search emoji"],
    ["div.pairing-code::text", "RIVER-4821"],
  ];
  const m = withTextPurposes(
    measurement({ texts: cases.map(([s, t]) => ({ ...text(s!), text: t! })) }),
  );
  expect(cases.map(([s]) => m.textContexts![s!]!.kind)).toEqual([
    "emoji",
    "emoji",
    "emoji",
    "emoji",
    "interface",
    "code",
  ]);
});
