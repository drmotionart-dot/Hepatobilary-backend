import { describe, expect, it } from "vitest";
import { defaultDayType, slotAppliesOnDay, toDayStart } from "../lib/day-type";
import type { RoleSlotDefinition } from "../lib/models/types";

function slot(partial: Partial<RoleSlotDefinition>): RoleSlotDefinition {
  return {
    dayType: "normal",
    personType: "intern",
    shiftType: "long",
    category: "none",
    label: "test",
    ...partial,
  };
}

describe("day-type defaults (spec 3.13)", () => {
  it("maps Thursday to clinic", () => {
    const thu = new Date(2026, 7, 6); // a Thursday in local time
    expect(thu.getDay()).toBe(4);
    expect(defaultDayType(thu)).toEqual({ dayType: "clinic", surgeryOverlay: false });
  });

  it("maps Sunday and Wednesday to normal + surgery overlay", () => {
    const sun = new Date(2026, 7, 2);
    const wed = new Date(2026, 7, 5);
    expect(sun.getDay()).toBe(0);
    expect(wed.getDay()).toBe(3);
    expect(defaultDayType(sun)).toEqual({ dayType: "normal", surgeryOverlay: true });
    expect(defaultDayType(wed)).toEqual({ dayType: "normal", surgeryOverlay: true });
  });

  it("maps everything else to plain normal", () => {
    const mon = new Date(2026, 7, 3);
    expect(mon.getDay()).toBe(1);
    expect(defaultDayType(mon)).toEqual({ dayType: "normal", surgeryOverlay: false });
  });

  it("toDayStart zeroes the clock", () => {
    const d = toDayStart(new Date(2026, 7, 3, 14, 30, 45));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });
});

describe("slotAppliesOnDay — the single slot-applicability rule", () => {
  const resolved = (dayType: "normal" | "clinic" | "emergency", surgeryOverlay = false) => ({ dayType, surgeryOverlay });

  it("applies a matching-dayType slot", () => {
    expect(slotAppliesOnDay(slot({ dayType: "clinic" }), resolved("clinic"), new Date(2026, 7, 3))).toBe(true);
  });

  it("does not apply a slot on a non-matching day type", () => {
    expect(slotAppliesOnDay(slot({ dayType: "clinic" }), resolved("normal"), new Date(2026, 7, 3))).toBe(false);
  });

  it("adds surgery-partial normal slots on overlay days", () => {
    const surgery = slot({ dayType: "normal", shiftType: "surgery-partial" });
    expect(slotAppliesOnDay(surgery, resolved("normal", true), new Date(2026, 7, 3))).toBe(true);
  });

  it("respects weekday restrictions (e.g. Friday-only ward prep)", () => {
    const fri = new Date(2026, 7, 7);
    expect(fri.getDay()).toBe(5);
    const wardPrep = slot({ dayType: "normal", category: "ward-prep", weekdays: [5] });
    expect(slotAppliesOnDay(wardPrep, resolved("normal"), fri)).toBe(true);
    expect(slotAppliesOnDay(wardPrep, resolved("normal"), new Date(2026, 7, 6))).toBe(false);
  });
});
