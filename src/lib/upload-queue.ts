/**
 * Process-wide serial upload queue.
 *
 * Clip uploads run a full pipeline (download → ffmpeg 9:16 crop → publish to
 * YouTube/TikTok). The download leg in particular can hammer shared external
 * services — notably the single alive Piped download instance
 * (api.piped.private.coffee). Running several clip pipelines in parallel
 * overwhelmed that instance into HTTP 500s, so all uploads are serialized
 * here: only ONE clip pipeline runs at a time; any additional accepted
 * uploads line up and run in FIFO order as the previous one finishes.
 *
 * The queue lives at module scope so it is shared across the whole process and
 * survives individual request handlers. Enqueuing is synchronous and cheap —
 * it just pushes an entry and (re)starts the drain loop — so the HTTP handler's
 * 202 background contract is preserved: enqueuing never awaits the pipeline.
 *
 * Concurrency is exactly 1: the drain loop is a simple async mutex/`running`
 * flag; a second `drain()` call while one is in flight returns immediately and
 * the in-flight loop picks up the new entry when it re-checks the queue.
 *
 * Resilience: each job is awaited inside its own try/catch, so a job that
 * rejects is logged and skipped while the rest of the queue keeps running.
 * No job rejection can deadlock the loop or drop the remaining entries.
 */

interface QueueEntry {
  id: number;
  task: () => Promise<void>;
}

let entries: QueueEntry[] = [];
let running = false;
let counter = 0;

function logQueued(id: number): void {
  console.log(`[ClipFlow] Upload queued (#${id}, waiting)`);
}

function logStarting(id: number): void {
  console.log(`[ClipFlow] Upload starting (#${id})`);
}

/**
 * Enqueue an upload task and return its job id.
 *
 * The task's arguments (body + backgroundCookie) are captured by the caller's
 * closure AT ENQUEUE TIME — never read later — so a later job's TikTok
 * refresh-token rotation can never leak into an already-queued job.
 *
 * Does not await the task: the caller (handleUploadClip) returns its 202
 * straight away regardless of queue length.
 */
export function enqueueUpload(task: () => Promise<void>): number {
  const id = ++counter;
  entries.push({ id, task });
  logQueued(id);
  void drain();
  return id;
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (entries.length > 0) {
      const entry = entries.shift()!;
      logStarting(entry.id);
      try {
        await entry.task();
      } catch (err) {
        // A rejected job must never deadlock or drop the remaining queue.
        console.error(
          `[ClipFlow] Upload #${entry.id} crashed before handling:`,
          err
        );
      }
    }
  } finally {
    running = false;
  }
}

/* ── Test helpers (no-op in production) ── */

/** Number of jobs currently enqueued and waiting (not yet started). */
export function queuedCount(): number {
  return entries.length;
}

/** True while one job is actively running. */
export function isQueueRunning(): boolean {
  return running;
}

/** True when the queue has no waiting jobs and is not running one. */
export function isQueueIdle(): boolean {
  return !running && entries.length === 0;
}

/** Drop all waiting (not-yet-started) jobs. Never interrupts a running job. */
export function resetUploadQueue(): void {
  entries = [];
}
