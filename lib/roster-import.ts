// Shared parsing helpers for the Wardyati rotation-roster import (spec 6.1).
// Pure functions — no DB access — so the import and review routes reuse them.

import type { ObjectId } from "mongodb";

export type ColumnTarget = {
  shift: "long" | "night" | null;
  category: "clinic" | "ward-prep" | "none";
  emergencyRoute: boolean;
};

// Keep only digits, then strip a leading country code so "0020…", "+20…" and
// "011…" all compare equal.
export function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0020")) digits = digits.slice(4);
  else if (digits.startsWith("20") && digits.length >= 12) digits = digits.slice(2);
  return digits;
}

// Lowercase, strip Arabic diacritics/tatweel, keep letters and digits.
export function normalizeName(name: string): string {
  const normalized = name
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[^a-z0-9\u0600-\u06FF]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.toLowerCase();
}

// Excel serial number, ISO string, or dd/mm/yyyy string -> Date (UTC midnight) or null.
export function parseDateCell(value: unknown): Date | null {
  if (value == null || value === "") return null;

  if (typeof value === "number") {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (isNaN(date.getTime())) return null;
    return date;
  }

  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  const str = String(value).trim();
  if (!str) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(str) || /^\d{4}\/\d{2}\/\d{2}/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  const m = str.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    return isNaN(date.getTime()) ? null : date;
  }

  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

export function classifyColumn(header: string): ColumnTarget {
  const h = normalizeName(header);
  if (!h) return { shift: null, category: "none", emergencyRoute: false };

  if (h.includes("تحضير") || h.includes("عنبر") || h.includes("prep") || h.includes("wardprep")) {
    return { shift: "long", category: "ward-prep", emergencyRoute: false };
  }
  if (h.includes("كلاينك") || h.includes("عيادة") || h.includes("عياده") || h.includes("clinic")) {
    return { shift: "long", category: "clinic", emergencyRoute: false };
  }

  const isNight = h.includes("نايت") || h.includes("ليل") || h.includes("ليلي") || h.includes("night");
  const isLong = h.includes("لونج") || h.includes("لونق") || h.includes("لونك") || h.includes("long");
  const emergencyRoute = h.includes("طرقة") || h.includes("طرفة") || h.includes("طرقه") || h.includes("route") || h.includes("emergency") || h.includes("اسعاف") || h.includes("إسعاف");

  if (!isNight && !isLong) return { shift: null, category: "none", emergencyRoute };
  return { shift: isNight ? "night" : "long", category: "none", emergencyRoute };
}

type Entry = { name: string; phone: string };

// Split a cell into bulleted "name + phone" entries.
export function parseEntryLines(cell: unknown): Entry[] {
  if (cell == null || cell === "") return [];
  const raw = String(cell).trim();
  if (!raw) return [];

  const parts = raw.split(/[\r\n•·‣◦●\-–—،؛]+/).map((p) => p.trim()).filter(Boolean);
  const entries: Entry[] = [];

  for (const part of parts) {
    const cleaned = part.replace(/^[•·‣◦●\s.\-–—()]+/, "").trim();
    if (!cleaned) continue;

    const phoneMatch = cleaned.match(/\+?[\d][\d\s\-()]{7,14}\d/);
    const phone = phoneMatch ? normalizePhone(phoneMatch[0]) : "";
    let name = phoneMatch ? cleaned.replace(phoneMatch[0], "") : cleaned;
    name = name.replace(/^[•·‣◦●\s.\-–—()]+/, "").trim();

    // A cell with only numbers and no name is still worth keeping.
    if (!name && !phone) continue;
    entries.push({ name, phone });
  }

  return entries;
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- sheet-structure helpers (pure, shared by import + review flows) ----

// Locate the header row (a row where column 0 is not a date and the columns
// classify as shift columns), returning it plus the first data row index.
export function findHeaderRow(aoa: unknown[][]): { headerRow: string[] | null; dataStartRow: number } {
  const lookback = Math.min(aoa.length, 6);
  for (let i = 0; i < lookback; i++) {
    const row = aoa[i];
    if (!row || row.every((c) => c == null || String(c).trim() === "")) continue;
    const first = String(row[0] || "").trim();
    const firstIsDate = parseDateCell(row[0]) !== null;
    if (!firstIsDate) {
      const rest = row.slice(1).map((c) => String(c || "").trim()).filter(Boolean);
      const looksLikeHeader = /^(التاريخ|اليوم|date|day)/i.test(first) || rest.some((c) => classifyColumn(c).shift !== null);
      if (looksLikeHeader) {
        return { headerRow: row.map((c) => String(c || "").trim()), dataStartRow: i + 1 };
      }
    }
  }
  return { headerRow: null, dataStartRow: 0 };
}

export function buildColumnMap(headerRow: string[] | null): { col: number; target: ColumnTarget }[] {
  if (headerRow) {
    return headerRow
      .slice(1)
      .map((h, i) => ({ col: i + 1, target: classifyColumn(h) }))
      .filter((c) => c.target.shift !== null || c.target.category !== "none");
  }
  // No header row — assume the Wardyati column order: Long, Night, Clinic, Ward prep.
  return [
    { col: 1, target: { shift: "long", category: "none", emergencyRoute: false } },
    { col: 2, target: { shift: "night", category: "none", emergencyRoute: false } },
    { col: 3, target: { shift: "long", category: "clinic", emergencyRoute: false } },
    { col: 4, target: { shift: "long", category: "ward-prep", emergencyRoute: false } },
  ];
}

export function firstDateCell(row: unknown[]): { date: Date; index: number } | null {
  for (let i = 0; i < Math.min(row.length, 4); i++) {
    const d = parseDateCell(row[i]);
    if (d) return { date: d, index: i };
  }
  return null;
}

// Resolve a sheet entry to a known user id: phone first (normalized), name as
// fallback. Returns null when neither matches.
export function matchUser(name: string, phone: string, phoneMap: Map<string, string>, nameMap: Map<string, string>): string | null {
  if (phone) {
    const hit = phoneMap.get(normalizePhone(phone));
    if (hit) return hit;
  }
  if (name) {
    const nk = normalizeName(name);
    if (nk) {
      const hit = nameMap.get(nk);
      if (hit) return hit;
    }
  }
  return null;
}

export interface SlotLike {
  _id?: ObjectId;
  dayType: string;
  shiftType: string;
  category: string;
}

// The exact slot id for a (dayType, shift, category) triple, falling back to
// any slot of that dayType+shift when the exact category slot is missing.
export function slotKey(slots: SlotLike[], dayType: string, shift: string | null, category: string): ObjectId | null {
  if (!shift) return null;
  const exact = slots.find((s) => s.dayType === dayType && s.shiftType === shift && s.category === category);
  if (exact) return exact._id || null;
  return slots.find((s) => s.dayType === dayType && s.shiftType === shift)?._id || null;
}

export function slotKeyByCategory(slots: SlotLike[], category: string): ObjectId | null {
  return slots.find((s) => s.category === category)?._id || null;
}

export function targetCategoryLabel(target: ColumnTarget): string {
  if (target.category === "ward-prep") return "slot:ward-prep";
  if (target.category === "clinic") return `slot:${target.shift}-clinic`;
  return `slot:${target.shift}`;
}
