/** True when expiry is unset or still at or after `now`. A YYYY-MM-DD value lasts through that UTC day. */
export function stillOpen(expiresAt: string | null, nowIso: string): boolean {
  if (expiresAt == null) return true;
  const exp = expiresAt.length === 10 ? Date.parse(`${expiresAt}T23:59:59.999Z`) : Date.parse(expiresAt);
  return exp >= Date.parse(nowIso);
}

/** Drip: enrolledAt plus this many 24-hour days is at or before now. Zero days is immediate. */
export function released(enrolledAt: string, days: number, nowIso: string): boolean {
  if (days <= 0) return true;
  return Date.parse(enrolledAt) + days * 86_400_000 <= Date.parse(nowIso);
}

export function unlocksAt(enrolledAt: string, days: number): string {
  return new Date(Date.parse(enrolledAt) + days * 86_400_000).toISOString();
}
