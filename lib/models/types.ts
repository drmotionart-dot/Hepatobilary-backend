// Type definitions mirroring section 3 of HPB_App_Build_Spec.md.
// Keep this file in sync with the spec — it's the single source of truth
// for what a document in each collection looks like.

import type { ObjectId } from "mongodb";

export type Role = "intern" | "resident" | "admin";
export type AccountType = "self-registered" | "bulk-generated";
export type AccountStatus = "pending-approval" | "active" | "expired" | "removed";

export interface User {
  _id?: ObjectId;
  fullName: string;
  role: Role;
  email: string;
  passwordHash: string;
  accountType: AccountType;
  status: AccountStatus;
  approvedBy?: ObjectId | null;
  approvedAt?: Date | null;
  mustChangePassword: boolean;
  expiresAt?: Date | null; // set for bulk-generated accounts: createdAt + 50 days
  rotationImportId?: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RotationImportRow {
  name: string;
  email: string;
  number: string;
  generatedUserId?: string;
  generatedPassword?: string;
  status: "created" | "error";
  errorReason?: string;
}

export interface RotationImport {
  _id?: ObjectId;
  uploadedBy: ObjectId;
  uploadedAt: Date;
  sourceFileName: string;
  rows: RotationImportRow[];
}

export type Sex = "male" | "female";

export interface Patient {
  _id?: ObjectId;
  medicalNumber: string;
  labPatientCode?: string | null; // linked once matched via LabImport, see 3.13a
  fullName: string;
  sex: Sex;
  age: number;
  createdAt: Date;
  updatedAt: Date;
}

export type EncounterType = "emergency" | "ward" | "clinic";
export type CaseType = "hernia" | "biliary" | "hepatic" | "generic";
export type EncounterStatus = "active" | "discharged" | "follow-up-pending" | "closed" | "referred-out";

export interface Encounter {
  _id?: ObjectId;
  patientId: ObjectId;
  type: EncounterType;
  caseType: CaseType;
  status: EncounterStatus;
  ward?: Sex | null;
  openedAt: Date;
  closedAt?: Date | null;
  openedBy: ObjectId;
  linkedFollowUpOf?: ObjectId | null;
}

export type NoteContext = "new-case" | "emergency-assessment" | "specialty-consult" | "follow-up";

export interface ClinicalNote {
  _id?: ObjectId;
  encounterId: ObjectId;
  context: NoteContext;
  authoredBy: ObjectId;
  presentingLine: string;
  pmhx: { condition: string; detail: string }[];
  pshx: { procedure: string; date?: Date; outcome?: string }[];
  complaint: {
    main: string;
    duration: string;
    associated: string[];
    pertinentNegatives: string[];
    bowelHabit: "normal" | "constipation" | "diarrhea";
    dysuria: boolean;
    viralHepatitis: { hcv: boolean; hbv: boolean; hiv: boolean };
  };
  generalExam: {
    consciousness: "A" | "confused" | "obtunded";
    bp: string;
    hr: number;
    ecgRequired: boolean;
    ecgDone: boolean;
    echoRequired: boolean;
    echoDone: boolean;
  };
  localExam: { templateUsed: CaseType; fields: Record<string, unknown> };
  riskFactors: Record<string, unknown>;
  investigationsOrdered: string[];
  recommendation: string;
  treatmentOrders: string[];
  createdAt: Date;
}

export interface CaseTypeTemplateField {
  fieldKey: string;
  label: string;
  type: "text" | "boolean" | "select";
  options?: string[];
}

export interface CaseTypeTemplate {
  _id?: ObjectId;
  name: string;
  leChecklist: CaseTypeTemplateField[];
  riskFactorChecklist: { fieldKey: string; label: string }[];
  labPanelPreset: string[];
  dietInstruction: string;
  active: boolean;
}

export type LabCategory =
  | "CBC" | "RFTs" | "Electrolytes" | "LiverFTs" | "Coagulation"
  | "CardiacE" | "Virology" | "Thyroid" | "SepsisP" | "Others";

export interface LabResultEntry {
  date: Date;
  category: LabCategory;
  test: string;
  value: string;
}

export interface LabPanel {
  _id?: ObjectId;
  encounterId: ObjectId;
  results: LabResultEntry[];
}

export interface LabTestNameMapping {
  _id?: ObjectId;
  externalTestName: string;
  internalTestKey: string;
  category: LabCategory;
}

export interface LabImportExtractedTest {
  externalTestName: string;
  result: string;
  unit?: string;
  refRange?: string;
  category?: LabCategory;
}

export interface LabImport {
  _id?: ObjectId;
  sourceFileName: string;
  patientCode: string;
  matchedPatientId?: ObjectId | null;
  matchedEncounterId?: ObjectId | null;
  requestDate: Date;
  extractedTests: LabImportExtractedTest[];
  status: "matched" | "needs-review";
  importedBy: ObjectId;
  importedAt: Date;
}

export interface ImagingRequest {
  _id?: ObjectId;
  encounterId: ObjectId;
  modality: "CT" | "US" | "Doppler" | "MRI" | "X-ray" | "Mammography";
  modalityDetail: string;
  clinicalDiagnosis: string;
  pertinentClinicalData: string;
  partToBeExamined: string;
  aimOfExamination: string;
  requestedBy: ObjectId;
  requestedAt: Date;
  status: "requested" | "scheduled" | "resulted";
  appointment?: { date: Date; time: string; instructions: string } | null;
  result?: string | null;
  resultAttachedAt?: Date | null;
}

export interface ReferralConsult {
  _id?: ObjectId;
  encounterId: ObjectId;
  toSpecialty: string;
  reason: string;
  referredBy: ObjectId;
  referredAt: Date;
  status: "pending" | "reviewed";
  reviewNoteId?: ObjectId | null;
}

export interface TreatmentLogEntry {
  date: Date;
  treatment: string;
  otherRecommendations: string;
  physician: ObjectId;
}

export interface TreatmentLog {
  _id?: ObjectId;
  encounterId: ObjectId;
  entries: TreatmentLogEntry[];
}

export interface OperationForm {
  _id?: ObjectId;
  encounterId: ObjectId;
  patientNo: string;
  procedureName: string;
  preOpDiagnosis: string;
  postOpDiagnosis: string;
  surgeon: ObjectId;
  assistants: ObjectId[];
  anesthesiaType: string;
  anesthetist: string;
  findings: string;
  procedureDetails: string;
  specimensSent: string[];
  estimatedBloodLoss: string;
  complications: string;
  postOpPlan: string;
  date: Date;
}

export interface DischargeForm {
  _id?: ObjectId;
  encounterId: ObjectId;
  dischargeDate: Date;
  summary: string;
  followUpRequired: boolean;
  followUpInstructions?: string | null;
  dischargedBy: ObjectId;
}

export interface FormTemplate {
  _id?: ObjectId;
  name: string;
  fields: { fieldKey: string; label: string; type: string; options?: string[] }[];
  savedToSystem: boolean;
  createdBy: ObjectId;
}

export interface FormRecord {
  _id?: ObjectId;
  encounterId: ObjectId;
  templateId: ObjectId;
  values: Record<string, unknown>;
  createdBy: ObjectId;
  createdAt: Date;
}

export type DayType = "normal" | "clinic" | "emergency";

export interface DayTypeCalendar {
  _id?: ObjectId;
  date: Date;
  dayType: DayType;
  surgeryOverlay: boolean;
}

export type ShiftType = "long" | "night" | "24hr" | "surgery-partial";
export type ShiftCategory = "ward" | "clinic" | "emergency-route" | "typing" | "none";

export interface RoleSlotDefinition {
  _id?: ObjectId;
  dayType: DayType;
  personType: "intern" | "resident";
  shiftType: ShiftType;
  category: ShiftCategory;
  label: string;
}

export interface ShiftAssignment {
  _id?: ObjectId;
  date: Date;
  roleSlotDefinitionId: ObjectId;
  userId: ObjectId | null;
  startTime?: string;
  endTime?: string;
}

export interface AuditLog {
  _id?: ObjectId;
  collection: string;
  documentId: ObjectId;
  action: "create" | "update" | "delete";
  summary: string;
  performedBy: ObjectId;
  performedAt: Date;
}
