import { requireRole, toObjectId, isValidObjectId } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { Attendance, User } from "@/lib/models/types";

// GET /api/attendance?userId=… — attendance record for one user (admin/resident).
export async function GET(req: Request) {
  const session = await requireRole(["admin", "resident"]);
  if (!session) return Response.json({ error: "Admin or resident only" }, { status: 403 });

  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  if (!userId || !isValidObjectId(userId)) return Response.json({ error: "Valid userId is required" }, { status: 400 });

  const db = await getDb();
  const records = await db
    .collection<Attendance>("attendance")
    .find({ userId: toObjectId(userId) })
    .sort({ date: -1 })
    .toArray();
  return Response.json(records);
}

// POST /api/attendance — mark a user present/absent for a date (admin/resident),
// upserted per (userId, date). Absent marks carry an optional note.
export async function POST(req: Request) {
  const session = await requireRole(["admin", "resident"]);
  if (!session) return Response.json({ error: "Admin or resident only" }, { status: 403 });
  const actingId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { userId, date, status, note } = body;
  if (!userId || !isValidObjectId(userId)) return Response.json({ error: "Valid userId is required" }, { status: 400 });
  if (!date) return Response.json({ error: "date is required" }, { status: 400 });
  if (status !== "present" && status !== "absent") {
    return Response.json({ error: "status must be present or absent" }, { status: 400 });
  }

  const db = await getDb();
  const user = await db.collection<User>("users").findOne({ _id: toObjectId(userId) });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const now = new Date();

  await db.collection<Attendance>("attendance").updateOne(
    { userId: toObjectId(userId), date: day },
    {
      $set: {
        userId: toObjectId(userId),
        date: day,
        status,
        note: note || null,
        markedBy: actingId,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );

  await logAudit({
    collection: "attendance",
    documentId: toObjectId(userId),
    action: "update",
    summary: `Marked ${user.fullName} ${status} on ${day.toISOString().slice(0, 10)}${note ? ` (${note})` : ""}`,
    performedBy: actingId,
  });

  const record = await db.collection<Attendance>("attendance").findOne({ userId: toObjectId(userId), date: day });
  return Response.json(record, { status: 201 });
}
