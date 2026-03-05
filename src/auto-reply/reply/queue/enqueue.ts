import { applyQueueDropPolicy, shouldSkipQueueItem } from "../../../utils/queue-helpers.js";
import { getQueueMode } from "../../../process/queue-backend.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";
import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";

function isRunAlreadyQueued(
  run: FollowupRun,
  items: FollowupRun[],
  allowPromptFallback = false,
): boolean {
  const hasSameRouting = (item: FollowupRun) =>
    item.originatingChannel === run.originatingChannel &&
    item.originatingTo === run.originatingTo &&
    item.originatingAccountId === run.originatingAccountId &&
    item.originatingThreadId === run.originatingThreadId;

  const messageId = run.messageId?.trim();
  if (messageId) {
    return items.some((item) => item.messageId?.trim() === messageId && hasSameRouting(item));
  }
  if (!allowPromptFallback) return false;
  return items.some((item) => item.prompt === run.prompt && hasSameRouting(item));
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
): boolean {
  const queue = getFollowupQueue(key, settings);
  const dedupe =
    dedupeMode === "none"
      ? undefined
      : (item: FollowupRun, items: FollowupRun[]) =>
          isRunAlreadyQueued(item, items, dedupeMode === "prompt");

  // Deduplicate: skip if the same message is already queued.
  if (shouldSkipQueueItem({ item: run, items: queue.items, dedupe })) return false;

  queue.lastEnqueuedAt = Date.now();
  queue.lastRun = run.run;

  // Track length before drop to detect if old items were evicted
  const beforeDropLen = queue.items.length;
  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
  });
  if (!shouldEnqueue) return false;

  // If drop policy evicted old items, note this so we can resync the DB below
  const itemsWereDropped = queue.items.length < beforeDropLen;

  queue.items.push(run);

  // In persistent mode, persist queued items to SQLite to prevent loss on process crash
  if (getQueueMode() === "persistent") {
    // Snapshot the current queue for resync (must be taken synchronously before any
    // async boundary so we capture the correct in-memory state).
    const currentItems = itemsWereDropped ? [...queue.items] : null;
    void import("../../../process/queue-db.js").then(
      (queueDb) => {
        try {
          if (currentItems) {
            // Items were dropped: clear stale DB records and re-insert survivors so
            // the DB mirrors memory exactly (prevents dropped items from 'reviving'
            // on the next process restart via pending_followup recovery).
            queueDb.clearPendingFollowupsByKey(key);
            for (const item of currentItems) {
              queueDb.insertPendingFollowup(key, item);
            }
          } else {
            // No drops: append only the new item
            queueDb.insertPendingFollowup(key, run);
          }
        } catch {
          // Persistence failure should not block the in-memory queue
        }
      },
      () => {
        /* module load failed, ignore */
      },
    );
  }

  return true;
}

export function getFollowupQueueDepth(key: string): number {
  const cleaned = key.trim();
  if (!cleaned) return 0;
  const queue = FOLLOWUP_QUEUES.get(cleaned);
  if (!queue) return 0;
  return queue.items.length;
}
