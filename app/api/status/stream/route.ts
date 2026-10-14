import { connectDb } from "@/lib/db";
import { findOwnerSession } from "@/lib/shopAuth";
import { ownerStatus } from "@/lib/sessionView";
import { FINAL_STATUSES } from "@/models/Session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECK_MS = 1000;
const MAX_STREAM_MS = 5 * 60 * 1000; // client reconnects after this

/**
 * Live status for the uploader as a server-sent-event stream. Read with
 * fetch() (not EventSource) so the owner token can ride in the
 * Authorization header instead of a URL.
 */
export async function GET(req: Request): Promise<Response> {
  await connectDb();
  const first = await findOwnerSession(req);
  if (!first) {
    return Response.json({ error: "Session not found." }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let last = "";
      const push = async (): Promise<boolean> => {
        const session = await findOwnerSession(req);
        if (!session) return false;
        const payload = JSON.stringify(await ownerStatus(session));
        if (payload !== last) {
          last = payload;
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
        return !FINAL_STATUSES.includes(session.status);
      };

      const tick = async () => {
        try {
          const keepGoing = await push();
          if (keepGoing && Date.now() - started < MAX_STREAM_MS && !req.signal.aborted) {
            timer = setTimeout(tick, CHECK_MS);
            return;
          }
        } catch {
          // fall through and close; the client reconnects or polls
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      await tick();
    },
    cancel() {
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
