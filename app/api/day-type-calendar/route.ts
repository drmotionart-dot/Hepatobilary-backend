import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { DayType, DayTypeCalendar } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const db = await getDb();
  const filter: Record<string, unknown> = {};
  if (from && to) {
    const start = new Date(from);
    const end = new Date(to);
    end.setDate(end.getDate() + 1);
    filter.date = { $gte: start, $lt: end };
  }

  const days = await db.collection<DayTypeCalendar>("dayTypeCalendar").find(filter).sort({ date: 1 }).toArray();
  return Response.json(days);
}

export async function POST(req: Request) {
  const session = await requireRole(["admin"]);
  if (!session) return Response.json({ error: "Admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { date, dayType, surgeryOverlay } = body;
  if (!date || !["normal", "clinic", "emergency"].includes(dayType)) {
    return Response.json({ error: "date and a valid dayType are required" }, { status: 400 });
  }

  const db = await getDb();
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const existing = await db.collection<DayTypeCalendar>("dayTypeCalendar").findOne({ date: { $gte: start, $lt: end } });
  const fields: Record<string, unknown> = { dayType, surgeryOverlay: surgeryOverlay ?? false };

  if (existing) {
    await db.collection<DayTypeCalendar>("dayTypeCalendar").updateOne({ _id: existing._id }, { $set: fields });
    await logAudit({
      collection: "dayTypeCalendar",
      documentId: existing._id,
      action: "update",
      summary: `Set ${date} as ${dayType} day${surgeryOverlay ? " (+surgery)" : ""}`,
      performedBy: userId,
    });
    const updated = await db.collection<DayTypeCalendar>("dayTypeCalendar").findOne({ _id: existing._id });
    return Response.json(updated);
  }

  const doc: DayTypeCalendar = { date: start, dayType: dayType as DayType, surgeryOverlay: surgeryOverlay ?? false };
  const res = await db.collection<DayTypeCalendar>("dayTypeCalendar").insertOne(doc);
  await logAudit({
    collection: "dayTypeCalendar",
    documentId: res.insertedId,
    action: "create",
    summary: `Marked ${date} as ${dayType} day${surgeryOverlay ? " (+surgery)" : ""}`,
    performedBy: userId,
  });
  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
