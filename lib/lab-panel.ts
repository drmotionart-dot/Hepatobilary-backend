import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import type { LabImportExtractedTest, LabPanel, LabTestNameMapping } from "@/lib/models/types";

// Shared by the lab-import (direct match) and lab-import/review (manual link)
// routes so both populate the encounter's lab panel from extracted tests.
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/^#/, "").trim();
}

export async function fillLabPanel(
  encounterId: any,
  date: Date,
  tests: LabImportExtractedTest[],
  mappingMap: Map<string, LabTestNameMapping>,
  userId: any
) {
  const mappedResults = tests
    .filter((t) => mappingMap.has(normalizeName(t.externalTestName)))
    .map((t) => {
      const mapping = mappingMap.get(normalizeName(t.externalTestName))!;
      return {
        date,
        category: mapping.category,
        test: mapping.internalTestKey,
        value: t.result,
        unit: t.unit,
        refRange: t.refRange,
        abnormal: t.abnormal,
        abnormalFlag: t.abnormalFlag,
      };
    });

  if (mappedResults.length === 0) return;

  const db = await getDb();
  const panel = await db.collection<LabPanel>("labPanels").findOne({ encounterId });

  if (!panel) {
    const res = await db.collection<LabPanel>("labPanels").insertOne({ encounterId, results: mappedResults });
    await logAudit({
      collection: "labPanels",
      documentId: res.insertedId,
      action: "create",
      summary: "Lab panel auto-filled from PDF import",
      performedBy: userId,
    });
  } else {
    const dateStr = date.toISOString().slice(0, 10);
    const existingKeys = new Set(
      (panel.results || []).filter((r) => new Date(r.date).toISOString().slice(0, 10) === dateStr).map((r) => r.test)
    );
    const newResults = mappedResults.filter((r) => !existingKeys.has(r.test));
    if (newResults.length > 0) {
      await db.collection<LabPanel>("labPanels").updateOne(
        { _id: panel._id },
        { $push: { results: { $each: newResults } } }
      );
      await logAudit({
        collection: "labPanels",
        documentId: panel._id,
        action: "update",
        summary: `Lab panel appended ${newResults.length} results from PDF import`,
        performedBy: userId,
      });
    }
  }
}
