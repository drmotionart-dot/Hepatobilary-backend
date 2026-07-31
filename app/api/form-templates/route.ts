import { requireRole } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { FormTemplate } from "@/lib/models/types";

export async function GET() {
  const session = await requireRole(["intern", "resident", "admin"]);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const templates = await db.collection<FormTemplate>("formTemplates").find().sort({ name: 1 }).toArray();
  return Response.json(templates);
}

export async function POST(req: Request) {
  const session = await requireRole(["resident", "admin"]);
  if (!session) return Response.json({ error: "Resident or admin only" }, { status: 403 });
  const userId = toObjectId((session.user as any).id);

  const body = await req.json();
  const { name, fields } = body;
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const db = await getDb();
  const doc: FormTemplate = {
    name,
    fields: fields || [],
    savedToSystem: body.savedToSystem ?? false,
    createdBy: userId,
  };
  const res = await db.collection<FormTemplate>("formTemplates").insertOne(doc);

  await logAudit({
    collection: "formTemplates",
    documentId: res.insertedId,
    action: "create",
    summary: `Created form template "${name}"`,
    performedBy: userId,
  });

  return Response.json({ ...doc, _id: res.insertedId }, { status: 201 });
}
