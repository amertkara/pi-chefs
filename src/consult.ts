/**
 * Consult: caller-side primitive that sends a question to a chef via postman
 * and blocks until a reply on the same thread arrives (or timeout fires).
 *
 * pi-postman is fire-and-forget. To layer request/response on top, we:
 *   1. Generate a thread id unique to this consultation: chefs/<chef>/<uuid>.
 *   2. Send the question via `amq send` with that thread.
 *   3. Watch the caller's own inbox/new dir for any .md whose header has a
 *      matching `thread` and `from === chef.handle`.
 *   4. When one arrives, parse the body and resolve. Move it to cur (so it
 *      doesn't pollute the user's manual `postman_inbox` view) by issuing
 *      `amq read --me <caller-handle> --id <id>`.
 *
 * AMQ is a maildir on disk, so this works without subscribing to anything
 * AMQ-specific — same primitive pi-postman uses for live notifications.
 */

import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ConsultOptions {
  /** Caller's AMQ handle (the agent doing the asking). */
  callerHandle: string;
  /** Target chef's AMQ handle. */
  chefHandle: string;
  /** Human-readable subject summarizing the question. */
  subject: string;
  /** The question itself, full markdown. */
  body: string;
  /** Max time to wait for a reply, in milliseconds. */
  timeoutMs: number;
}

export interface ConsultResult {
  /** The reply body. */
  body: string;
  /** Reply message id (so the caller can show it in audit trails). */
  reply_id: string;
  /** Thread id (so the caller can show it). */
  thread_id: string;
  /** Wall-clock time the consult took, in milliseconds. */
  elapsed_ms: number;
}

export class ConsultTimeoutError extends Error {
  threadId: string;
  timeoutMs: number;
  constructor(threadId: string, timeoutMs: number) {
    super(
      `consult: chef did not reply within ${timeoutMs}ms (thread=${threadId}). ` +
        `The chef may be busy, sleeping, or not running. Check \`pi-chefs status\`.`,
    );
    this.threadId = threadId;
    this.timeoutMs = timeoutMs;
    this.name = "ConsultTimeoutError";
  }
}

export class AmqMissingError extends Error {
  constructor() {
    super("consult: amq binary not found in PATH. Install with `brew install avivsinai/tap/amq`.");
    this.name = "AmqMissingError";
  }
}

interface MessageHeader {
  id?: string;
  from?: string;
  to?: string[];
  thread?: string;
  subject?: string;
  kind?: string;
  priority?: string;
  created?: string;
}

function amqRoot(): string {
  return process.env.AM_ROOT ?? process.env.AMQ_GLOBAL_ROOT ?? join(homedir(), ".agent-mail");
}

function inboxNewDir(handle: string): string {
  return join(amqRoot(), "agents", handle, "inbox", "new");
}

function parseMaildirFile(path: string): MessageHeader | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const match = text.match(/^---json\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match || !match[1]) return undefined;
  try {
    return JSON.parse(match[1]) as MessageHeader;
  } catch {
    return undefined;
  }
}

function readMaildirBody(path: string): string {
  const text = readFileSync(path, "utf8");
  const match = text.match(/^---json\s*\n[\s\S]*?\n---\s*\n?/);
  return match ? text.slice(match[0].length) : text;
}

/**
 * Spawn `amq send` and resolve when it exits. Throws AmqMissingError if amq
 * is not on PATH.
 */
