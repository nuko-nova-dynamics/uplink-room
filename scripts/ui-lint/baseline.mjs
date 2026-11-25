export function countFindings(findings) {
  const counts = {};
  for (const { file, rule } of findings) {
    counts[file] ??= {};
    counts[file][rule] = (counts[file][rule] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts)
      .sort()
      .map(([file, rules]) => [file, Object.fromEntries(Object.entries(rules).sort())]),
  );
}
export function compareBaseline(current, baseline, updating = false) {
  const errors = [];
  for (const file of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    for (const rule of new Set([
      ...Object.keys(current[file] ?? {}),
      ...Object.keys(baseline[file] ?? {}),
    ])) {
      const now = current[file]?.[rule] ?? 0,
        before = baseline[file]?.[rule] ?? 0;
      if (now > before)
        errors.push(`${file}: ${rule} rose from ${before} to ${now}; fix the new violations.`);
      else if (now < before && !updating)
        errors.push(`${file}: ${rule} fell from ${before} to ${now}; run pnpm lint:baseline.`);
    }
  }
  return errors;
}
