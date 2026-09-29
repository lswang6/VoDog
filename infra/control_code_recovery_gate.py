"""Read-only, narrowly scoped code-deployment preflight for an explicitly named failed attempt."""
from uuid import UUID


def validate_expired_ack_evidence(evidence):
    if not isinstance(evidence, dict) or evidence.get('schemaVersion') != 1:
        raise ValueError('expired ACK evidence must use schemaVersion 1')
    call_id = str(UUID(str(evidence.get('callId'))))
    generation = evidence.get('generation')
    reported = evidence.get('reportedSequence')
    commands = evidence.get('commands')
    if isinstance(generation, bool) or not isinstance(generation, int) or generation <= 0:
        raise ValueError('generation must be a positive integer')
    if isinstance(reported, bool) or not isinstance(reported, int) or reported < 0:
        raise ValueError('reportedSequence must be a non-negative integer')
    if not isinstance(commands, list) or not 2 <= len(commands) <= 10:
        raise ValueError('commands must contain a bounded complete unreported segment')
    normalized = []
    seen = set()
    for offset, item in enumerate(commands, 1):
        if not isinstance(item, dict):
            raise ValueError('each command evidence item must be an object')
        command_id = str(UUID(str(item.get('id'))))
        if command_id in seen:
            raise ValueError('command IDs must be unique')
        seen.add(command_id)
        sequence = item.get('sequence')
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence != reported + offset:
            raise ValueError('commands must exactly cover the contiguous unreported segment')
        kind, status, reason = item.get('kind'), item.get('serverStatus'), item.get('serverReason')
        if (kind, status, reason) not in {
            ('dial', 'rejected', 'media_capability_withdrawn'),
            ('dial', 'expired', 'expired'),
            ('answer', 'expired', 'expired'),
            ('hangup', 'expired', 'expired'),
        }:
            raise ValueError('unsupported server command evidence')
        ack = item.get('deviceAck')
        if ack is not None:
            if not isinstance(ack, dict) or ack.get('generation') != generation or ack.get('status') != 'rejected' \
                    or ack.get('telecomState') is not None or ack.get('phase') != 'not_executed' \
                    or ack.get('reason') != 'command_expired' or not isinstance(ack.get('attemptCount'), int) \
                    or ack.get('attemptCount') <= 0 or ack.get('lastFailureCode') != 'http_4xx' \
                    or 'executedAt' not in ack or ack.get('executedAt') is not None \
                    or 'deviceCallId' not in ack or ack.get('deviceCallId') is not None \
                    or status != 'expired':
                raise ValueError('device ACK outbox evidence is not exact non-execution evidence')
        normalized.append({'id': command_id, 'sequence': sequence, 'kind': kind,
                           'status': status, 'reason': reason, 'hasAck': ack is not None})
    expired = [item for item in normalized if item['status'] == 'expired']
    if not expired or not expired[0]['hasAck']:
        raise ValueError('the first server-expired command must have real device outbox evidence')
    return {'callId': call_id, 'generation': generation, 'reportedSequence': reported,
            'commands': normalized}


