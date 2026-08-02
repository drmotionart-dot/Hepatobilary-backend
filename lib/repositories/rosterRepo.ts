// Repository layer for the shift/roster domain (spec 16.1): every Mongo read
// and write for the shift assignments, role-slot rulebook, day-type calendar,
// emergency pools, roster imports, plus the users/attendance reads those flows
// need. Services hold the business rules; routes never touch db.collection().

import type { Db, Filter, ObjectId, OptionalUnlessRequiredId, Sort } from "mongodb";
import type {
  Attendance,
  DayTypeCalendar,
  EmergencyDayPool,
  RoleSlotDefinition,
  RosterImport,
  ShiftAssignment,
  User,
} from "@/lib/models/types";
import { toObjectId } from "@/lib/api";

export const rosterRepo = {
  // ---- ShiftAssignment ----
  findAssignments(db: Db, filter: Filter<ShiftAssignment>, sort: Sort = { date: 1 }) {
    return db.collection<ShiftAssignment>("shiftAssignments").find(filter).sort(sort).toArray();
  },
  findAssignmentsBetween(db: Db, start: Date, end: Date) {
    return db.collection<ShiftAssignment>("shiftAssignments").find({ date: { $gte: start, $lt: end } }).toArray();
  },
  findAssignmentForSlot(db: Db, start: Date, end: Date, roleSlotDefinitionId: string) {
    return db.collection<ShiftAssignment>("shiftAssignments").findOne({
      date: { $gte: start, $lt: end },
      roleSlotDefinitionId: toObjectId(roleSlotDefinitionId),
    });
  },
  findAssignmentById(db: Db, id: ObjectId) {
    return db.collection<ShiftAssignment>("shiftAssignments").findOne({ _id: id });
  },
  findAssignmentWhereUserElsewhere(db: Db, start: Date, end: Date, userId: ObjectId) {
    return db.collection<ShiftAssignment>("shiftAssignments").findOne({
      date: { $gte: start, $lt: end },
      userIds: userId,
    });
  },
  insertAssignment(db: Db, doc: ShiftAssignment) {
    return db.collection<ShiftAssignment>("shiftAssignments").insertOne(doc as OptionalUnlessRequiredId<ShiftAssignment>);
  },
  insertManyAssignments(db: Db, docs: ShiftAssignment[]) {
    return db.collection<ShiftAssignment>("shiftAssignments").insertMany(docs as OptionalUnlessRequiredId<ShiftAssignment>[]);
  },
  updateAssignment(db: Db, id: ObjectId, update: Record<string, unknown>) {
    return db.collection<ShiftAssignment>("shiftAssignments").updateOne({ _id: id }, update as any);
  },
  setAssignmentUsers(db: Db, id: ObjectId, fields: { userIds: ObjectId[] }) {
    return db.collection<ShiftAssignment>("shiftAssignments").updateOne({ _id: id }, { $set: fields });
  },
  setAssignmentAbsent(db: Db, id: ObjectId, absent: ShiftAssignment["absent"]) {
    return db.collection<ShiftAssignment>("shiftAssignments").updateOne({ _id: id }, { $set: { absent } });
  },
  pullAssignmentAbsent(db: Db, id: ObjectId, userId: ObjectId) {
    return db.collection<ShiftAssignment>("shiftAssignments").updateOne({ _id: id }, { $pull: { absent: { userId } } });
  },
  // Import-style upsert: create the slot if missing, then add the user (if any)
  // to its duty group. Returns the document + whether it was just created.
  async upsertAssignmentUser(db: Db, date: Date, roleSlotDefinitionId: ObjectId, userId: ObjectId | null) {
    const res = await db.collection<ShiftAssignment>("shiftAssignments").findOneAndUpdate(
      { date, roleSlotDefinitionId },
      { $setOnInsert: { date, roleSlotDefinitionId }, $addToSet: userId ? { userIds: userId } : {} },
      { upsert: true, includeResultMetadata: true }
    );
    return { value: res.value, created: Boolean(res.lastErrorObject?.upserted) };
  },

  // ---- RoleSlotDefinition ----
  findRoleSlots(db: Db, filter: Filter<RoleSlotDefinition> = {}) {
    return db.collection<RoleSlotDefinition>("roleSlotDefinitions").find(filter).toArray();
  },
  findRoleSlotsByIds(db: Db, ids: ObjectId[]) {
    return db.collection<RoleSlotDefinition>("roleSlotDefinitions").find({ _id: { $in: ids } }).toArray();
  },
  findRoleSlotById(db: Db, id: string) {
    return db.collection<RoleSlotDefinition>("roleSlotDefinitions").findOne({ _id: toObjectId(id) });
  },

  // ---- DayTypeCalendar ----
  findDayTypes(db: Db, filter: Filter<DayTypeCalendar>) {
    return db.collection<DayTypeCalendar>("dayTypeCalendar").find(filter).sort({ date: 1 }).toArray();
  },
  findDayTypeForDate(db: Db, start: Date, end: Date) {
    return db.collection<DayTypeCalendar>("dayTypeCalendar").findOne({ date: { $gte: start, $lt: end } });
  },
  findDayTypeById(db: Db, id: ObjectId) {
    return db.collection<DayTypeCalendar>("dayTypeCalendar").findOne({ _id: id });
  },
  updateDayType(db: Db, id: ObjectId, fields: Record<string, unknown>) {
    return db.collection<DayTypeCalendar>("dayTypeCalendar").updateOne({ _id: id }, { $set: fields });
  },
  insertDayType(db: Db, doc: DayTypeCalendar) {
    return db.collection<DayTypeCalendar>("dayTypeCalendar").insertOne(doc as OptionalUnlessRequiredId<DayTypeCalendar>);
  },

  // ---- EmergencyDayPool ----
  findEmergencyPools(db: Db, filter: Filter<EmergencyDayPool>) {
    return db.collection<EmergencyDayPool>("emergencyDayPools").find(filter).toArray();
  },
  // Import/review-style upsert: create the pool if missing, then add the user
  // (if any). Returns the document + whether it was just created.
  async upsertPoolUser(db: Db, date: Date, shiftType: string, userId: ObjectId | null, createdBy: ObjectId) {
    const res = await db.collection<EmergencyDayPool>("emergencyDayPools").findOneAndUpdate(
      { date, shiftType: shiftType as EmergencyDayPool["shiftType"] },
      {
        $setOnInsert: { date, shiftType: shiftType as EmergencyDayPool["shiftType"], createdBy, createdAt: new Date() },
        $addToSet: userId ? { userIds: userId } : {},
      },
      { upsert: true, includeResultMetadata: true }
    );
    return { value: res.value, created: Boolean(res.lastErrorObject?.upserted) };
  },

  // ---- Users ----
  findActiveUsers(db: Db, projection?: Record<string, 0>, sort?: Sort) {
    const cursor = db.collection<User>("users").find({ status: "active" });
    if (projection) cursor.project(projection);
    if (sort) cursor.sort(sort);
    return cursor.toArray();
  },
  findAllUsers(db: Db, projection?: Record<string, 0>) {
    const cursor = db.collection<User>("users").find({});
    if (projection) cursor.project(projection);
    return cursor.toArray();
  },
  findUsersByIds(db: Db, ids: ObjectId[]) {
    return db.collection<User>("users").find({ _id: { $in: ids } }).toArray();
  },
  findUserById(db: Db, id: string, projection?: Record<string, 1>) {
    return db.collection<User>("users").findOne(
      { _id: toObjectId(id) },
      projection ? { projection } : undefined
    );
  },

  // ---- Attendance ----
  findAttendance(db: Db, userId: string, date: Date) {
    return db.collection<Attendance>("attendance").findOne({ userId: toObjectId(userId), date });
  },
  upsertAttendance(db: Db, userId: string, date: Date, set: Record<string, unknown>, setOnInsert: Record<string, unknown>) {
    return db.collection<Attendance>("attendance").updateOne(
      { userId: toObjectId(userId), date },
      { $set: set, $setOnInsert: setOnInsert },
      { upsert: true }
    );
  },

  // ---- RosterImport ----
  insertRosterImport(db: Db, doc: RosterImport) {
    return db.collection<RosterImport>("rosterImports").insertOne(doc as OptionalUnlessRequiredId<RosterImport>);
  },
  findImportsWithUnmatched(db: Db, limit = 5) {
    return db.collection<RosterImport>("rosterImports")
      .find({ "rows.status": "unmatched" })
      .sort({ uploadedAt: -1 })
      .limit(limit)
      .toArray();
  },
  findAnyImportWithUnmatched(db: Db) {
    return db.collection<RosterImport>("rosterImports").findOne({ "rows.status": "unmatched" });
  },
  findRosterImportById(db: Db, id: string) {
    return db.collection<RosterImport>("rosterImports").findOne({ _id: toObjectId(id) });
  },
  updateRosterImport(db: Db, id: ObjectId, set: Record<string, unknown>) {
    return db.collection<RosterImport>("rosterImports").updateOne({ _id: id }, { $set: set });
  },
};
