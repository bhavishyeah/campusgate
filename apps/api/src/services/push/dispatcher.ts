import { privilegedPrisma, withTenant, type Prisma } from "@campusgate/db";
import { endpointHost } from "./endpoint.js";
import { buildPushPayload } from "./payload.js";
import {
  ttlSecondsFor,
  urgencyFor,
  type NotificationCategoryOrEmergency,
  type NotificationPriority,
} from "./categories.js";
import { getPushSender } from "./index.js";
import type { PushOutcome, PushSender } from "./sender.js";

/**
 * In-process background push queue (design D7). Two FIFO queues: `urgent`
 * (EMERGENCY and HIGH priority, which includes all gate passes) and `normal`. One
 * job at a time, sends in batches of 16. Push is best effort: the in-app row is
 * the source of truth, so a lost or failed job never fails a caller. Logs carry
 * counts only; endpoints, keys and hosts are never logged.
 */

export type DeliveryResult =
  | "pushed"
  | "no_device"
  | "muted"
  | "inactive"
  | "failed"
  | "dropped"
  | "skipped_read";

export interface DeliveryEvent {
  notificationId: string;
  userId: string;
  result: DeliveryResult;
}

export interface PushJobItem {
  notificationId: string;
  userId: string;
}

export interface PushJobMessage {
  title: string;
  body: string;
  url?: string;
  category: NotificationCategoryOrEmergency;
  priority: NotificationPriority;
  ts: number;
  push?: { title?: string; body?: string };
}

export interface PushJob {
  institutionId: string;
  items: PushJobItem[];
  msg: PushJobMessage;
  /** 429 re-enqueue counter. Independent of visAttempt (F6). */
  attempt: number;
  /** Row-visibility retry counter, 0 to 5. Independent of attempt (F6). */
  visAttempt: number;
  runAt: number;
  /** When set, only these subscription ids are considered (re-queued remainder). */
  subIds?: string[];
  onDelivery?: (events: DeliveryEvent[]) => void | Promise<void>;
}

export type NewPushJob = Omit<PushJob, "attempt" | "visAttempt" | "runAt" | "subIds"> &
  Partial<Pick<PushJob, "attempt" | "visAttempt" | "runAt">>;

export interface PushLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface DispatcherDeps {
  sender: () => PushSender;
  runTenant: <T>(institutionId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  institutionActive: (institutionId: string) => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: PushLogger;
}

export const MAX_PENDING_ITEMS = 100_000;
export const SEND_BATCH = 16;
export const VIS_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 48_000];
const MAX_VIS_ATTEMPT = 5;
const PRUNE_FAILURES = 8;
const PRUNE_AFTER_MS = 7 * 24 * 3_600_000;
const MAX_RETRY_AFTER_SEC = 60;
const INSTITUTION_TTL_MS = 60_000;

/** Skip a device for `min(15 min * 2^(failureCount-3), 24 h)` after its last failure once it has failed 3 times. */
export function backoffMs(failureCount: number): number {
  if (failureCount < 3) return 0;
  return Math.min(15 * 60_000 * 2 ** (failureCount - 3), 24 * 3_600_000);
}

const consoleLog: PushLogger = {
  info: (o, m) => console.info(m ?? "push", o),
  warn: (o, m) => console.warn(m ?? "push", o),
  error: (o, m) => console.error(m ?? "push", o),
};

function createInstitutionActiveCache(now: () => number): (id: string) => Promise<boolean> {
  const cache = new Map<string, { active: boolean; at: number }>();
  return async (id) => {
    const hit = cache.get(id);
    if (hit && now() - hit.at < INSTITUTION_TTL_MS) return hit.active;
    const inst = await privilegedPrisma.institution.findUnique({ where: { id }, select: { status: true } });
    const active = inst?.status === "ACTIVE";
    cache.set(id, { active, at: now() });
    return active;
  };
}

interface SubRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failureCount: number;
  lastFailureAt: Date | null;
  user: { accountStatus: string };
}

