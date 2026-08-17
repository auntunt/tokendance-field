import { schedulerStatus } from "../../../../lib/scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(schedulerStatus());
}
