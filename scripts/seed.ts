// Run with: npm run seed
// Populates the two "rulebook" collections that the rest of the app reads
// from — CaseTypeTemplate (section 5) and RoleSlotDefinition (section 6).
// Safe to re-run: clears and re-inserts each collection.

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import type { CaseTypeTemplate, RoleSlotDefinition, LabTestNameMapping } from "../lib/models/types";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("Missing MONGODB_URI in .env.local");

const caseTypeTemplates: CaseTypeTemplate[] = [
  {
    name: "Hernia",
    leChecklist: [
      { fieldKey: "painSiteRadiation", label: "Pain site / radiation", type: "text" },
      { fieldKey: "reducible", label: "Reducible", type: "boolean" },
      { fieldKey: "tender", label: "Tender", type: "boolean" },
      { fieldKey: "site", label: "Site", type: "text" },
      { fieldKey: "size", label: "Size", type: "text" },
      { fieldKey: "deepRingTest", label: "Deep ring test", type: "text" },
      { fieldKey: "scrotalNeckTest", label: "Scrotal neck test", type: "text" },
      { fieldKey: "oozing", label: "Oozing", type: "boolean" }
    ],
    riskFactorChecklist: [
      { fieldKey: "smoking", label: "Smoking" },
      { fieldKey: "dysuria", label: "Dysuria" },
      { fieldKey: "constipation", label: "Constipation" },
      { fieldKey: "heavyLifting", label: "Heavy lifting" },
      { fieldKey: "straining", label: "General straining" }
    ],
    labPanelPreset: ["CBC", "Urea", "Creatinine", "Sodium", "Potassium", "PT", "PTT", "INR"],
    dietInstruction: "Normal diet",
    active: true
  },
  {
    name: "Biliary",
    leChecklist: [
      { fieldKey: "painSiteRadiation", label: "Pain site / radiation", type: "text" },
      { fieldKey: "tender", label: "Tender", type: "boolean" },
      { fieldKey: "site", label: "Site", type: "text" },
      { fieldKey: "murphysSign", label: "Murphy's sign", type: "boolean" }
    ],
    riskFactorChecklist: [],
    labPanelPreset: [
      "CBC", "Urea", "Creatinine", "Sodium", "Potassium", "PT", "PTT", "INR",
      "Albumin", "TotalBilirubin", "DirectBilirubin", "AlkPhosphatase"
    ],
    dietInstruction: "Fat-free, dairy-free",
    active: true
  },
  {
    name: "Hepatic",
    leChecklist: [
      { fieldKey: "jaundice", label: "Jaundice", type: "select", options: ["absent", "mild", "moderate", "marked"] },
      { fieldKey: "ascites", label: "Ascites", type: "select", options: ["absent", "mild", "moderate", "tense"] },
      { fieldKey: "hepatomegaly", label: "Hepatomegaly (cm below costal margin)", type: "text" },
      { fieldKey: "splenomegaly", label: "Splenomegaly (cm below costal margin)", type: "text" },
      { fieldKey: "spiderNaevi", label: "Spider naevi", type: "text" },
      { fieldKey: "palmarErythema", label: "Palmar erythema", type: "boolean" },
      { fieldKey: "encephalopathyGrade", label: "Encephalopathy grade", type: "select", options: ["None", "I", "II", "III", "IV"] },
      { fieldKey: "asterixis", label: "Asterixis", type: "boolean" },
      { fieldKey: "caputMedusae", label: "Caput medusae", type: "boolean" },
      { fieldKey: "llEdema", label: "Lower limb edema", type: "boolean" },
      { fieldKey: "abdominalTenderness", label: "Abdominal tenderness / site", type: "text" }
    ],
    riskFactorChecklist: [
      { fieldKey: "alcohol", label: "Alcohol use" },
      { fieldKey: "viralHepatitis", label: "Viral hepatitis status" },
      { fieldKey: "priorDecompensation", label: "Prior decompensation episodes" },
      { fieldKey: "priorEndoscopy", label: "Prior GI endoscopy / varices history" }
    ],
    labPanelPreset: [
      "CBC", "Urea", "Creatinine", "Sodium", "Potassium", "PT", "PTT", "INR",
      "ALT", "AST", "TotalProtein", "Albumin", "TotalBilirubin", "DirectBilirubin",
      "HBsAg", "HCVAb"
    ],
    dietInstruction: "", // case-dependent — left free text, see spec section 5
    active: true
  }
];

