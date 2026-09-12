/**
 * A plain left-aligned text table for CLI listings.
 *
 * Deliberately minimal: the fleet listing in `agentbox list` has its own
 * width-budgeting, hyperlinking renderer, and the commands here need none of
 * that. Assumes plain text — no ANSI, so no escape-aware width accounting.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => pad(c, widths[i]!))
      .join('  ')
      .trimEnd() + '\n';
  process.stdout.write(line(headers));
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
  for (const r of rows) process.stdout.write(line(r));
}
