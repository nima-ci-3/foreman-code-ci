import { expect, it } from 'vitest'
import { MemoryBoardViewSchema, MemoryBoardWireSchemas, MemoryCardDetailSchema, type MemoryCard } from '@foreman-code/contracts'
import { WorkActivationInputSchema } from '@foreman-code/contracts/current'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/database.js'
import { memoryCall, memoryWorkflow, workflowMemory, type MemoryRuntime } from './helpers/memoryWorkflow.js'
import { coordinationOutput, hierarchyRuntimeFixture } from './helpers/hierarchyRuntimeFixture.js'

it.runIf(postgresEnabled).each([
  ['master', 'coder'], ['orchestrator', 'coder'], ['coder', 'coder'],
] as const)('only projects keeper cards for a %s / %s workflow', async (keeper, childRole) => {
  const fixture = keeper === 'master' ? hierarchyRuntimeFixture() : memoryWorkflow()
  if (keeper !== 'master') {
    fixture.configurations[0]!.productRole = keeper
    fixture.configurations[1]!.productRole = childRole
  }
  const childIndex = keeper === 'master' ? 4 : 1
  const child = fixture.version.definition.nodes[childIndex]!
  const childIsKeeper = keeper === childRole
  const launches: MemoryCard[][] = []
  let tracked: Awaited<ReturnType<typeof workflowMemory>>
  let linked: ReturnType<typeof MemoryCardDetailSchema.parse> | undefined
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, approvalNodeIds: [],
    outputFor: (_nodeId, request) => {
      if (keeper === 'master') return coordinationOutput(request.workflowNodeId, request)
      const { work } = WorkActivationInputSchema.parse(request.input)
      const routing = work.kind === 'work_request'
        ? { kind: 'return', requestId: work.request.requestId, outcome: 'accepted' }
        : { kind: 'finish' }
      return { routing, data: { latestDeliverable: { text: 'Reviewed work' }, remainingFindings: [] } }
    },
    managerFactory: () => {
      const manager = runtime.provider.connection()
      return { ...manager, async createSession(input) {
        if (!isWorkflowStart(input)) throw new Error('Expected workflow launch')
        const board = MemoryBoardViewSchema.parse(await memoryCall(runtime.client, 'memory_board_get', { boardId: tracked.boardId }))
        launches.push(board.openColumns.flatMap(column => column.items).filter(card => card.assignee !== null))
        if (input.request.workflowNodeId === child.id && !childIsKeeper) {
          const { work } = WorkActivationInputSchema.parse(input.request.input)
          const created = await memoryCall(runtime.client, 'memory_card_create', { kind: 'card_create', boardId: tracked.boardId,
            card: { title: 'Existing child binding', body: '', status: 'doing', completionKind: null,
              reason: null, assignee: null, linkedNodes: [] },
            workSelections: [{ kind: 'current', work: { kind: 'activation', runId: fixture.run.id,
              workflowVersionId: fixture.version.id, activationId: work.activation.activationId } }],
          })
          linked = MemoryCardDetailSchema.parse(await memoryCall(runtime.client, 'memory_board_get', {
            boardId: tracked.boardId, view: 'card', cardId: (created.card as MemoryCard).id }))
        }
        return manager.createSession(input)
      } }
    } })
  try {
    tracked = await workflowMemory(runtime, childIndex)
    const before = MemoryCardDetailSchema.parse(await tracked.read())
    await runtime.engine.start(runtime.f.run.id)
    expect((await runtime.runs.get(runtime.f.run.id))?.outcome).toBe('succeeded')
    expect(launches).toHaveLength(keeper === 'master' ? 11 : 2)
    const keeperIds = childIsKeeper ? fixture.version.definition.nodes.map(node => node.id) : [fixture.version.entryNodeId]
    for (const cards of launches) {
      expect(cards.map(card => card.assignee!.workflowNodeId)).toEqual(expect.arrayContaining([fixture.version.entryNodeId]))
      expect(cards.every(card => keeperIds.includes(card.assignee!.workflowNodeId))).toBe(true)
    }
    const done = MemoryBoardWireSchemas.cards.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId: tracked.boardId, view: 'cards', status: 'done' }))
    expect(done.items.filter(card => card.assignee).map(card => card.assignee!.workflowNodeId).sort()).toEqual([...keeperIds].sort())
    const after = MemoryCardDetailSchema.parse(await tracked.read())
    if (childIsKeeper) {
      expect(after.card.status).toBe('done')
      expect(after.bindings).toEqual([expect.objectContaining({ state: 'accepted' })])
    } else {
      // Neither admission claims nor existing bindings may let a lower-tier Agent move a card.
      expect(after).toMatchObject({ card: before.card, bindings: before.bindings, claims: before.claims,
        history: { items: before.history.items } })
      expect(linked).toBeDefined()
      const settled = MemoryCardDetailSchema.parse(await memoryCall(runtime.client, 'memory_board_get', {
        boardId: tracked.boardId, view: 'card', cardId: linked!.card.id }))
      expect(settled).toMatchObject({ card: linked!.card, bindings: linked!.bindings, claims: linked!.claims,
        history: { items: linked!.history.items } })
    }
  } finally { await runtime.close() }
}, 60000)