def quiescence_query(recovery_call=None, *, reconcile_expired_pending=False, expired_ack_evidence=None):
    eligible = 'SELECT NULL::uuid AS id WHERE false'
    if expired_ack_evidence is not None:
        if recovery_call is not None or reconcile_expired_pending:
            raise ValueError('expired ACK evidence is a separate recovery mode')
        proof = validate_expired_ack_evidence(expired_ack_evidence)
        call_id, generation, reported = proof['callId'], proof['generation'], proof['reportedSequence']
        values = ','.join(
            f"('{item['id']}'::uuid,{item['sequence']}::bigint,'{item['kind']}'::text,'{item['status']}'::text,'{item['reason']}'::text)"
            for item in proof['commands'])
        last_sequence = proof['commands'][-1]['sequence']
        eligible = f"""
          SELECT c.id FROM call_records c
          JOIN gateways g ON g.id=c.gateway_id AND g.device_epoch=c.generation
          JOIN gateway_call_locks l ON l.call_id=c.id AND l.gateway_id=c.gateway_id AND l.generation=c.generation
          JOIN gateway_telecom_snapshots s ON s.gateway_id=c.gateway_id AND s.generation=c.generation
          WHERE c.id='{call_id}'::uuid AND c.generation={generation}::bigint
            AND c.state='unknown' AND c.direction='outgoing'
            AND c.device_call_id IS NULL AND c.answered_at IS NULL AND c.ended_at IS NULL
            AND s.local_busy=false AND s.calls='[]'::jsonb
            AND s.reported_sequence={reported}::bigint AND g.command_sequence={last_sequence}::bigint
            AND s.observed_at BETWEEN now()-interval '30 seconds' AND now()+interval '5 seconds'
            AND s.updated_at>=now()-interval '30 seconds'
            AND NOT EXISTS (
              WITH expected(id,sequence,kind,status,reason) AS (VALUES {values})
              SELECT 1 FROM expected e LEFT JOIN commands cmd ON cmd.id=e.id
              WHERE cmd.id IS NULL OR cmd.call_id IS DISTINCT FROM c.id OR cmd.gateway_id IS DISTINCT FROM c.gateway_id
                OR cmd.generation IS DISTINCT FROM c.generation OR cmd.sequence IS DISTINCT FROM e.sequence
                OR cmd.kind IS DISTINCT FROM e.kind OR cmd.status IS DISTINCT FROM e.status
                OR cmd.result IS DISTINCT FROM jsonb_build_object('reason',e.reason)
                OR cmd.expires_at>=now() OR cmd.expires_at>=s.observed_at
            )
            AND (SELECT count(*) FROM commands cmd WHERE cmd.call_id=c.id)={len(proof['commands'])}
            AND (SELECT count(*) FROM commands cmd WHERE cmd.gateway_id=c.gateway_id
              AND cmd.generation=c.generation AND cmd.sequence>{reported} AND cmd.sequence<={last_sequence})={len(proof['commands'])}
        """
    elif recovery_call is not None:
        call_id = str(UUID(str(recovery_call)))
        command_acceptance = """cmd.status='rejected'
                AND COALESCE(cmd.result->>'phase','not_executed') IN ('not_executed','rejected')
                AND COALESCE((cmd.kind='dial' AND cmd.result->>'reason'='media_capability_withdrawn')
                  OR (cmd.kind='hangup' AND cmd.result->>'reason'='call_not_found')
                  OR (cmd.kind IN ('dial','hangup')
                    AND cmd.result->>'phase'='not_executed'
                    AND cmd.result->>'reason'='command_expired'),false)"""
        if reconcile_expired_pending:
            command_acceptance = """(cmd.kind='dial' AND cmd.status='pending'
                  AND (cmd.result IS NULL OR cmd.result='{}'::jsonb))
                OR (cmd.kind='hangup' AND cmd.status='rejected'
                  AND cmd.result->>'phase'='not_executed'
                  AND cmd.result->>'reason'='call_not_found')
                OR (cmd.kind IN ('dial','hangup') AND cmd.status='rejected'
                  AND cmd.result->>'phase'='not_executed'
                  AND cmd.result->>'reason'='command_expired')"""
        eligible = f"""
          SELECT c.id FROM call_records c
          JOIN gateways g ON g.id=c.gateway_id AND g.device_epoch=c.generation
          JOIN gateway_call_locks l ON l.call_id=c.id AND l.gateway_id=c.gateway_id AND l.generation=c.generation
          JOIN gateway_telecom_snapshots s ON s.gateway_id=c.gateway_id AND s.generation=c.generation
          WHERE c.id='{call_id}'::uuid AND c.state='unknown' AND c.direction='outgoing'
            AND c.device_call_id IS NULL AND c.answered_at IS NULL AND c.ended_at IS NULL
            AND s.local_busy=false AND s.calls='[]'::jsonb
            AND s.observed_at BETWEEN now()-interval '30 seconds' AND now()+interval '5 seconds'
            AND s.updated_at>=now()-interval '30 seconds'
            AND EXISTS (SELECT 1 FROM commands cmd WHERE cmd.call_id=c.id AND cmd.kind='dial')
            AND EXISTS (SELECT 1 FROM commands cmd WHERE cmd.call_id=c.id AND cmd.kind='hangup')
            AND NOT EXISTS (
              SELECT 1 FROM commands cmd WHERE cmd.call_id=c.id AND (
                cmd.gateway_id<>c.gateway_id OR cmd.generation<>c.generation
                OR cmd.expires_at>=now() OR cmd.expires_at>=s.observed_at
                OR cmd.sequence>s.reported_sequence
                OR NOT COALESCE(({command_acceptance}),false)
              )
            )
        """
    return f"""WITH eligible_recovery AS ({eligible})
      SELECT
        (SELECT count(*) FROM call_records WHERE state NOT IN ('ended','failed')
          AND id NOT IN (SELECT id FROM eligible_recovery)) +
        (SELECT count(*) FROM gateway_call_locks WHERE call_id NOT IN (SELECT id FROM eligible_recovery)) +
        (SELECT count(*) FROM commands WHERE status='pending' AND expires_at>now()) +
        (SELECT count(*) FROM sms_messages WHERE state IN ('sending','unknown'))
    """.strip()