function amqSend(args: {
  me: string;
  to: string;
  subject: string;
  body: string;
  thread: string;
  kind: string;
  priority?: string;
}): Promise<{ id: string }> {
  return new Promise((resolveSend, rejectSend) => {
    const argv = [
      "send",
      "--me",
      args.me,
      "--to",
      args.to,
      "--subject",
      args.subject,
      "--body",
      args.body,
      "--thread",
      args.thread,
      "--kind",
      args.kind,
    ];
    if (args.priority) argv.push("--priority", args.priority);

    const child = spawn("amq", argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        rejectSend(new AmqMissingError());
        return;
      }
      rejectSend(err);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        rejectSend(new Error(`amq send failed (code=${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      // Stdout shape: "Sent <id> to <to> ..."
      const m = stdout.match(/Sent\s+(\S+)/);
      resolveSend({ id: m && m[1] ? m[1] : "(unknown)" });
    });
  });
}

function amqRead(me: string, id: string): Promise<void> {
  return new Promise((resolveRead, rejectRead) => {
    const child = spawn("amq", ["read", "--me", me, "--id", id, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (err) => rejectRead(err));
    child.on("exit", (code) => {
      // Non-zero is fine here — read just moves new→cur. Worst case the file
      // stays in new and the user's next postman_inbox shows it.
      resolveRead();
    });
  });
}

/**
 * Send a question to a chef and wait for the reply. The chef is expected to
 * reply via postman_reply (or postman_send with the same thread). We watch
 * the caller's inbox/new dir for any message on this thread from the chef.
 */
export async function consult(options: ConsultOptions): Promise<ConsultResult> {
  const threadId = `chefs/${options.chefHandle}/${randomUUID()}`;
  const callerNewDir = inboxNewDir(options.callerHandle);
  const startMs = Date.now();

  // Materialize the caller's inbox dirs up front. AMQ normally creates these
  // on the caller's first send/receive, but for a brand-new handle that has
  // never sent anything yet, fs.watch below fails with ENOENT. Creating the
  // tree (new + cur) is idempotent and safe; AMQ uses the same paths.
  try {
    mkdirSync(callerNewDir, { recursive: true });
    mkdirSync(join(amqRoot(), "agents", options.callerHandle, "inbox", "cur"), {
      recursive: true,
    });
  } catch {
    // If we can't create them, the send will fail with a clearer error.
  }

  // Snapshot existing files so we don't accidentally match historical mail
  // that happens to share a thread (shouldn't happen since we mint a fresh
  // uuid, but defense in depth).
  const seen = new Set<string>();
  try {
    for (const f of readdirSync(callerNewDir)) {
      if (f.endsWith(".md")) seen.add(f);
    }
  } catch {
    // Shouldn't happen now that we mkdir above, but tolerate.
  }

  // Send first; the post-send fs.watch is fine because the chef has to read
  // the question, react, and reply — taking at least a few hundred ms even
  // for the most prepared chef. fs.watch fires on every file event, including
  // ones that arrived between send and watch setup, since we re-scan.
  const send = await amqSend({
    me: options.callerHandle,
    to: options.chefHandle,
    subject: options.subject,
    body: options.body,
    thread: threadId,
    // AMQ enforces a fixed enum: brainstorm, review_request, review_response,
    // question, answer, decision, status, todo. 'question' is the right fit
    // for a consult — we're asking the chef something and expect an answer.
    kind: "question",
  });

  return new Promise<ConsultResult>((resolveConsult, rejectConsult) => {
    let watcher: FSWatcher | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let settled = false;

    const settle = (
      kind: "ok" | "err",
      payload: ConsultResult | Error,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (watcher) watcher.close();
      if (kind === "ok") resolveConsult(payload as ConsultResult);
      else rejectConsult(payload as Error);
    };

    const checkFile = async (filename: string): Promise<void> => {
      if (!filename.endsWith(".md")) return;
      if (seen.has(filename)) return;
      const fullPath = join(callerNewDir, filename);
      const header = parseMaildirFile(fullPath);
      if (!header) return; // partial write, will retry on next event
      if (header.thread !== threadId) {
        // Not our reply. Mark as seen so we don't re-check on every event.
        seen.add(filename);
        return;
      }
      if (header.from !== options.chefHandle) {
        // Right thread, wrong sender. Shouldn't happen but defend.
        seen.add(filename);
        return;
      }
      seen.add(filename);
      const body = readMaildirBody(fullPath);
      // Drain it to cur so the user's manual `postman_inbox` doesn't surface
      // chef plumbing they didn't ask about.
      const replyId = header.id ?? filename.replace(/\.md$/, "");
      try {
        await amqRead(options.callerHandle, replyId);
      } catch {
        // Best-effort; ignore failure.
      }
      settle("ok", {
        body: body.trimEnd(),
        reply_id: replyId,
        thread_id: threadId,
        elapsed_ms: Date.now() - startMs,
      });
    };

    try {
      watcher = fsWatch(callerNewDir, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;
        // Fire and forget — checkFile catches its own errors.
        checkFile(filename).catch(() => {});
      });
      watcher.on("error", (err: Error) => settle("err", err));
    } catch (err) {
      settle("err", err as Error);
      return;
    }

    // Race: the reply may have already arrived between send and watcher setup.
    // Re-scan once to catch that case.
    try {
      for (const f of readdirSync(callerNewDir)) {
        checkFile(f).catch(() => {});
      }
    } catch {
      // Dir may not exist yet; ignore. fs.watch above will populate it.
    }

    timeoutHandle = setTimeout(() => {
      settle("err", new ConsultTimeoutError(threadId, options.timeoutMs));
    }, options.timeoutMs);
  }).finally(() => {
    // Reference send so TS doesn't lint it as unused; also useful in audit
    // logs eventually.
    void send.id;
  });
}