export class PushDispatcher {
  private readonly urgent: PushJob[] = [];
  private readonly normal: PushJob[] = [];
  private urgentItems = 0;
  private normalItems = 0;
  private pumping: Promise<void> | null = null;
  private stopping = false;
  private current: Promise<void> | null = null;
  private lastOverflowWarnAt = 0;
  readonly pausedUntilByHost = new Map<string, number>();
  private deps: DispatcherDeps;

  constructor(deps: Partial<DispatcherDeps> = {}) {
    const now = deps.now ?? Date.now;
    this.deps = {
      sender: deps.sender ?? getPushSender,
      runTenant: deps.runTenant ?? ((id, fn) => withTenant(id, fn)),
      institutionActive: deps.institutionActive ?? createInstitutionActiveCache(now),
      now,
      sleep:
        deps.sleep ??
        ((ms) =>
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ms);
            t.unref?.();
          })),
      log: deps.log ?? consoleLog,
    };
  }

  configure(deps: Partial<DispatcherDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  pendingItems(): number {
    return this.urgentItems + this.normalItems;
  }

  /** Test helper: resolves when the pump has nothing left to do. */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  /** Resolves when the current job finishes. Does not drain the whole queue. */
  async drain(): Promise<void> {
    this.stopping = true;
    if (this.current) await this.current;
  }

  /** Never throws. A disabled sender enqueues nothing. */
  enqueue(input: NewPushJob): void {
    try {
      if (this.stopping || !this.deps.sender().isConfigured() || input.items.length === 0) return;
      const job: PushJob = {
        ...input,
        attempt: input.attempt ?? 0,
        visAttempt: input.visAttempt ?? 0,
        runAt: input.runAt ?? this.deps.now(),
      };
      const isUrgent = job.msg.priority !== "NORMAL";
      const size = job.items.length;
      const total = this.pendingItems() + size;
      const overflow = isUrgent && job.msg.priority === "EMERGENCY" ? this.urgentItems + size > MAX_PENDING_ITEMS : total > MAX_PENDING_ITEMS;
      if (overflow) {
        this.warnOverflow(size);
        void this.emit(job, job.items.map((i) => ({ ...i, result: "dropped" as const })));
        return;
      }
      this.add(job, isUrgent, false);
      this.kick();
    } catch (err) {
      this.deps.log.error({ err: errMessage(err) }, "push.enqueue.failed");
    }
  }

  private add(job: PushJob, urgent: boolean, head: boolean): void {
    const q = urgent ? this.urgent : this.normal;
    if (head) q.unshift(job);
    else q.push(job);
    if (urgent) this.urgentItems += job.items.length;
    else this.normalItems += job.items.length;
  }

  private remove(job: PushJob, urgent: boolean): void {
    const q = urgent ? this.urgent : this.normal;
    const i = q.indexOf(job);
    if (i >= 0) q.splice(i, 1);
    if (urgent) this.urgentItems -= job.items.length;
    else this.normalItems -= job.items.length;
  }

  /** Re-queue work that already counted against the cap (no overflow check). */
  private requeue(job: PushJob, head: boolean): void {
    this.add(job, job.msg.priority !== "NORMAL", head);
  }

  private warnOverflow(items: number): void {
    const t = this.deps.now();
    if (t - this.lastOverflowWarnAt < 60_000 && this.lastOverflowWarnAt !== 0) return;
    this.lastOverflowWarnAt = t;
    this.deps.log.warn({ dropped: items, pending: this.pendingItems() }, "push.queue.overflow");
  }

  private kick(): void {
    if (this.pumping) return;
    this.pumping = new Promise<void>((resolve) => {
      setImmediate(() => {
        this.pump()
          .catch((err) => this.deps.log.error({ err: errMessage(err) }, "push.pump.failed"))
          .finally(() => {
            this.pumping = null;
            resolve();
            if (!this.stopping && (this.urgent.length > 0 || this.normal.length > 0)) this.kick();
          });
      });
    });
  }

  private firstDue(q: PushJob[], now: number): PushJob | undefined {
    return q.find((j) => j.runAt <= now);
  }

  private hasDueUrgent(): boolean {
    return this.firstDue(this.urgent, this.deps.now()) !== undefined;
  }

  private async pump(): Promise<void> {
    while (!this.stopping) {
      const now = this.deps.now();
      let urgent = true;
      let job = this.firstDue(this.urgent, now);
      if (!job) {
        urgent = false;
        job = this.firstDue(this.normal, now);
      }
      if (!job) {
        const all = [...this.urgent, ...this.normal];
        if (all.length === 0) return;
        const next = Math.min(...all.map((j) => j.runAt));
        await this.deps.sleep(Math.max(1, next - now));
        continue;
      }
      this.remove(job, urgent);
      this.current = this.runJob(job, urgent).catch((err) => {
        this.deps.log.error({ err: errMessage(err) }, "push.job.failed");
      });
      await this.current;
      this.current = null;
    }
  }

  private async emit(job: PushJob, events: DeliveryEvent[]): Promise<void> {
    if (!job.onDelivery || events.length === 0) return;
    try {
      await job.onDelivery(events);
    } catch (err) {
      this.deps.log.warn({ err: errMessage(err) }, "push.onDelivery.failed");
    }
  }

  private async runJob(job: PushJob, urgent: boolean): Promise<void> {
    const started = this.deps.now();
    const { institutionId } = job;
    const events: DeliveryEvent[] = [];

    if (!(await this.deps.institutionActive(institutionId))) {
      await this.emit(job, job.items.map((i) => ({ ...i, result: "inactive" as const })));
      return;
    }

    // Step 2: one read tx. Visibility check has NO read filter (F1).
    const ids = job.items.map((i) => i.notificationId);
    const userIds = [...new Set(job.items.map((i) => i.userId))];
    const noMute = job.msg.priority === "EMERGENCY" || job.msg.category === "EMERGENCY";
    const read = await this.deps.runTenant(institutionId, async (tx) => {
      const rows = await tx.notification.findMany({
        where: { id: { in: ids } },
        select: { id: true, userId: true, read: true },
      });
      const muted = noMute
        ? []
        : await tx.notificationPreference.findMany({
            where: { userId: { in: userIds }, category: job.msg.category as never, pushEnabled: false },
            select: { userId: true },
          });
      const subs = await tx.pushSubscription.findMany({
        where: { userId: { in: userIds }, ...(job.subIds ? { id: { in: job.subIds } } : {}) },
        select: {
          id: true,
          userId: true,
          endpoint: true,
          p256dh: true,
          auth: true,
          failureCount: true,
          lastFailureAt: true,
          user: { select: { accountStatus: true } },
        },
      });
      return { rows, muted, subs: subs as SubRow[] };
    });

    const visible = new Map(read.rows.map((r) => [r.id, r]));
    const missing = job.items.filter((i) => !visible.has(i.notificationId));
    if (missing.length > 0) {
      if (job.visAttempt < MAX_VIS_ATTEMPT) {
        this.requeue(
          {
            ...job,
            items: missing,
            subIds: job.subIds,
            visAttempt: job.visAttempt + 1,
            runAt: this.deps.now() + VIS_DELAYS_MS[job.visAttempt],
          },
          false,
        );
      } else {
        this.deps.log.warn({ institutionId, missing: missing.length, attempts: job.visAttempt + 1 }, "push.job.rows_missing");
        events.push(...missing.map((i) => ({ ...i, result: "dropped" as const })));
      }
    }

    const mutedUsers = new Set(read.muted.map((m) => m.userId));
    const subsByUser = new Map<string, SubRow[]>();
    for (const s of read.subs) {
      const l = subsByUser.get(s.userId);
      if (l) l.push(s);
      else subsByUser.set(s.userId, [s]);
    }

    // Classify each visible item; collect the targets to send to.
    const present = job.items.filter((i) => visible.has(i.notificationId));
    const targets: Array<{ sub: SubRow; item: PushJobItem }> = [];
    const terminal = new Map<string, DeliveryResult>(); // key = notificationId:userId
    const key = (i: PushJobItem) => `${i.notificationId}:${i.userId}`;
    const nowTs = this.deps.now();
    for (const item of present) {
      if (visible.get(item.notificationId)!.read) {
        terminal.set(key(item), "skipped_read");
        continue;
      }
      if (mutedUsers.has(item.userId)) {
        terminal.set(key(item), "muted");
        continue;
      }
      const subs = subsByUser.get(item.userId) ?? [];
      if (subs.length === 0) {
        terminal.set(key(item), job.subIds ? "failed" : "no_device");
        continue;
      }
      const active = subs.filter((s) => s.user.accountStatus === "ACTIVE");
      if (active.length === 0) {
        terminal.set(key(item), "inactive");
        continue;
      }
      let any = false;
      for (const s of active) {
        const wait = backoffMs(s.failureCount);
        if (wait > 0 && s.lastFailureAt && nowTs < s.lastFailureAt.getTime() + wait) continue;
        targets.push({ sub: s, item });
        any = true;
      }
      if (!any) terminal.set(key(item), "failed");
    }

    // Step 3: send in batches of 16.
    const sentIds: string[] = [];
    const goneIds: string[] = [];
    const failedIds: string[] = [];
    const sentItems = new Set<string>();
    const failedItems = new Set<string>();
    const deferred: Array<{ sub: SubRow; item: PushJobItem; rateLimited: boolean; until: number }> = [];
    let unauthorized = 0;
    let devices = 0;
    const sender = this.deps.sender();
    let cursor = 0;
    let yielded = false;

    while (cursor < targets.length) {
      if (!urgent && this.hasDueUrgent()) {
        yielded = true;
        break;
      }
      const batch: typeof targets = [];
      while (cursor < targets.length && batch.length < SEND_BATCH) {
        const t = targets[cursor++];
        const host = endpointHost(t.sub.endpoint);
        const until = host ? (this.pausedUntilByHost.get(host) ?? 0) : 0;
        if (until > this.deps.now()) {
          deferred.push({ ...t, rateLimited: false, until });
          continue;
        }
        batch.push(t);
      }
      if (batch.length === 0) continue;
      devices += batch.length;
      const outcomes = await Promise.all(
        batch.map(async (t): Promise<PushOutcome> => {
          const body = buildPushPayload({
            notificationId: t.item.notificationId,
            title: job.msg.title,
            body: job.msg.body,
            url: job.msg.url,
            category: job.msg.category,
            priority: job.msg.priority,
            ts: job.msg.ts,
            push: job.msg.push,
          });
          try {
            return await sender.send(
              { endpoint: t.sub.endpoint, p256dh: t.sub.p256dh, auth: t.sub.auth },
              { body, ttlSeconds: ttlSecondsFor(job.msg.priority), urgency: urgencyFor(job.msg.priority) },
            );
          } catch {
            return { status: "retry", reason: "sender_error" };
          }
        }),
      );
      batch.forEach((t, idx) => {
        const o = outcomes[idx];
        const k = key(t.item);
        switch (o.status) {
          case "sent":
            sentIds.push(t.sub.id);
            sentItems.add(k);
            break;
          case "gone":
            goneIds.push(t.sub.id);
            failedItems.add(k);
            break;
          case "retry":
            if (o.retryAfterSec !== undefined) {
              const secs = Math.min(o.retryAfterSec, MAX_RETRY_AFTER_SEC);
              const host = endpointHost(t.sub.endpoint);
              const until = this.deps.now() + secs * 1000;
              if (host) this.pausedUntilByHost.set(host, Math.max(this.pausedUntilByHost.get(host) ?? 0, until));
              if (job.attempt === 0) deferred.push({ ...t, rateLimited: true, until });
              else failedItems.add(k); // second 429: failed, no failureCount change
            } else {
              failedIds.push(t.sub.id);
              failedItems.add(k);
            }
            break;
          case "rejected":
            failedIds.push(t.sub.id);
            failedItems.add(k);
            break;
          case "unauthorized":
            unauthorized++;
            failedItems.add(k);
            break;
        }
      });
    }

    // Targets not yet sent because the job yielded to an urgent job.
    const remainder = yielded ? targets.slice(cursor) : [];

    // Step 4: one write tx.
    if (sentIds.length || goneIds.length || failedIds.length) {
      const at = new Date(this.deps.now());
      const cutoff = new Date(this.deps.now() - PRUNE_AFTER_MS);
      try {
        await this.deps.runTenant(institutionId, async (tx) => {
          if (sentIds.length) {
            await tx.pushSubscription.updateMany({
              where: { id: { in: sentIds } },
              data: { lastSuccessAt: at, failureCount: 0, lastFailureAt: null },
            });
          }
          if (goneIds.length) await tx.pushSubscription.deleteMany({ where: { id: { in: goneIds } } });
          if (failedIds.length) {
            await tx.pushSubscription.updateMany({
              where: { id: { in: failedIds } },
              data: { failureCount: { increment: 1 }, lastFailureAt: at },
            });
            await tx.pushSubscription.deleteMany({
              where: {
                id: { in: failedIds },
                failureCount: { gte: PRUNE_FAILURES },
                OR: [{ lastSuccessAt: { lt: cutoff } }, { lastSuccessAt: null, createdAt: { lt: cutoff } }],
              },
            });
          }
        });
      } catch (err) {
        this.deps.log.error({ err: errMessage(err) }, "push.job.write_failed");
      }
    }

    if (unauthorized > 0) {
      this.deps.log.error({ institutionId, devices: unauthorized }, "push.vapid_rejected");
    }

    // Re-queue deferred (paused host / first 429) and unsent (yield) targets.
    const requeueGroups = new Map<string, { sub: SubRow; item: PushJobItem }[]>();
    const deferredRunAt = new Map<string, number>();
    for (const d of deferred) {
      const g = d.rateLimited ? "rl" : "pause";
      const k = `${g}`;
      const l = requeueGroups.get(k) ?? [];
      l.push(d);
      requeueGroups.set(k, l);
      deferredRunAt.set(k, Math.max(deferredRunAt.get(k) ?? 0, d.until));
    }
    for (const [g, list] of requeueGroups) {
      this.requeue(
        {
          ...job,
          items: dedupeItems(list.map((l) => l.item)),
          subIds: list.map((l) => l.sub.id),
          attempt: g === "rl" ? job.attempt + 1 : job.attempt,
          runAt: deferredRunAt.get(g) ?? this.deps.now(),
        },
        false,
      );
    }
    if (remainder.length > 0) {
      this.requeue(
        {
          ...job,
          items: dedupeItems(remainder.map((r) => r.item)),
          subIds: remainder.map((r) => r.sub.id),
          runAt: this.deps.now(),
        },
        true,
      );
    }

    // Step 6: events for items finished in this run.
    const pending = new Set<string>();
    for (const d of deferred) pending.add(key(d.item));
    for (const r of remainder) pending.add(key(r.item));
    for (const item of present) {
      const k = key(item);
      if (pending.has(k)) continue;
      const t = terminal.get(k);
      if (t) events.push({ ...item, result: t });
      else events.push({ ...item, result: sentItems.has(k) ? "pushed" : "failed" });
    }
    await this.emit(job, events);

    this.deps.log.info(
      {
        institutionId,
        jobItems: job.items.length,
        devices,
        sent: sentIds.length,
        gone: goneIds.length,
        failed: failedIds.length + unauthorized,
        muted: mutedUsers.size,
        ms: this.deps.now() - started,
      },
      "push.job",
    );
  }
}

function dedupeItems(items: PushJobItem[]): PushJobItem[] {
  const seen = new Set<string>();
  const out: PushJobItem[] = [];
  for (const i of items) {
    const k = `${i.notificationId}:${i.userId}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(i);
    }
  }
  return out;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

let singleton: PushDispatcher | null = null;

export function getPushDispatcher(): PushDispatcher {
  if (!singleton) singleton = new PushDispatcher();
  return singleton;
}

/** Called once from server.ts so job logs go through the app logger. */
export function configurePushDispatcher(opts: { log: PushLogger }): PushDispatcher {
  const d = getPushDispatcher();
  d.configure({ log: opts.log });
  return d;
}

/** Test seam: replace or reset the singleton. */
export function setPushDispatcher(d: PushDispatcher | null): void {
  singleton = d;
}
