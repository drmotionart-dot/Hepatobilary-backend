import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import type { LabImport, LabImportExtractedTest, LabPanel, LabTestNameMapping, Patient, Encounter } from "@/lib/models/types";

export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const db = await getDb();

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;

  const imports = await db.collection<LabImport>("labImports").find(filter).sort({ importedAt: -1 }).limit(50).toArray();

  const patientIds = imports.filter((i) => i.matchedPatientId).map((i) => i.matchedPatientId!.toString());
  const patients = patientIds.length
    ? await db.collection<Patient>("patients").find({ _id: { $in: [...new Set(patientIds)].map(toObjectId) } }).toArray()
    : [];
  const patientMap = new Map(patients.map((p) => [p._id!.toString(), p]));

  return Response.json(
    imports.map((i) => ({
      ...i,
      matchedPatient: i.matchedPatientId ? patientMap.get(i.matchedPatientId.toString()) || null : null,
    }))
  );
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = toObjectId((session.user as any).id);

  const formData = await req.formData();
  const files = formData.getAll("files") as File[];
  if (!files.length) return Response.json({ error: "No files provided" }, { status: 400 });

  const db = await getDb();
  const mappings = await db.collection<LabTestNameMapping>("labTestNameMappings").find().toArray();
  const mappingMap = new Map(mappings.map((m) => [m.externalTestName.toLowerCase().trim(), m]));

  const results: { fileName: string; status: string; message: string }[] = [];

  for (const file of files) {
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      const text = result?.text || "";
      const lines = text.split("\n").map((l: string) => l.trim()).filter(Boolean);

      const header = parseHeader(lines);
      if (!header) {
        results.push({ fileName: file.name, status: "error", message: "Could not parse PDF header" });
        continue;
      }

      const { patientCode, requestDate } = header;
      const extractedTests = parseTestTable(lines, mappingMap);

      const matchedPatient = await db.collection<Patient>("patients").findOne({ medicalNumber: patientCode });

      let matchedEncounter = null;
      let importStatus: "matched" | "needs-review" = "needs-review";
      let reviewReason: string | null = null;

      if (!matchedPatient) {
        reviewReason = "Unmatched patient code";
      } else {
        matchedEncounter = await db.collection<Encounter>("encounters")
          .findOne({ patientId: matchedPatient._id, status: "active" }, { sort: { openedAt: -1 } as any });

        if (!matchedEncounter) {
          reviewReason = "No active encounter for patient";
        } else {
          if (extractedTests.length > 0) {
            await fillLabPanel(matchedEncounter._id, requestDate, extractedTests, mappingMap, userId);
          }
          importStatus = "matched";
        }
      }

      const importDoc: LabImport = {
        sourceFileName: file.name,
        patientCode,
        matchedPatientId: matchedPatient?._id || null,
        matchedEncounterId: matchedEncounter?._id || null,
        requestDate,
        extractedTests,
        status: importStatus,
        importedBy: userId,
        importedAt: new Date(),
      };
      const res = await db.collection<LabImport>("labImports").insertOne(importDoc);

      await logAudit({
        collection: "labImports",
        documentId: res.insertedId,
        action: "create",
        summary: `Imported lab PDF ${file.name} (${patientCode}) → ${importStatus}`,
        performedBy: userId,
      });

      results.push({
        fileName: file.name,
        status: importStatus,
        message: reviewReason || `Matched → ${matchedPatient?.fullName}`,
      });
    } catch (err: any) {
      results.push({ fileName: file.name, status: "error", message: err.message });
    }
  }

  return Response.json({
    total: results.length,
    matched: results.filter((r) => r.status === "matched").length,
    needsReview: results.filter((r) => r.status === "needs-review").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
}

function parseHeader(lines: string[]) {
  let patientCode = "";
  let requestDate: Date | null = null;

  for (const line of lines) {
    const codeMatch = line.match(/(?:Patient Code|Code|رقم المريض)\s*[:\-]\s*(\S+)/i);
    if (codeMatch) patientCode = codeMatch[1];

    const dateMatch = line.match(/(?:Request Date|Date|التاريخ)\s*[:\-]\s*(\S+)/i);
    if (dateMatch) requestDate = new Date(dateMatch[1]);
  }

  if (!patientCode) return null;
  return { patientCode, requestDate: requestDate || new Date() };
}

function parseTestTable(lines: string[], mappingMap: Map<string, LabTestNameMapping>) {
  const tests: LabImportExtractedTest[] = [];
  let inTable = false;

  for (const line of lines) {
    if (/Test\s*Result\s*Unit\s*Ref/i.test(line)) {
      inTable = true;
      continue;
    }

    if (inTable) {
      if (/^\s*-+\s*$/.test(line) || /Page\s+\d+/i.test(line)) continue;

      const parts = line.split(/\s{2,}/);
      if (parts.length >= 2) {
        const externalTestName = parts[0].trim();
        const result = parts[1]?.trim() || "";
        const unit = parts[2]?.trim() || "";
        const refRange = parts.slice(3).join(" ").trim();
        const mapped = mappingMap.get(externalTestName.toLowerCase());

        tests.push({
          externalTestName,
          result,
          unit,
          refRange,
          category: mapped?.category || "Others",
        });
      }
    }
  }

  return tests;
}

async function fillLabPanel(
  encounterId: any,
  date: Date,
  tests: LabImportExtractedTest[],
  mappingMap: Map<string, LabTestNameMapping>,
  userId: any
) {
  const mappedResults = tests
    .filter((t) => mappingMap.has(t.externalTestName.toLowerCase()))
    .map((t) => {
      const mapping = mappingMap.get(t.externalTestName.toLowerCase())!;
      return {
        date,
        category: mapping.category,
        test: mapping.internalTestKey,
        value: t.result,
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
    const dateStr = date.toDateString();
    const existingKeys = new Set(
      (panel.results || []).filter((r) => new Date(r.date).toDateString() === dateStr).map((r) => r.test)
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
