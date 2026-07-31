import { requireRole } from "@/lib/api";

// GET /api/admin/users/template — generates a blank rotation template (.xlsx)
// with exactly the three columns the import step expects back: Name, Email,
// Number (spec 10.2). Pure file generation, no database read.
export async function GET() {
  const session = await requireRole(["admin"]);
  if (!session) return Response.json({ error: "Admin only" }, { status: 403 });

  const XLSX = await import("xlsx");

  const sheet = XLSX.utils.aoa_to_sheet([["Name", "Email", "Number"]]);
  sheet["!cols"] = [{ wch: 24 }, { wch: 32 }, { wch: 16 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Rotation");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  return new Response(new Uint8Array(buffer as ArrayBuffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="rotation-template.xlsx"',
    },
  });
}
