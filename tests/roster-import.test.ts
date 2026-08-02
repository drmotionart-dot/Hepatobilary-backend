import { describe, expect, it } from "vitest";
import {
  buildColumnMap,
  classifyColumn,
  dateKey,
  findHeaderRow,
  firstDateCell,
  matchUser,
  normalizeName,
  normalizePhone,
  parseDateCell,
  parseEntryLines,
  slotKey,
  slotKeyByCategory,
} from "../lib/roster-import";

describe("normalizePhone", () => {
  it("keeps digits and strips country prefixes", () => {
    expect(normalizePhone("01123456789")).toBe("01123456789");
    expect(normalizePhone("+20 112 345 6789")).toBe("1123456789");
    expect(normalizePhone("00201123456789")).toBe("1123456789");
    expect(normalizePhone("201123456789")).toBe("1123456789");
  });
});

describe("normalizeName", () => {
  it("lowercases and strips diacritics/tatweel", () => {
    expect(normalizeName("Ahmed  Hassan")).toBe("ahmed hassan");
    expect(normalizeName("محمد حسين")).toContain("محمد");
    expect(normalizeName("ABC")).toBe("abc");
  });
});

describe("parseDateCell", () => {
  it("parses ISO strings", () => {
    const d = parseDateCell("2026-08-03");
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(7);
    expect(d!.getUTCDate()).toBe(3);
  });

  it("parses dd/mm/yyyy and dd/mm/yy", () => {
    expect(parseDateCell("03/08/2026")).not.toBeNull();
    expect(parseDateCell("03/08/26")!.getUTCFullYear()).toBe(2026);
  });

  it("rejects garbage", () => {
    expect(parseDateCell("nope")).toBeNull();
    expect(parseDateCell("")).toBeNull();
    expect(parseDateCell(null)).toBeNull();
  });
});

describe("classifyColumn", () => {
  it("classifies the Wardyati columns", () => {
    expect(classifyColumn("لونج (Long)")).toEqual({ shift: "long", category: "none", emergencyRoute: false });
    expect(classifyColumn("نايت (Night)")).toEqual({ shift: "night", category: "none", emergencyRoute: false });
    expect(classifyColumn("كلاينك (Clinic)")).toEqual({ shift: "long", category: "clinic", emergencyRoute: false });
    expect(classifyColumn("تحضير عنبر (Ward prep)")).toEqual({ shift: "long", category: "ward-prep", emergencyRoute: false });
    expect(classifyColumn("Something random")).toEqual({ shift: null, category: "none", emergencyRoute: false });
  });
});

describe("parseEntryLines", () => {
  it("splits bulleted name + phone entries", () => {
    const entries = parseEntryLines("• Ahmed Hassan 01123456789\n• Sara Ali 01012345678");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: "Ahmed Hassan", phone: "01123456789" });
  });

  it("keeps a phone-only entry", () => {
    const entries = parseEntryLines("01123456789");
    expect(entries).toHaveLength(1);
    expect(entries[0].phone).toBe("01123456789");
  });

  it("ignores empty cells", () => {
    expect(parseEntryLines("")).toEqual([]);
    expect(parseEntryLines(null)).toEqual([]);
  });
});

describe("sheet-structure helpers", () => {
  it("findHeaderRow locates the header row", () => {
    const aoa = [["التاريخ", "لونج (Long)", "نايت (Night)"], ["03/08/2026", "Ahmed 01123456789", ""]];
    const { headerRow, dataStartRow } = findHeaderRow(aoa);
    expect(headerRow).toEqual(["التاريخ", "لونج (Long)", "نايت (Night)"]);
    expect(dataStartRow).toBe(1);
  });

  it("buildColumnMap maps columns to targets from the header", () => {
    const map = buildColumnMap(["التاريخ", "لونج (Long)", "كلاينك (Clinic)", "junk"]);
    expect(map).toEqual([
      { col: 1, target: { shift: "long", category: "none", emergencyRoute: false } },
      { col: 2, target: { shift: "long", category: "clinic", emergencyRoute: false } },
    ]);
  });

  it("buildColumnMap falls back to the assumed column order without a header", () => {
    expect(buildColumnMap(null)).toHaveLength(4);
  });

  it("firstDateCell finds the date in the first columns", () => {
    const cell = firstDateCell(["03/08/2026", "x", "y", "z"]);
    expect(cell).not.toBeNull();
    expect(cell!.index).toBe(0);
    expect(firstDateCell(["", "03/08/2026"])!.index).toBe(1);
  });

  it("matchUser prefers phone over name", () => {
    const phoneMap = new Map([["01123456789", "u1"]]);
    const nameMap = new Map([["ahmed hassan", "u2"]]);
    expect(matchUser("Ahmed Hassan", "01123456789", phoneMap, nameMap)).toBe("u1");
    expect(matchUser("Ahmed Hassan", "", phoneMap, nameMap)).toBe("u2");
    expect(matchUser("Nobody", "", phoneMap, nameMap)).toBeNull();
  });

  it("slotKey resolves exact then fallback, by category for ward-prep", () => {
    const slots = [
      { _id: "a" as any, dayType: "normal", shiftType: "long", category: "none" },
      { _id: "b" as any, dayType: "clinic", shiftType: "long", category: "clinic" },
    ];
    expect(slotKey(slots, "normal", "long", "none")).toBe("a");
    expect(slotKey(slots, "clinic", "long", "none")).toBe("b"); // fallback to any clinic long slot
    expect(slotKey(slots, "clinic", "night", "none")).toBeNull();
    expect(slotKeyByCategory(slots, "clinic")).toBe("b");
  });

  it("dateKey formats local calendar parts", () => {
    expect(dateKey(new Date(2026, 7, 3))).toBe("2026-08-03");
  });
});
