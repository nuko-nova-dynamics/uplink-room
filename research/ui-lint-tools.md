# UI lint tool research

Checked on 2026-11-06 before implementation. Versions and dates below came from `pnpm view <package> version` and `pnpm view <package> time --json`, not from search snippets.

| Package        | Latest  | Published  |
| -------------- | ------- | ---------- |
| stylelint      | 18.0.0  | 2026-11-03 |
| [@biomejs/biome](https://registry.npmjs.org/@biomejs/biome) | 2.6.5   | 2026-11-04 |
| lightningcss   | 1.33.0  | 2026-07-20 |
| css-tree       | 3.2.1   | 2026-03-05 |
| oxlint         | 1.91.0  | 2026-11-03 |
| oxc-parser     | 0.157.0 | 2026-11-02 |
| svg-path-bbox  | 2.1.0   | 2024-09-03 |

## CSS candidates

[Stylelint plugins](https://stylelint.io/developer-guide/plugins/) receive a PostCSS tree, so all six requested rules are expressible, including matching a focus replacement to an outline suppression and checking a side border's width and color. Its [built-in rules](https://stylelint.io/user-guide/rules/) cover important declarations and property/value restrictions; the token, scale, focus and stripe rules still need custom code.

[Biome plugins](https://biomejs.dev/linter/plugins/) now support CSS through GritQL and JavaScript. [The GritQL reference](https://biomejs.dev/reference/gritql/) explicitly lists `language css`. A live 2.6.5 probe matched `outline: none` and emitted a diagnostic. JavaScript plugins can walk the CSS tree and express all six rules, including cross-selector checks. They remain Developer Preview with possible breaking changes in patch releases. The old claim that Biome plugins cannot inspect CSS is no longer true. Use `rules.preset`, since `rules.recommended` is deprecated in this release.

[Lightning CSS custom transforms](https://lightningcss.dev/transforms.html) expose rules, declarations, selectors, lengths, colors and times to JavaScript. All six checks are possible with a visitor. Its normalized AST expands shorthands and has rule-level locations; reconstructing authored declarations for precise diagnostics adds work.

[CSSTree](https://github.com/csstree/csstree) is a maintained CSS parser, walker and grammar matcher, not a ready-made lint CLI. A small checker can express all six rules without normalization, preserving declaration locations and authored values. This is the selected CSS engine.

## Measurements and choice

The checkout has nine renderer CSS files. An isolated temporary project installed the exact candidate versions. Six sequential passes parsed those same files. No app, Electron or browser was launched.

| Candidate            | Warm pass median, ms | Work measured                                                |
| -------------------- | -------------------: | ------------------------------------------------------------ |
| CSSTree 3.2.1        |                 8.44 | Parse and walk every node                                    |
| Stylelint 18.0.0     |                10.69 | Parse and check important declarations and transition values |
| Lightning CSS 1.33.0 |                17.95 | Parse and export the complete visitor AST to JS              |
| Biome 2.6.5          |                104.1 | Full CLI process with a working CSS GritQL rule              |

These are infrastructure probes, not identical implementations of all six rules. CSSTree was fastest at exposing the authored tree needed by this checker, so use it directly instead of adding another lint framework. The full implemented checker and root command are timed separately in the completion report. No timing claim is based on a package's marketing benchmark.

## TSX and icons

The repo pins oxlint 1.90.0; the latest registry release is 1.91.0. A live fixture against the pinned binary confirmed `react/button-has-type`, `jsx-a11y/click-events-have-key-events`, `jsx-a11y/no-static-element-interactions` and `jsx-a11y/control-has-associated-label`: each emitted its expected diagnostic. Keep the repo's pin because an upgrade is unnecessary for this work. See the [rule reference](https://oxc.rs/docs/guide/usage/linter/rules.html).

[Oxlint JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html) support ESLint-style visitors. A local plugin reporting from `JSXOpeningElement` ran successfully in 1.90.0. Use that API for inline SVG, emoji icons, inline pixel styles, icon size and the icon geometry check; no production reparse is needed. [Oxc parser](https://oxc.rs/docs/guide/usage/parser) 0.157.0 supplies the same ESTree shape for unit tests only. [svg-path-bbox](https://github.com/mondeja/svg-path-bbox) 2.1.0 computes path extrema including Bezier curves and arcs; tests include an arc that crosses the viewBox. Filled shapes have no stroke inset, and stroked shapes include half their stroke width.

The runner is Node ESM and uses platform-aware process invocation. File discovery uses Node filesystem APIs. No shell glob, bash script or POSIX path assumption is required by `pnpm lint` or `pnpm lint:baseline`.

## Design plan before code

This is a refinement of the desktop's Operate surface. Keep Atkinson Hyperlegible Next for UI text and Mono for code, the existing graphite grounds (#151619, #0c0d0f, #1d1f23), lilac accent (#a98bf5), primary text (#ebecee) and neutral focus treatment in both themes. Keep row alignment, spacing and control geometry. Restore a neutral visible ring where a later rule suppresses keyboard focus, and normalize the wheel icon's 1.6 stroke to the family's 1.5. Keyboard and label fixes preserve the existing visible content. Any further visible change will be listed in the completion report. No decorative borders, emoji icon replacements, cards or motion are added.
