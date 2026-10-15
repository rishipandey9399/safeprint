import { connectDb } from "@/lib/db";
import { findOwnerSession } from "@/lib/shopAuth";
import { getClientIp, rateLimit } from "@/lib/rateLimit";
import { config } from "@/lib/config";
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
// Each open stream polls the database every second, so they're capped:
// a few per session (a phone with a reconnect in flight) and per client.
const MAX_STREAMS_PER_SESSION = 3;
const globalWithStreams = global as typeof globalThis & { _openStreams?: Map<string, number> };
const openStreams = (globalWithStreams._openStreams ??= new Map<string, number>());

export async function GET(req: Request): Promise<Response> {
  if (!(await rateLimit(`status-stream:${getClientIp(req)}`, config.limits.statusStreamPerIpMinute, 60 * 1000))) {
    return Response.json({ error: "Too many requests." }, { status: 429 });
  }
  await connectDb();
  const first = await findOwnerSession(req);
  if (!first) {
    return Response.json({ error: "Session not found." }, { status: 404 });
  }
  const sid = String(first._id);
  if ((openStreams.get(sid) ?? 0) >= MAX_STREAMS_PER_SESSION) {
    // The client falls back to polling /api/status.
    return Response.json({ error: "Too many open streams." }, { status: 429 });
  }
  openStreams.set(sid, (openStreams.get(sid) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (openStreams.get(sid) ?? 1) - 1;
    if (n > 0) openStreams.set(sid, n);
    else openStreams.delete(sid);
  };

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
        release();
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
      release();
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
