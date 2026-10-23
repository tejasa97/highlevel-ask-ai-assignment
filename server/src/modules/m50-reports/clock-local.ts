/** Monday (UTC) of the calendar day in an ISO timestamp, as YYYY-MM-DD. */
export function weekMonday(iso: string): string {
  const day = iso.slice(0, 10);
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  const dow = new Date(ms).getUTCDay();
  return new Date(ms - ((dow + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

/** The inclusive window of the same length immediately before `from`. */
export function previousWindow(from: string, to: string): { from: string; to: string } {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  const between = Math.round((end - start) / 86_400_000);
  const prevTo = start - 86_400_000;
  const prevFrom = prevTo - between * 86_400_000;
  return {
    from: new Date(prevFrom).toISOString().slice(0, 10),
    to: new Date(prevTo).toISOString().slice(0, 10),
  };
}
