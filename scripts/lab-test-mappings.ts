import type { LabTestNameMapping } from "../lib/models/types";

// Section 3.13a: lab PDF → internal test name mapping (grows over time via admin).
// External names match what the lab PDF extraction produces (leading "#" is
// stripped by the parser, so mappings are stored without it).
export const labTestNameMappings: LabTestNameMapping[] = [
  { externalTestName: "SGPT (ALT)", internalTestKey: "ALT", category: "LiverFTs" },
  { externalTestName: "SGOT (AST)", internalTestKey: "AST", category: "LiverFTs" },
  { externalTestName: "Total Bilirubin", internalTestKey: "TotalBilirubin", category: "LiverFTs" },
  { externalTestName: "Alk. Phosphatase", internalTestKey: "AlkPhosphatase", category: "LiverFTs" },
  { externalTestName: "Albumin - Serum", internalTestKey: "Albumin", category: "LiverFTs" },
  { externalTestName: "Blood Urea", internalTestKey: "Urea", category: "RFTs" },
  { externalTestName: "Creatinine Serum", internalTestKey: "Creatinine", category: "RFTs" },
  { externalTestName: "BUN", internalTestKey: "BUN", category: "RFTs" },
  { externalTestName: "Sodium (Na)", internalTestKey: "Sodium", category: "Electrolytes" },
  { externalTestName: "Potassium - Serum", internalTestKey: "Potassium", category: "Electrolytes" },
  { externalTestName: "Haemoglobin", internalTestKey: "HGB", category: "CBC" },
  { externalTestName: "Haematocrit", internalTestKey: "HCT", category: "CBC" },
  { externalTestName: "M.C.V.", internalTestKey: "MCV", category: "CBC" },
  { externalTestName: "M.C.H.", internalTestKey: "MCH", category: "CBC" },
  { externalTestName: "M.C.H.C.", internalTestKey: "MCHC", category: "CBC" },
  { externalTestName: "MPV", internalTestKey: "MPV", category: "CBC" },
  { externalTestName: "RDW", internalTestKey: "RDW", category: "CBC" },
  { externalTestName: "RBCs", internalTestKey: "RBC", category: "CBC" },
  { externalTestName: "WBCs", internalTestKey: "WBC", category: "CBC" },
  { externalTestName: "Platelets", internalTestKey: "PLT", category: "CBC" },
  { externalTestName: "Basophils", internalTestKey: "Basophils", category: "CBC" },
  { externalTestName: "Eosinophils", internalTestKey: "Eosinophils", category: "CBC" },
  { externalTestName: "Neutrophils", internalTestKey: "Neutrophils", category: "CBC" },
  { externalTestName: "Lymphocytes", internalTestKey: "Lymphocytes", category: "CBC" },
  { externalTestName: "Monocytes", internalTestKey: "Monocytes", category: "CBC" },
  { externalTestName: "Staff", internalTestKey: "Staff", category: "CBC" },
  { externalTestName: "Normoblasts", internalTestKey: "Normoblasts", category: "CBC" },
  { externalTestName: "PT", internalTestKey: "PT", category: "Coagulation" },
  { externalTestName: "PTT", internalTestKey: "PTT", category: "Coagulation" },
  { externalTestName: "INR", internalTestKey: "INR", category: "Coagulation" },
  { externalTestName: "S. Albumin", internalTestKey: "Albumin", category: "LiverFTs" },
  { externalTestName: "T. Protein", internalTestKey: "TotalProtein", category: "LiverFTs" },
  { externalTestName: "D. Bilirubin", internalTestKey: "DirectBilirubin", category: "LiverFTs" },
  { externalTestName: "ALP", internalTestKey: "AlkPhosphatase", category: "LiverFTs" },
  { externalTestName: "HBsAg", internalTestKey: "HBsAg", category: "Virology" },
  { externalTestName: "HCV Ab", internalTestKey: "HCVAb", category: "Virology" }
];
