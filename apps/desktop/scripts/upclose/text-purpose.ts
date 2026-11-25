import type { Measurement } from "./types.ts";

/** Fill semantic gaps in old captures using app-owned class and field names. */
export function withTextPurposes(m: Measurement): Measurement {
  const textContexts = { ...m.textContexts };
  for (const text of m.texts) {
    const context = textContexts[text.selector];
    // Emoji are content in the picker and reactions, not interface lettering.
    if (
      /\.(?:reaction-emoji|emoji-grid|emoji-foot-glyph|quick-react)(?![\w-])/.test(text.selector)
    ) {
      textContexts[text.selector] = { ...context, kind: "emoji" };
      continue;
    }
    // Badges, edit hints and link previews inside a message are interface text, not its reading text.
    // So are an agent's answer hint, a thread proposal's status line, and a result's file name and links.
    if (
      context?.kind === "message" &&
      /\.(?:quote-badge|badge|edit-keys|link-preview[\w-]*|agent-answer-hint|thread-proposal|agent-result-head|agent-result-links|truncate)(?![\w-])/.test(
        text.selector,
      )
    ) {
      textContexts[text.selector] = { ...context, kind: "interface" };
      continue;
    }
    if (context?.kind && context.kind !== "interface") continue;
    const path = text.selector;
    let kind: NonNullable<Measurement["textContexts"]>[string]["kind"] = "interface";
    if (
      /\.(?:cmd-word|thread-output-cmd|cli-row)(?![\w-])/.test(path) ||
      (/\.thread-fold(?![\w-])/.test(path) && !/\.state-failed(?![\w-])/.test(path))
    )
      kind = "command";
    else if (
      /\.(?:run-output-line|terminal-output)(?![\w-])/.test(path) &&
      !/\.quiet(?![\w-])/.test(path)
    )
      kind = "terminal";
    else if (
      /#(?:invite-token|pair-code-input)(?![\w-])|\.(?:secret-box|pair-code|pairing-code|link-code)(?![\w-])/.test(
        path,
      )
    )
      kind = "code";
    else if (/\.doc-source(?![\w-])/.test(path)) kind = "code";
    else if (/#a2a-url(?![\w-])|\.browser-(?:url|sugg|panel)(?![\w-])/.test(path)) kind = "url";
    else if (
      /\.mono(?![\w-])/.test(path) &&
      /\.(?:task-fact-value|t3-pairing-[\w-]+|cloud-machine[\w-]*|machine-[\w-]+|setup-steps|link-steps)(?![\w-])|settings/.test(
        path,
      )
    )
      kind = "machine-name";
    else if (
      /#(?:machine-name|cloud-name)(?![\w-])/.test(path) ||
      (/\.machine-grid(?![\w-])/.test(path) && /h3\.mono(?![\w-])/.test(path))
    )
      kind = "machine-name";
    else if (
      /\.mono(?![\w-])/.test(path) &&
      /^\d+(?:\.\d+)?(?:ms|s|m|h)(?:\s+\d+(?:ms|s|m|h))*$/.test(text.text.trim())
    )
      kind = "timer";
    else if (/\.mono(?![\w-])/.test(path) && /^[\w][\w.-]*$/.test(text.text.trim()))
      // A single machine-like token set in Mono on purpose: a machine name or a word of a command split
      // across text nodes.
      kind = "machine-name";
    textContexts[text.selector] = { ...context, kind };
  }
  return { ...m, textContexts };
}
