import type { Db } from './db.js';

export type CallDeletionProof = {
  callId: string;
  gatewayGeneration: number;
  previouslyVerified: boolean;
  previouslyComplete: boolean;
};

/**
 * Reads a deletion proof only when every caller supplied identity component belongs to the
 * authenticated gateway. A missing, foreign, or stale-generation tombstone is deliberately
 * indistinguishable from an unknown resource.
 */
export async function readCallDeletionProof(
  db: Db,
  scope: {
    gatewayId: string;
    gatewayGeneration: number;
    callId: string;
    archiveId?: string;
  },
): Promise<CallDeletionProof | null> {
  const result = await db.query(
    `SELECT call_id,gateway_generation,previously_verified,previously_complete
       FROM call_deletion_tombstones
      WHERE call_id=$1 AND gateway_id=$2 AND gateway_generation=$3
        AND ($4::uuid IS NULL OR archive_id=$4)`,
    [scope.callId, scope.gatewayId, scope.gatewayGeneration, scope.archiveId ?? null],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    callId: String(row.call_id),
    gatewayGeneration: Number(row.gateway_generation),
    previouslyVerified: row.previously_verified === true,
    previouslyComplete: row.previously_complete === true,
  };
}

export function callDeletionDetails(proof: CallDeletionProof) {
  return {
    deletion: {
      callId: proof.callId,
      gatewayGeneration: proof.gatewayGeneration,
      archive: {
        previouslyVerified: proof.previouslyVerified,
        previouslyComplete: proof.previouslyComplete,
      },
    },
  };
}
