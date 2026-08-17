/**
 * Tell whether a finalized GenLayer transaction actually succeeded.
 *
 * This is not obvious from the top level of a receipt, and getting it wrong is
 * silent. A transaction whose contract call reverted finalizes exactly like one
 * that worked:
 *
 *   status       7                 (FINALIZED)
 *   result_name  "MAJORITY_AGREE"  — the validators agreed... that it failed
 *
 * The execution outcome lives in the leader receipt inside `consensus_data`,
 * and the revert reason — the contract's own `gl.vm.UserError` text — is its
 * `result.payload`:
 *
 *   execution_result  "ERROR"
 *   result.status     "rollback"
 *   result.payload    "[EXPECTED] malformed signature for 0x1111… on stage 1"
 *
 * These scripts previously compared `receipt.txExecutionResultName` against
 * `ExecutionResult.FINISHED_WITH_ERROR`. No such key exists on the receipt, so
 * the comparison was always false and every revert was reported as a success.
 */

type LeaderReceipt = {
  execution_result?: string;
  result?: { status?: string; payload?: unknown };
};

function leaderReceipt(receipt: unknown): LeaderReceipt | null {
  const data = (receipt as { consensus_data?: { leader_receipt?: unknown } } | null)
    ?.consensus_data?.leader_receipt;
  const first = Array.isArray(data) ? data[0] : data;
  return first && typeof first === "object" ? (first as LeaderReceipt) : null;
}

/**
 * The contract's revert reason, or null if the transaction executed cleanly.
 *
 * Returns null when the receipt has no leader receipt to read: an unknown shape
 * is not evidence of failure, and callers verify the resulting state anyway.
 */
export function executionError(receipt: unknown): string | null {
  const leader = leaderReceipt(receipt);
  if (!leader) return null;

  const failed =
    leader.execution_result === "ERROR" || leader.result?.status === "rollback";
  if (!failed) return null;

  const payload = leader.result?.payload;
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return "contract execution reverted";
}
