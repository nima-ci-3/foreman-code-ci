import type pg from 'pg'
import { LangGraphPostgresSaver, WRITES_IDX_MAP, type SerializerProtocol } from './langgraph.js'
import { DomainError } from '@foreman-code/contracts-node/server-kit'
import { retryDatabaseTimeout } from './databaseRetry.js'
import { withTransaction } from './transaction.js'

/** The generation row serializes checkpoint commits with successor ownership. */
export class CheckpointMutationSaver extends LangGraphPostgresSaver {
  constructor(private readonly mutationPool: pg.Pool, serde?: SerializerProtocol,
    private readonly mutationOptions: { schema: string } = { schema: 'public' }) {
    super(mutationPool, serde, mutationOptions)
  }

  private async checkOwner(client: pg.PoolClient, config: Parameters<LangGraphPostgresSaver['put']>[0]): Promise<void> {
    const { thread_id: runId, checkpoint_owner_generation: generation } = config.configurable ?? {}
    const owner = (await client.query<{ generation: string }>(`
      select generation::text from run_checkpoint_owners where run_id=$1 for update`, [runId])).rows[0]
    if (!owner || owner.generation !== generation) {
      throw new DomainError('RUN_OWNERSHIP_LOST', 'The checkpoint writer no longer owns this Run.', 409)
    }
    const active = await client.query(`select 1 from run_checkpoint_owners o
      join pg_stat_activity a on a.pid=o.owner_pid and a.backend_start=o.owner_started_at
      join pg_locks l on l.pid=a.pid and l.locktype='advisory'
        and l.classid=810002::oid and l.objid=(hashtext(o.run_id)::bigint & 4294967295)::oid
        and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted
      where o.run_id=$1`, [runId])
    if (!active.rowCount) throw new DomainError('RUN_OWNERSHIP_LOST', 'The checkpoint owner disconnected.', 409)
  }

  override async put(...args: Parameters<LangGraphPostgresSaver['put']>): ReturnType<LangGraphPostgresSaver['put']> {
    const [config, checkpoint, metadata, versions] = args
    if (!config.configurable?.checkpoint_owner_generation) {
      return retryDatabaseTimeout(() => super.put(...args), { signal: config.signal })
    }
    const { thread_id: threadId, checkpoint_ns: namespace = '', checkpoint_id: parent } = config.configurable
    const [blobs, serializedMetadata] = await Promise.all([
      this.dumpBlobs(threadId, namespace, checkpoint.channel_values, versions), this.dumpMetadata(metadata),
    ])
    const serializedCheckpoint = this.dumpCheckpoint(checkpoint)
    await retryDatabaseTimeout(() => withTransaction(this.mutationPool, async client => {
      await this.checkOwner(client, config)
      for (let offset = 0; offset < blobs.length; offset += 1000) {
        const batch = blobs.slice(offset, offset + 1000)
        const values = batch.map((_, row) => `(${Array.from({ length: 6 }, (_value, column) => `$${row * 6 + column + 1}`).join(',')})`).join(',')
        await client.query(`insert into "${this.mutationOptions.schema}".checkpoint_blobs
          (thread_id,checkpoint_ns,channel,version,type,blob) values ${values}
          on conflict(thread_id,checkpoint_ns,channel,version) do nothing`, batch.flat())
      }
      await client.query(`insert into "${this.mutationOptions.schema}".checkpoints
        (thread_id,checkpoint_ns,checkpoint_id,parent_checkpoint_id,checkpoint,metadata)
        values($1,$2,$3,$4,$5,$6) on conflict(thread_id,checkpoint_ns,checkpoint_id)
        do update set checkpoint=excluded.checkpoint,metadata=excluded.metadata`,
      [threadId, namespace, checkpoint.id, parent, serializedCheckpoint, serializedMetadata])
    }), { signal: config.signal })
    return { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpoint.id,
      checkpoint_owner_generation: config.configurable.checkpoint_owner_generation } }
  }

  override async putWrites(...args: Parameters<LangGraphPostgresSaver['putWrites']>): Promise<void> {
    const [config, writes, taskId] = args
    if (!config.configurable?.checkpoint_owner_generation) {
      return retryDatabaseTimeout(() => super.putWrites(...args), { signal: config.signal })
    }
    const { thread_id: threadId, checkpoint_ns: namespace = '', checkpoint_id: checkpointId } = config.configurable
    const dumped = await this.dumpWrites(threadId, namespace, checkpointId, taskId, writes)
    const upsert = writes.every(([channel]) => channel in WRITES_IDX_MAP)
    const conflict = upsert ? 'do update set channel=excluded.channel,type=excluded.type,blob=excluded.blob' : 'do nothing'
    // A reserved channel may occur more than once; sequential upserts retained the last value.
    const rows = upsert ? [...new Map(dumped.map(write => [write[4], write])).values()] : dumped
    await retryDatabaseTimeout(() => withTransaction(this.mutationPool, async client => {
      await this.checkOwner(client, config)
      for (let offset = 0; offset < rows.length; offset += 1000) {
        const batch = rows.slice(offset, offset + 1000)
        const values = batch.map((_, row) => `(${Array.from({ length: 8 }, (_value, column) => `$${row * 8 + column + 1}`).join(',')})`).join(',')
        await client.query(`insert into "${this.mutationOptions.schema}".checkpoint_writes
          (thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,blob) values ${values}
          on conflict(thread_id,checkpoint_ns,checkpoint_id,task_id,idx) ${conflict}`, batch.flat())
      }
    }), { signal: config.signal })
  }
}
