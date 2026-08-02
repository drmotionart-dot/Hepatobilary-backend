// End-to-end: intern files a "report a problem" from the top bar; admin sees it
// in Admin → Problem reports with context; admin marks it resolved. Cleanup
// removes the test intern, its reports and audit rows. Requires both dev
// servers running (backend :3001, frontend :3000).

const fs = require("fs");
const path = require("path");
const { MongoClient } = require(path.resolve(__dirname, "..", "node_modules", "mongodb"));
const { SignJWT } = require(path.resolve(__dirname, "..", "node_modules", "jose"));
const { chromium } = require(path.resolve(__dirname, "..", "..", "node_modules", "playwright"));

const BACKEND_DIR = path.resolve(__dirname, "..");
const env = {};
for (const line of fs.readFileSync(path.join(BACKEND_DIR, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
if (!env.JWT_SECRET || !env.MONGODB_URI) {
  console.error("Missing JWT_SECRET or MONGODB_URI in backend .env.local");
  process.exit(1);
}

const API = "http://localhost:3001";
const WEB = "http://localhost:3000";
const secret = new TextEncoder().encode(env.JWT_SECRET);

async function mintToken({ sub, role, name, email }) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role, name: name || "", email: email || "", mustChangePassword: false })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 28800)
    .sign(secret);
}

const marker = `e2e-${Date.now()}`;
const internEmail = `e2e.${marker}@test.local`;
const internPassword = "E2ePass123!";
const internName = `E2E Intern ${marker.slice(-6)}`;
const description = `[${marker}] Ward list not updating after discharge — expected the row to disappear.`;

async function main() {
  const client = new MongoClient(env.MONGODB_URI, { maxPoolSize: 2 });
  await client.connect();
  const db = client.db(env.MONGODB_DB || "hpb");

  const admin = await db.collection("users").findOne({ role: "admin", status: "active" });
  if (!admin) throw new Error("no active admin user in DB");
  const adminToken = await mintToken({ sub: admin._id.toString(), role: "admin", name: admin.fullName, email: admin.email || "" });
  console.log("admin:", admin.fullName, admin._id.toString());

  // 1. Register a real intern (pending-approval).
  const reg = await fetch(`${API}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName: internName, email: internEmail, password: internPassword, role: "intern" }),
  });
  console.log("register:", reg.status);
  if (!reg.ok) throw new Error("register failed: " + (await reg.text()));
  const internUser = await db.collection("users").findOne({ loginId: internEmail });
  if (!internUser) throw new Error("intern not found in DB after register");
  const internId = internUser._id.toString();
  console.log("intern id:", internId);

  // 2. Approve via admin API.
  const appr = await fetch(`${API}/api/admin/users/${internId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ action: "approve" }),
  });
  console.log("approve:", appr.status);
  if (!appr.ok) throw new Error("approve failed: " + (await appr.text()));

  // 3. Real login as the intern.
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: internEmail, password: internPassword }),
  });
  const loginData = await login.json();
  console.log("login:", login.status);
  if (!login.ok) throw new Error("login failed: " + JSON.stringify(loginData));
  const internToken = loginData.token;

  const browser = await chromium.launch();
  try {
    // ---- Intern UI ----
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "token", value: internToken, domain: "localhost", path: "/" }]);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('button[title="Report a problem"]', { timeout: 120000 });
    console.log("[intern] top-bar Report button visible on /dashboard");

    await page.click('button[title="Report a problem"]');
    await page.waitForSelector('textarea[placeholder^="Describe the issue"]', { timeout: 15000 });
    const ctxUrl = await page.locator("div.rounded-lg p").first().textContent();
    console.log("[intern] context card first line:", ctxUrl.trim());
    if (!ctxUrl.includes("/dashboard")) throw new Error("context card did not capture /dashboard URL");

    await page.fill('textarea[placeholder^="Describe the issue"]', description);
    await page.getByRole("button", { name: "Send report" }).click();
    await page.waitForSelector("text=Thanks — report sent", { timeout: 20000 });
    console.log("[intern] success state shown");

    // ---- Admin UI ----
    const ctx2 = await browser.newContext();
    await ctx2.addCookies([{ name: "token", value: adminToken, domain: "localhost", path: "/" }]);
    const page2 = await ctx2.newPage();
    await page2.goto(`${WEB}/admin/problems`, { waitUntil: "domcontentloaded" });
    const row = page2.locator("tr").filter({ hasText: marker });
    await row.waitFor({ timeout: 120000 });
    const rowText = await row.textContent();
    const checks = {
      reporterName: rowText.includes(internName),
      roleIntern: rowText.includes("Intern"),
      pageUrl: rowText.includes("/dashboard"),
      statusOpen: rowText.includes("open"),
    };
    console.log("[admin] row checks:", checks);
    if (!Object.values(checks).every(Boolean)) throw new Error("admin row missing expected context: " + JSON.stringify(checks));

    // ---- Mark resolved ----
    await row.getByRole("button", { name: "Mark resolved" }).click();
    await row.getByRole("button", { name: "Reopen" }).waitFor({ timeout: 20000 });
    const afterText = await row.textContent();
    console.log("[admin] after resolve contains resolved:", afterText.includes("resolved"));
    if (!afterText.includes("resolved")) throw new Error("badge did not flip to resolved");

    console.log("E2E OK");
  } finally {
    await browser.close();
    const delReports = await db.collection("problemReports").deleteMany({ description: { $regex: marker } });
    const delUser = await db.collection("users").deleteOne({ loginId: internEmail });
    const delAudits = await db.collection("auditLogs").deleteMany({ summary: { $regex: marker } });
    console.log("cleanup:", { reports: delReports.deletedCount, user: delUser.deletedCount, audits: delAudits.deletedCount });
    await client.close();
  }
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
