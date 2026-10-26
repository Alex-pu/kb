import { listOfflineOperations, markOfflineOperationFailed, removeOfflineOperation, type OfflineOperation } from "./offline-queue";

const MAX_ATTEMPTS = 5;

export type OfflineOperationHandler = (operation: OfflineOperation) => Promise<void>;

export async function syncOfflineOperations(handler: OfflineOperationHandler): Promise<{ synced: number; failed: number }> {
  const operations = await listOfflineOperations();
  let synced = 0;
  let failed = 0;

  for (const operation of operations.filter((item) => item.status === "pending" || item.status === "failed")) {
    if (!operation.id || operation.attempts >= MAX_ATTEMPTS) {
      failed += 1;
      continue;
    }

    try {
      await handler(operation);
      await removeOfflineOperation(operation.id);
      synced += 1;
    } catch (error) {
      await markOfflineOperationFailed(operation.id, error instanceof Error ? error.message : "Offline operation failed");
      failed += 1;
    }
  }

  return { synced, failed };
}