// Section 6: shift rulebook. category "none" = no sub-split for that slot.
const roleSlotDefinitions: RoleSlotDefinition[] = [
  // Interns — Normal day
  { dayType: "normal", personType: "intern", shiftType: "long", category: "none", label: "Long intern" },
  { dayType: "normal", personType: "intern", shiftType: "night", category: "none", label: "Night intern" },
  // Interns — Clinic day (Thursday)
  { dayType: "clinic", personType: "intern", shiftType: "long", category: "none", label: "Long intern" },
  { dayType: "clinic", personType: "intern", shiftType: "long", category: "clinic", label: "Clinic intern" },
  { dayType: "clinic", personType: "intern", shiftType: "night", category: "none", label: "Night intern" },
  // Interns — Emergency day (Long + Night, each split Route/Ward/Typing)
  { dayType: "emergency", personType: "intern", shiftType: "long", category: "emergency-route", label: "Long emergency intern — Route" },
  { dayType: "emergency", personType: "intern", shiftType: "long", category: "ward", label: "Long emergency intern — Ward" },
  { dayType: "emergency", personType: "intern", shiftType: "long", category: "typing", label: "Long emergency intern — Typing" },
  { dayType: "emergency", personType: "intern", shiftType: "night", category: "emergency-route", label: "Night emergency intern — Route" },
  { dayType: "emergency", personType: "intern", shiftType: "night", category: "ward", label: "Night emergency intern — Ward" },
  { dayType: "emergency", personType: "intern", shiftType: "night", category: "typing", label: "Night emergency intern — Typing" },

  // Residents — Normal day (24hr)
  { dayType: "normal", personType: "resident", shiftType: "24hr", category: "ward", label: "Ward resident" },
  // Residents — Normal + Sun/Wed surgery overlay adds a partial slot (see DayTypeCalendar.surgeryOverlay)
  { dayType: "normal", personType: "resident", shiftType: "surgery-partial", category: "none", label: "Surgery-list resident (partial, within Long window)" },
  // Residents — Clinic day
  { dayType: "clinic", personType: "resident", shiftType: "24hr", category: "ward", label: "Ward resident" },
  { dayType: "clinic", personType: "resident", shiftType: "24hr", category: "clinic", label: "Clinic resident" },
  // Residents — Emergency day
  { dayType: "emergency", personType: "resident", shiftType: "24hr", category: "ward", label: "Ward resident" },
  { dayType: "emergency", personType: "resident", shiftType: "24hr", category: "emergency-route", label: "Emergency-route resident" }
];

// Section 3.13a: lab PDF → internal test name mapping (grows over time via admin)
const labTestNameMappings: LabTestNameMapping[] = [
  { externalTestName: "SGPT (ALT)", internalTestKey: "ALT", category: "LiverFTs" },
  { externalTestName: "SGOT (AST)", internalTestKey: "AST", category: "LiverFTs" },
  { externalTestName: "Blood Urea", internalTestKey: "Urea", category: "RFTs" },
  { externalTestName: "S. Creatinine", internalTestKey: "Creatinine", category: "RFTs" },
  { externalTestName: "Sodium (Na)", internalTestKey: "Sodium", category: "Electrolytes" },
  { externalTestName: "Potassium (K)", internalTestKey: "Potassium", category: "Electrolytes" },
  { externalTestName: "#Haemoglobin", internalTestKey: "HGB", category: "CBC" },
  { externalTestName: "WBCs", internalTestKey: "WBC", category: "CBC" },
  { externalTestName: "Platelets", internalTestKey: "PLT", category: "CBC" },
  { externalTestName: "PT", internalTestKey: "PT", category: "Coagulation" },
  { externalTestName: "PTT", internalTestKey: "PTT", category: "Coagulation" },
  { externalTestName: "INR", internalTestKey: "INR", category: "Coagulation" },
  { externalTestName: "S. Albumin", internalTestKey: "Albumin", category: "LiverFTs" },
  { externalTestName: "T. Protein", internalTestKey: "TotalProtein", category: "LiverFTs" },
  { externalTestName: "T. Bilirubin", internalTestKey: "TotalBilirubin", category: "LiverFTs" },
  { externalTestName: "D. Bilirubin", internalTestKey: "DirectBilirubin", category: "LiverFTs" },
  { externalTestName: "ALP", internalTestKey: "AlkPhosphatase", category: "LiverFTs" },
  { externalTestName: "HBsAg", internalTestKey: "HBsAg", category: "Virology" },
  { externalTestName: "HCV Ab", internalTestKey: "HCVAb", category: "Virology" }
];

async function seed() {
  const client = new MongoClient(uri as string);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "hpb");

  // Admin account — active, never expires (spec 10.1 self-registered lifecycle)
  const adminEmail = "admin@hepatobiliary.com";
  const existingAdmin = await db.collection("users").findOne({ email: adminEmail });
  if (!existingAdmin) {
    const now = new Date();
    await db.collection("users").insertOne({
      fullName: "Department Admin",
      role: "admin",
      email: adminEmail,
      passwordHash: await bcrypt.hash("admin123", 10),
      accountType: "self-registered",
      status: "active",
      approvedBy: null,
      approvedAt: now,
      mustChangePassword: false,
      expiresAt: null,
      rotationImportId: null,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`Created admin user (${adminEmail} / admin123).`);
  } else {
    console.log("Admin user already exists.");
  }

  await db.collection("caseTypeTemplates").deleteMany({});
  await db.collection("caseTypeTemplates").insertMany(caseTypeTemplates);
  console.log(`Seeded ${caseTypeTemplates.length} case type templates.`);

  await db.collection("roleSlotDefinitions").deleteMany({});
  await db.collection("roleSlotDefinitions").insertMany(roleSlotDefinitions);
  console.log(`Seeded ${roleSlotDefinitions.length} role slot definitions.`);

  const mappingsCount = await db.collection("labTestNameMappings").countDocuments();
  if (mappingsCount === 0) {
    await db.collection("labTestNameMappings").insertMany(labTestNameMappings);
    console.log(`Seeded ${labTestNameMappings.length} lab test name mappings.`);
  } else {
    console.log(`Lab test name mappings already present (${mappingsCount}).`);
  }

  await client.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
