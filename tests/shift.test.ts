import { describe, expect, it } from "vitest";
import { SHIFT_START_HOUR, activeShiftDate, dayRange, localDateKey } from "../lib/shift";

describe("shift model (spec §6)", () => {
  it("defines the 08:00 shift boundary", () => {
    expect(SHIFT_START_HOUR).toBe(8);
  });

  it("keys a date in local calendar parts", () => {
    const d = new Date(2026, 7, 3, 23, 59); // local
    expect(localDateKey(d)).toBe("2026-08-03");
    expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("resolves the active shift to the previous day before 08:00", () => {
    expect(activeShiftDate(new Date(2026, 7, 3, 7, 59))).toEqual(new Date(2026, 7, 2, 0, 0, 0, 0));
  });

  it("resolves the active shift to the same day from 08:00 on", () => {
    expect(activeShiftDate(new Date(2026, 7, 3, 8, 0))).toEqual(new Date(2026, 7, 3, 0, 0, 0, 0));
    expect(activeShiftDate(new Date(2026, 7, 3, 12, 0))).toEqual(new Date(2026, 7, 3, 0, 0, 0, 0));
    expect(activeShiftDate(new Date(2026, 7, 3, 0, 0))).toEqual(new Date(2026, 7, 2, 0, 0, 0, 0));
  });

  it("dayRange builds a local-midnight [start, end) window", () => {
    const range = dayRange("2026-08-03");
    expect(range).not.toBeNull();
    expect(range!.start.getFullYear()).toBe(2026);
    expect(range!.start.getMonth()).toBe(7);
    expect(range!.start.getDate()).toBe(3);
    expect(range!.start.getHours()).toBe(0);
    expect(range!.end.getTime() - range!.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("dayRange returns null for an unparseable date", () => {
    expect(dayRange("not-a-date")).toBeNull();
    expect(dayRange("")).toBeNull();
  });
});
