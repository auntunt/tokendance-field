import { ensureWorkspaceSchema, getDb } from "../../../db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    ensureWorkspaceSchema();
    getDb().prepare("SELECT 1").get();
    return Response.json({ status: "ok", service: "tokendance-field", storage: "sqlite" });
  } catch (error) {
    return Response.json({ status: "error", error: error instanceof Error ? error.message : "health check failed" }, { status: 503 });
  }
}
