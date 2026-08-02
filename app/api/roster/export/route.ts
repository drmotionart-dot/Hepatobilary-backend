import { requireCapability } from "@/lib/api";
import { getDb } from "@/lib/mongodb";
import { handleRoute } from "@/lib/http";
import { buildRosterExport } from "@/lib/services/rosterService";
import { dateKey } from "@/lib/roster-import";

// GET /api/roster/export?from=YYYY-MM-DD&to=YYYY-MM-DD — regenerate a
// Wardyati-style .xlsx (one row per day, one column per shift slot) from the
// current assignments/pools, for a printable/offline copy (spec 6.1 step 4).
// The service builds the grid (aoa); this route renders the workbook.
export async function GET(req: Request) {
  const session = await requireCapability("manage-roster");
  if (!session) return Response.json({ error: "Requires the manage-roster capability" }, { status: 403 });

  return handleRoute(async () => {
    const url = new URL(req.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");

    const db = await getDb();
    const { aoa, from, to } = await buildRosterExport(db, fromParam, toParam);

    const XLSX = await import("xlsx");
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet["!cols"] = [{ wch: 16 }, { wch: 40 }, { wch: 40 }, { wch: 40 }, { wch: 40 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Roster");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const lastDay = new Date(new Date(to).getTime() - 86400000);
    return new Response(new Uint8Array(buffer as ArrayBuffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="roster-${dateKey(from)}-${dateKey(lastDay)}.xlsx"`,
      },
    });
  });
}
