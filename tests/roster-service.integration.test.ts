// Integration tests for the Phase 3 service layer (spec 16.1): the full
// shift/roster flow against a real MongoDB spun up by mongodb-memory-server.
// The first run downloads a mongod binary; afterwards it is offline. Each run
// starts from an empty database, so no real data is ever touched.
//
// Env note: lib/mongodb reads MONGODB_URI/JWT_SECRET at module load, so they
// are set BEFORE the dynamic imports below.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";

describe("roster service layer (integration)", () => {
  let mongod: MongoMemoryServer;
  let db: import("mongodb").Db;
  let rosterRepo: typeof import("../lib/repositories/rosterRepo").rosterRepo;
  let shiftService: typeof import("../lib/services/shiftService");
  let dayTypeService: typeof import("../lib/services/dayTypeService");
  let rosterService: typeof import("../lib/services/rosterService");

  const ACTOR = new ObjectId("000000000000000000000001");
  let userId: string;
  let slotId: string;
  let dateStr: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongod.getUri("hpb-test");
    process.env.MONGODB_DB = "hpb-test";
    process.env.JWT_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";

    ({ rosterRepo } = await import("../lib/repositories/rosterRepo"));
    shiftService = await import("../lib/services/shiftService");
    dayTypeService = await import("../lib/services/dayTypeService");
    rosterService = await import("../lib/services/rosterService");
    const { getDb } = await import("../lib/mongodb");
    db = await getDb();

    // Minimal slot rulebook (bulkGenerate reads it from the DB).
    await db.collection("roleSlotDefinitions").insertMany([
      { dayType: "normal", personType: "intern", shiftType: "long", category: "none", label: "Long intern" },
      { dayType: "normal", personType: "resident", shiftType: "long", category: "none", label: "Long resident" },
      { dayType: "clinic", personType: "intern", shiftType: "long", category: "clinic", label: "Clinic intern" },
      { dayType: "normal", personType: "intern", shiftType: "surgery-partial", category: "none", label: "Surgery partial" },
      { dayType: "normal", personType: "intern", shiftType: "long", category: "ward-prep", weekdays: [5], label: "Ward prep" },
    ]);

    const userRes = await db.collection("users").insertOne({
      fullName: "QA Intern",
      role: "intern",
      loginId: "qaintern",
      phone: "10999999999",
      passwordHash: "x",
      accountType: "bulk-generated",
      status: "active",
      mustChangePassword: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    userId = userRes.insertedId.toString();

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    dateStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  });

  afterAll(async () => {
    await mongod?.stop();
  });

  it("day-type calendar: set, list, resolve", async () => {
    const { doc, status } = await dayTypeService.setDayType(db, { date: dateStr, dayType: "normal", surgeryOverlay: false }, ACTOR);
    expect(status).toBe(201);
    expect(doc.dayType).toBe("normal");

    const days = await dayTypeService.listDayTypes(db, null, null);
    expect(days.some((d) => d._id!.toString() === doc._id!.toString())).toBe(true);

    const resolved = await dayTypeService.resolveDayTypeForDate(dateStr);
    expect(resolved.dayType).toBe("normal");
  });

  it("bulk-generates slots and lists the day's assignments joined", async () => {
    const { created } = await shiftService.bulkGenerate(db, dateStr, dateStr, ACTOR);
    expect(created).toBeGreaterThan(0);

    const listed = await shiftService.listAssignments(db, dateStr);
    expect(listed.assignments).toHaveLength(created);
    expect(listed.assignments[0].slot).toBeTruthy(); // joined slot
    slotId = listed.assignments.find((a: any) => a.slot?.personType === "intern")!.roleSlotDefinitionId.toString();
  });

  it("assigns and unassigns a user via toggle", async () => {
    const { doc, status } = await shiftService.setAssignment(db, { date: dateStr, roleSlotDefinitionId: slotId, userId }, ACTOR);
    expect(status).toBe(200);
    expect(doc.userIds.some((u) => u.toString() === userId)).toBe(true);

    const { doc: removed } = await shiftService.setAssignment(db, { date: dateStr, roleSlotDefinitionId: slotId, userId }, ACTOR);
    expect(removed.userIds.some((u) => u.toString() === userId)).toBe(false);
  });

  it("marks absent (mirrors into attendance) and clears it", async () => {
    await shiftService.setAssignment(db, { date: dateStr, roleSlotDefinitionId: slotId, userId }, ACTOR);

    const absentDoc = await shiftService.markAbsent(db, { date: dateStr, roleSlotDefinitionId: slotId, userId, absentReason: "Family emergency" }, ACTOR);
    const mark = (absentDoc.absent || []).find((e) => e.userId.toString() === userId);
    expect(mark?.absentReason).toBe("Family emergency");

    const range = await (await import("../lib/shift")).dayRange(dateStr);
    const attendance = await rosterRepo.findAttendance(db, userId, range!.start);
    expect(attendance?.status).toBe("absent");
    expect(attendance?.note).toBe("Absent — Family emergency");

    const cleared = await shiftService.clearAbsent(db, { date: dateStr, roleSlotDefinitionId: slotId, userId }, ACTOR);
    expect((cleared.absent || []).some((e) => e.userId.toString() === userId)).toBe(false);
  });

  it("lets an intern self-book claim and relinquish their own slot", async () => {
    const intern = { id: userId, role: "intern" as const, name: "QA Intern", email: "", mustChangePassword: false };
    // Ensure the user is out of the slot first so the claim is a real claim.
    await shiftService.setAssignment(db, { date: dateStr, roleSlotDefinitionId: slotId, userId }, ACTOR);

    const { doc: booked, status } = await shiftService.selfBook(db, { date: dateStr, roleSlotDefinitionId: slotId }, intern);
    expect(status).toBe(200);
    expect(booked.userIds.some((u) => u.toString() === userId)).toBe(true);

    const { doc: unbooked } = await shiftService.selfBook(db, { date: dateStr, roleSlotDefinitionId: slotId }, intern);
    expect(unbooked.userIds.some((u) => u.toString() === userId)).toBe(false);
  });

  it("enforces the one-slot-per-day rule for self-booking", async () => {
    const intern = { id: userId, role: "intern" as const, name: "QA Intern", email: "", mustChangePassword: false };
    const all = await shiftService.listAssignments(db, dateStr);
    const otherSlot = all.assignments.find((a: any) => a.roleSlotDefinitionId.toString() !== slotId && a.slot?.personType === "intern");
    // Claim the primary slot, then try to claim another on the same day.
    await shiftService.selfBook(db, { date: dateStr, roleSlotDefinitionId: slotId }, intern);
    if (otherSlot) {
      await expect(
        shiftService.selfBook(db, { date: dateStr, roleSlotDefinitionId: otherSlot.roleSlotDefinitionId.toString() }, intern)
      ).rejects.toMatchObject({ status: 409 });
    }
  });

  it("builds board, today and the export grid", async () => {
    const board = await rosterService.getBoard(db);
    expect(board.users.some((u) => u._id!.toString() === userId)).toBe(true);
    expect(board.slots.length).toBeGreaterThan(0);

    const today = await rosterService.getToday(db);
    expect(typeof today.dayType).toBe("string");
    expect(Array.isArray(today.assignments)).toBe(true);

    const exp = await rosterService.buildRosterExport(db, null, null);
    expect(exp.aoa.length).toBeGreaterThan(0);
    expect(exp.aoa[0].length).toBe(5);
  });

  it("imports a Wardyati-style sheet, leaving unmatched rows for review", async () => {
    const header = ["التاريخ", "لونج (Long)", "نايت (Night)", "كلاينك (Clinic)", "تحضير عنبر (Ward prep)"];
    const aoa = [header, [dateStr, `QA Intern 10999999999`, "", "", ""], [dateStr, "Unknown Doc 09999999999", "", "", ""]];

    const imp = await rosterService.processRosterImport(db, "test.xlsx", aoa, ACTOR);
    expect(imp.summary.peopleFound).toBe(2);
    expect(imp.summary.peopleMatched).toBe(1);
    expect(imp.summary.peopleUnmatched).toBe(1);
    expect(imp.unmatched).toHaveLength(1);

    const queue = await rosterService.listReviewQueue(db);
    const found = queue.imports.find((i) => i._id!.toString() === imp.importId.toString());
    expect(found).toBeTruthy();
    expect(found!.rows).toHaveLength(1);

    // Bind the unmatched row to the known user.
    const row = found!.rows[0];
    const bound = await rosterService.resolveReviewRow(db, { importId: imp.importId.toString(), rowIndex: row.rowIndex, userId }, ACTOR);
    expect(bound.ok).toBe(true);
  });

  it("creates an account for a remaining unmatched row", async () => {
    const header = ["التاريخ", "لونج (Long)", "نايت (Night)", "كلاينك (Clinic)", "تحضير عنبر (Ward prep)"];
    const aoa = [header, [dateStr, "Brand New Person 09912345678", "", "", ""]];
    const imp = await rosterService.processRosterImport(db, "create.xlsx", aoa, ACTOR);
    expect(imp.summary.peopleUnmatched).toBe(1);

    const queue = await rosterService.listReviewQueue(db);
    const found = queue.imports.find((i) => i._id!.toString() === imp.importId.toString());
    const row = found!.rows[0];

    const result = await rosterService.createOneAccount(db, imp.importId.toString(), row.rowIndex, ACTOR);
    expect(result.ok).toBe(true);
    expect(result.account.loginId).toBeTruthy();
    expect(result.account.password).toBeTruthy();
  });
});
