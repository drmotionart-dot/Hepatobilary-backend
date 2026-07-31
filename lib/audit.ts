import type { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import type { AuditLog } from "@/lib/models/types";

// Every write to a clinical/operational document must go through this helper
// so the system-wide audit trail (spec 3.18) stays complete.
export async function logAudit(entry: {
  collection: string;
  documentId: ObjectId;
  action: "create" | "update" | "delete";
  summary: string;
  performedBy: ObjectId;
}) {
  const doc: AuditLog = {
    ...entry,
    performedAt: new Date(),
  };
  try {
    const db = await getDb();
    await db.collection<AuditLog>("auditLogs").insertOne(doc);
  } catch (err) {
    console.error("Audit log write failed:", err);
  }
}
