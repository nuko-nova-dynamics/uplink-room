// `vite` is not a dependency of this package, so declare the one Vite feature
// the tests use: `import.meta.glob`, which vitest compiles away.
interface ImportMeta {
  glob(patterns: string[]): Record<string, () => Promise<unknown>>;
}
