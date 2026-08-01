import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";

export async function GET() {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });

  const db = await getDb();
  const [collections, users] = await Promise.all([
    db.collection("auditLogs").distinct("collection"),
    db
      .collection("users")
      .find({}, { projection: { fullName: 1 } })
      .sort({ fullName: 1 })
      .toArray(),
  ]);

  return Response.json({
    collections,
    users: users.map((u: any) => ({ _id: u._id.toString(), fullName: u.fullName })),
  });
}
