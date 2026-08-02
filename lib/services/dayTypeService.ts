// Day-type calendar business rules (spec 3.13): list with optional range,
// upsert an override, and resolve a date (stored calendar wins, weekday
// default otherwise). Resolution itself lives in lib/day-type.ts — the single
// rulebook every resolver goes through — and is reused here.

import type { Db, ObjectId } from "mongodb";
import { HttpError } from "@/lib/http";
import { logAudit } from "@/lib/audit";
import { resolveDayType } from "@/lib/day-type";
import { dayRange } from "@/lib/shift";
import { rosterRepo } from "@/lib/repositories/rosterRepo";
import type { DayType, DayTypeCalendar } from "@/lib/models/types";

export async function listDayTypes(db: Db, from: string | null, to: string | null): Promise<DayTypeCalendar[]> {
  const filter: Record<string, unknown> = {};
  if (from || to) {
    if (!from || !to) throw new HttpError(400, "from and to must both be provided");
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new HttpError(400, "Invalid date range");
    }
    end.setDate(end.getDate() + 1);
    filter.date = { $gte: start, $lt: end };
  }
  return rosterRepo.findDayTypes(db, filter);
}

export async function setDayType(
  db: Db,
  input: { date: string; dayType: unknown; surgeryOverlay?: unknown },
  actingUserId: ObjectId
): Promise<{ doc: DayTypeCalendar; status: number }> {
  const { date, dayType, surgeryOverlay } = input;
  if (!date || !["normal", "clinic", "emergency"].includes(dayType as string)) {
    throw new HttpError(400, "date and a valid dayType are required");
  }
  const range = dayRange(date);
  if (!range) throw new HttpError(400, "Invalid date");

  const fields: Record<string, unknown> = { dayType, surgeryOverlay: surgeryOverlay ?? false };

  const existing = await rosterRepo.findDayTypeForDate(db, range.start, range.end);
  if (existing) {
    await rosterRepo.updateDayType(db, existing._id!, fields);
    await logAudit({
      collection: "dayTypeCalendar",
      documentId: existing._id!,
      action: "update",
      summary: `Set ${date} as ${dayType} day${surgeryOverlay ? " (+surgery)" : ""}`,
      performedBy: actingUserId,
    });
    const updated = await rosterRepo.findDayTypeById(db, existing._id!);
    if (!updated) throw new HttpError(404, "Day type not found");
    return { doc: updated, status: 200 };
  }

  const doc: DayTypeCalendar = { date: range.start, dayType: dayType as DayType, surgeryOverlay: (surgeryOverlay ?? false) as boolean };
  const res = await rosterRepo.insertDayType(db, doc);
  await logAudit({
    collection: "dayTypeCalendar",
    documentId: res.insertedId,
    action: "create",
    summary: `Marked ${date} as ${dayType} day${surgeryOverlay ? " (+surgery)" : ""}`,
    performedBy: actingUserId,
  });
  return { doc: { ...doc, _id: res.insertedId }, status: 201 };
}

export async function resolveDayTypeForDate(dateParam: string | null) {
  if (!dateParam) throw new HttpError(400, "date is required (YYYY-MM-DD)");
  const date = new Date(`${dateParam}T00:00:00`);
  if (isNaN(date.getTime())) throw new HttpError(400, "Invalid date");
  return resolveDayType(date);
}
