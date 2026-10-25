/** A plain workspace folder has no source materialization; its native placement binds only the dispatch intent. */
export const plainNativePlacementMigration = { version: 2026102501, sql: `
create or replace function guard_agent_native_placement() returns trigger language plpgsql as $$
declare intent execution_dispatch_intents%rowtype; material source_execution_materializations%rowtype;
begin
 select * into intent from execution_dispatch_intents where execution_id=NEW.execution_id;
 if NEW.record->>'kind'='plain' then
  if intent.operation_id is distinct from NEW.operation_id or intent.binding_hash is distinct from NEW.accepted_binding_hash
    or intent.attempt_id is distinct from NEW.record->>'attemptId' then
   raise exception 'NATIVE_PLACEMENT_CONFLICT' using errcode='P2844';
  end if;
  return NEW;
 end if;
 select * into material from source_execution_materializations where materialization_id=(NEW.record#>>'{materialization,receipt,materializationId}')::uuid;
 if intent.operation_id is distinct from NEW.operation_id or intent.binding_hash is distinct from NEW.accepted_binding_hash
   or material.execution_id is distinct from NEW.execution_id or material.operation_id is distinct from NEW.operation_id
   or material.attempt_id is distinct from intent.attempt_id then
  raise exception 'NATIVE_PLACEMENT_CONFLICT' using errcode='P2844';
 end if;
 return NEW;
end $$;
` } as const
