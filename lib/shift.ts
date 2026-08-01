// Shift model (spec §6): a 24-hour shift starts and ends at 08:00 local time.
export const SHIFT_START_HOUR = 8;

// Calendar date key (YYYY-MM-DD) in LOCAL time, matching how the frontend keys
// roster days. Shift dates are stored at local midnight and would otherwise
// serialize a day early in UTC, so we always key on local date parts.
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The date (at local midnight) of the shift currently in effect. Before 08:00
// the previous day's 24-hour shift (08:00 → 08:00) is still on the clock, so
// "on shift now" resolves to yesterday's roster.
export function activeShiftDate(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (now.getHours() < SHIFT_START_HOUR) d.setDate(d.getDate() - 1);
  return d;
}
