import type { Locator } from "@playwright/test";

/** Inspect rules on the rendered box, including inherited rules, without forcing pseudo-classes. */
export async function stateRules(target: Locator) {
  return target.evaluate((root) => {
    const matches: {
      state: string;
      rule: string;
      trigger: string;
      focusable: boolean;
      properties: string[];
    }[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
        if (!(rule instanceof CSSStyleRule)) continue;
        const properties = Array.from(rule.style);
        if (properties.length && properties.every((p) => p.startsWith("scrollbar"))) continue;
        for (const state of ["hover", "active", "focus-visible", "disabled", "expanded"]) {
          const token =
            state === "expanded"
              ? /\[aria-expanded=["']?true["']?\]/
              : new RegExp(`:${state}(?![\\w-])`);
          for (const part of rule.selectorText.split(/,(?![^()]*\))/)) {
            const index = part.search(token);
            if (index < 0 || /:not\([^)]*$/.test(part.slice(0, index))) continue;
            const plain = part.replace(token, "");
            try {
              if (!root.matches(plain.trim() || "*")) continue;
              // The selector before the pseudo-class names the element receiving input.
              const triggerSelector = part.slice(0, index).trim() || "*";
              const trigger = root.closest(triggerSelector) ?? root;
              if (state === "expanded" && !trigger.hasAttribute("aria-expanded")) continue;
              const focusable =
                !trigger.matches(":disabled,[aria-disabled=true]") &&
                trigger.matches(
                  'button,input,textarea,select,a[href],[tabindex]:not([tabindex="-1"])',
                );
              matches.push({
                state: state === "active" ? "pressed" : state === "expanded" ? "open" : state,
                rule: part.trim(),
                trigger: triggerSelector,
                focusable,
                properties,
              });
            } catch {
              /* Selectors containing nested dynamic pseudos are recorded by their own capture. */
            }
          }
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch {
        /* Cross-origin font styles do not contain app states. */
      }
    }
    return matches;
  });
}
