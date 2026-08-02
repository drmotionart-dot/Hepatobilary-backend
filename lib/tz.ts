// Department timezone. Every shift/roster/day-type date in this app is keyed in
// the hospital's wall clock, NOT the server's (Vercel runs UTC). Node's Date
// local-time methods re-read process.env.TZ on every call, so setting it here —
// at module load, before any route/script does date math — makes ALL of
// `getHours()/setHours()/getDate()/getDay()` in this codebase operate in the
// department zone.
//
// Africa/Cairo is UTC+2/+3 with DST (Egypt reinstated DST in 2023), handled
// automatically by the IANA database. Override with DEPARTMENT_TZ if the
// department is elsewhere.
export const DEPARTMENT_TZ = process.env.DEPARTMENT_TZ || "Africa/Cairo";
process.env.TZ = DEPARTMENT_TZ;
