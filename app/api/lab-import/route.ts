import { requireSession } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { logAudit } from "@/lib/audit";
import { toObjectId } from "@/lib/api";
import { fillLabPanel, normalizeName } from "@/lib/lab-panel";
import type { LabImport, LabImportExtractedTest, LabTestNameMapping, Patient, Encounter } from "@/lib/models/types";

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
  const mappingMap = new Map(mappings.map((m) => [normalizeName(m.externalTestName), m]));

  const results: { fileName: string; status: string; message: string }[] = [];

  for (const file of files) {
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const parsePdf = (await import("pdf-parse")).default;
      const result = await parsePdf(buffer);
      const text = result?.text || "";
      const lines = text
        .split("\n")
        .map((l: string) => l.trim())
        .filter((l) => l && /[A-Za-z0-9%]/.test(l));

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
      const diag = (err?.stack || err?.message || String(err)).split("\n").slice(0, 6).join(" ~ ");
      results.push({ fileName: file.name, status: "error", message: `${err?.message} | node ${process.version} | ${diag}` });
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

// The PDF layout is value-above-label in the header (e.g. "679053" above
// "Patient Code"), and each panel uses a different table orientation:
//  - Chemistry/Coagulation: name → [H/L marker] → value → unit → ref range
//  - CBC: name+value glued on one line → unit → [H/L marker] → ref range
// Arabic labels extract as mojibake, so only ASCII lines are parsed.
const REF_RANGE_RE = /^[\d.]+\s*-\s*[\d.]+$/;
const NAME_VALUE_RE = /^([#A-Za-z][A-Za-z.\s#]*?)(\d+(?:\.\d+)?)$/;

function stripHash(name: string): string {
  return name.replace(/^#/, "").trim();
}

function parseHeader(lines: string[]) {
  let patientCode = "";
  let requestDate: Date | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^Patient Code$/i.test(line)) {
      const prev = lines[i - 1] || "";
      const next = lines[i + 1] || "";
      if (/^\d+$/.test(prev)) patientCode = prev;
      else if (/^\d+$/.test(next)) patientCode = next;
    }
    const dateMatch = line.match(/(\d{2}\/\d{2}\/\d{4})\s+\d{1,2}:\d{2}/);
    if (dateMatch && !requestDate) {
      const [d, m, y] = dateMatch[1].split("/").map(Number);
      requestDate = new Date(y, m - 1, d);
    }
  }

  if (!patientCode) return null;
  return { patientCode, requestDate: requestDate || new Date() };
}

function isFooterLine(line: string): boolean {
  return (
    /^Page \d+ of \d+/i.test(line) ||
    /^Runs on analyzer/i.test(line) ||
    /^Perform Date/i.test(line) ||
    /^Review Date/i.test(line) ||
    /^Reviewed by/i.test(line) ||
    line === "DIM_II Main" ||
    line === "Xn1000 Main"
  );
}

function isRefRange(line: string): boolean {
  const t = line.trim();
  return REF_RANGE_RE.test(t) || /^\/\s*100\s*WBCs/i.test(t) || t === "()" || t === "( )";
}

interface PartialTest {
  externalTestName: string;
  result: string;
  unit: string;
  refRange: string;
  abnormal: boolean;
  abnormalFlag?: "H" | "L";
}

function startTest(line: string): PartialTest {
  const glued = line.match(/^(.*[)\]])\s*(\d+(?:\.\d+)?)$/);
  if (glued) {
    return { externalTestName: stripHash(glued[1]), result: glued[2], unit: "", refRange: "", abnormal: false };
  }
  return { externalTestName: stripHash(line), result: "", unit: "", refRange: "", abnormal: false };
}

function pushTest(
  test: PartialTest,
  tests: LabImportExtractedTest[],
  mappingMap: Map<string, LabTestNameMapping>
) {
  if (!test.result) return;
  const mapped = mappingMap.get(normalizeName(test.externalTestName));
  tests.push({
    externalTestName: test.externalTestName,
    result: test.result,
    unit: test.unit || undefined,
    refRange: test.refRange || undefined,
    category: mapped?.category || "Others",
    abnormal: test.abnormal || undefined,
    abnormalFlag: test.abnormalFlag,
  });
}

// Chemistry & Coagulation: name → [H/L] → value → unit → ref range, each on
// its own line (a trailing value may be glued to a paren-ended name).
function parseValueFirstTable(
  lines: string[],
  start: number,
  tests: LabImportExtractedTest[],
  mappingMap: Map<string, LabTestNameMapping>
) {
  let i = start + 1;
  let current: PartialTest | null = null;

  while (i < lines.length) {
    const line = lines[i];

    if (isFooterLine(line)) break;

    if (current && isRefRange(line)) {
      current.refRange = line;
      pushTest(current, tests, mappingMap);
      current = null;
      i++;
      continue;
    }

    if (line === "H" || line === "L") {
      if (current) {
        current.abnormal = true;
        current.abnormalFlag = line as "H" | "L";
      }
      i++;
      continue;
    }

    if (!current) {
      current = startTest(line);
      i++;
      continue;
    }

    if (current.result && current.unit) {
      pushTest(current, tests, mappingMap);
      current = null;
      continue;
    }

    if (!current.result && /^[\d.,\s/-]+$/.test(line)) {
      current.result = line;
      i++;
      continue;
    }

    if (current.result && !current.unit && !line.startsWith("#") && !line.includes("(")) {
      current.unit = line;
      i++;
      continue;
    }

    i++;
  }

  if (current) pushTest(current, tests, mappingMap);
}

// CBC: name and value are glued on one line (e.g. "#Haemoglobin15.2"),
// followed by unit, optional H/L marker and stray parens, then the ref range.
function parseNameFirstTable(
  lines: string[],
  start: number,
  tests: LabImportExtractedTest[],
  mappingMap: Map<string, LabTestNameMapping>
) {
  let i = start + 1;

  while (i < lines.length) {
    const line = lines[i];

    if (isFooterLine(line) || line.includes("TestResult") || line.includes("Parameter")) break;
    if (line.startsWith("(") || line.startsWith(")") || /^[\d.,]+$/.test(line)) {
      i++;
      continue;
    }

    const m = line.match(NAME_VALUE_RE);
    if (!m || m[1].trim().length < 2) {
      i++;
      continue;
    }

    const test: PartialTest = { externalTestName: stripHash(m[1]), result: m[2], unit: "", refRange: "", abnormal: false };
    i++;

    while (i < lines.length) {
      const l = lines[i];
      if (isFooterLine(l) || l.includes("TestResult") || l.includes("Parameter")) break;
      if (l === "(" || l === ")") {
        i++;
        continue;
      }
      if (l === "H" || l === "L") {
        test.abnormal = true;
        test.abnormalFlag = l as "H" | "L";
        i++;
        continue;
      }
      if (isRefRange(l)) {
        test.refRange = l;
        i++;
        break;
      }
      if (NAME_VALUE_RE.test(l)) break;
      if (!test.unit) {
        test.unit = l;
        i++;
        continue;
      }
      i++;
    }

    pushTest(test, tests, mappingMap);
  }
}

function parseTestTable(lines: string[], mappingMap: Map<string, LabTestNameMapping>) {
  const tests: LabImportExtractedTest[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("TestResult")) {
      parseValueFirstTable(lines, i, tests, mappingMap);
    } else if (line.includes("Parameter")) {
      parseNameFirstTable(lines, i, tests, mappingMap);
    }
  }
  return tests;
}
