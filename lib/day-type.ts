import "@/lib/tz";
import { getDb } from "@/lib/mongodb";
import type { DayType, DayTypeCalendar, RoleSlotDefinition } from "@/lib/models/types";

// Day-type resolution (spec 3.13). The DayTypeCalendar is the source of truth
// once set; unset dates fall back to weekday rules:
//   - Thursday        → clinic
//   - Sunday/Wednesday→ normal + surgeryOverlay
//   - everything else → normal
// Every roster/calendar resolver must go through here so bulk-generate,
// self-book, roster/board, export, import and the dashboard agree.

export interface ResolvedDayType {
  date: Date;
  dayType: DayType;
  surgeryOverlay: boolean;
}

// Local weekday of a date (0 = Sunday … 6 = Saturday).
function localDayOfWeek(d: Date): number {
  return d.getDay();
}

export function defaultDayType(date: Date): { dayType: DayType; surgeryOverlay: boolean } {
  const dow = localDayOfWeek(date);
  if (dow === 4) return { dayType: "clinic", surgeryOverlay: false }; // Thursday
  if (dow === 0 || dow === 3) return { dayType: "normal", surgeryOverlay: true }; // Sunday / Wednesday
  return { dayType: "normal", surgeryOverlay: false };
}

// Dates are stored at UTC midnight; resolve for the LOCAL calendar day.
export function toDayStart(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

// One or many dates. Returns stored calendar entries merged with weekday
// defaults for any date missing from the calendar.
export async function resolveDayTypes(dates: Date[]): Promise<ResolvedDayType[]> {
  if (dates.length === 0) return [];
  const starts = dates.map(toDayStart);
  const db = await getDb();
  const entries = await db
    .collection<DayTypeCalendar>("dayTypeCalendar")
    .find({ date: { $in: starts } })
    .toArray();
  const byKey = new Map<string, DayTypeCalendar>();
  for (const e of entries) byKey.set(e.date.toISOString(), e);

  return starts.map((date) => {
    const stored = byKey.get(date.toISOString());
    if (stored) {
      return { date, dayType: stored.dayType, surgeryOverlay: stored.surgeryOverlay };
    }
    return { date, ...defaultDayType(date) };
  });
}

export async function resolveDayType(date: Date): Promise<ResolvedDayType> {
  const [resolved] = await resolveDayTypes([date]);
  return resolved!;
}

// Whether a role-slot definition applies on a given resolved calendar day.
// Every resolver that maps slots onto dates — dashboard "on shift" counts, the
// calendar card's per-day assigned counts, and the roster board — must use this
// so they always agree (spec 6). A slot applies when its base dayType matches
// the resolved day type, or when the day carries the surgery overlay and the
// slot is a surgery-partial (the Sun/Wed surgery-list addition); a
// weekday-restricted slot (e.g. ward-prep on Fridays) only applies on its
// listed weekdays.
export function slotAppliesOnDay(
  slot: RoleSlotDefinition,
  resolved: { dayType: DayType; surgeryOverlay: boolean },
  date: Date
): boolean {
  const weekdayOk =
    !Array.isArray(slot.weekdays) || slot.weekdays.length === 0 || slot.weekdays.includes(date.getDay());
  // Base dayType match requires the weekday check too (mirrors the roster
  // board's daySlots filter).
  if (slot.dayType === resolved.dayType) return weekdayOk;
  // Surgery overlay: the board adds surgery-partial normal-day slots with NO
  // weekday restriction — keep identical so counts always agree.
  if (resolved.surgeryOverlay && slot.dayType === "normal" && slot.shiftType === "surgery-partial") return true;
  return false;
}
