import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from './server.js'
import { SqliteStorage } from '../storage/sqlite.js'
import { loadConfig } from '../core/config.js'
import type { EmbeddingProvider } from '../core/types.js'

class MockEmbeddings implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const hash = Array.from(text).reduce((a, c) => a + c.charCodeAt(0), 0)
    return Array.from({ length: 384 }, (_, i) => Math.sin(hash + i * 0.1))
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)))
  }
  dimensions(): number { return 384 }
}

class MockLance {
  records: Array<{ memory_id: string; memory_type: string; vector: number[]; content: string; created_at: string }> = []

  async add(memoryId: string, memoryType: string, vector: number[], content: string, createdAt: string): Promise<void> {
    this.records.push({ memory_id: memoryId, memory_type: memoryType, vector, content, created_at: createdAt })
  }
  async search(queryVector: number[], limit: number, memoryType?: string) {
    let filtered = this.records
    if (memoryType) filtered = filtered.filter(r => r.memory_type === memoryType)
    return filtered.slice(0, limit).map((r, i) => ({
      memory_id: r.memory_id, memory_type: r.memory_type, content: r.content,
      created_at: r.created_at, distance: 0.1 + i * 0.05,
    }))
  }
  async delete(memoryId: string): Promise<void> {
    this.records = this.records.filter(r => r.memory_id !== memoryId)
  }
  async count(): Promise<number> { return this.records.length }
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(c => c.type === 'text').map(c => c.text).join('')
}

describe('MCP Server Integration', () => {
  let sqlite: SqliteStorage
  let lance: MockLance
  let client: Client
  let clientTransport: InMemoryTransport
  let serverTransport: InMemoryTransport

  beforeEach(async () => {
    sqlite = SqliteStorage.inMemory()
    lance = new MockLance()
    const embeddings = new MockEmbeddings()
    const config = loadConfig({ anthropicApiKey: null })

    const server = await createMcpServer(sqlite, lance as any, embeddings, config)

    const [ct, st] = InMemoryTransport.createLinkedPair()
    clientTransport = ct
    serverTransport = st

    client = new Client({ name: 'test-client', version: '1.0.0' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await clientTransport.close()
    await serverTransport.close()
  })

  // ========== TOOL LISTING ==========

  it('lists all 13 tools', async () => {
    const result = await client.listTools()
    expect(result.tools.length).toBe(13)
    const names = result.tools.map(t => t.name).sort()
    expect(names).toEqual([
      'consolidate',
      'create_relation',
      'get_event',
      'get_timeline',
      'memory_status',
      'recall',
      'record_event',
      'reflect',
      'search_events',
      'search_knowledge',
      'store_learning',
      'update_core_memory',
      'update_entity',
    ])
  })

  // ========== RECORD EVENT ==========

  it('record_event creates event and returns ID', async () => {
    const result = await client.callTool({
      name: 'record_event',
      arguments: {
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'User prefers dark mode',
      },
    })

    const text = getText(result)
    expect(text).toContain('event_recorded')
    expect(text).toContain('id=')
    expect(text).toContain('importance="0.50"')
  })

  it('record_event respects manual importance', async () => {
    const result = await client.callTool({
      name: 'record_event',
      arguments: {
        agent_id: 'agent-1',
        event_type: 'decision',
        content: 'Critical decision',
        importance: 0.95,
      },
    })

    const text = getText(result)
    expect(text).toContain('importance="0.95"')
  })

  it('record_event stores in both sqlite and lance', async () => {
    await client.callTool({
      name: 'record_event',
      arguments: {
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'Test content',
      },
    })

    expect(sqlite.getEventCount()).toBe(1)
    expect(lance.records).toHaveLength(1)
    expect(lance.records[0].memory_type).toBe('event')
  })

  // ========== SEARCH EVENTS ==========

  it('search_events returns XML-formatted results', async () => {
    await client.callTool({
      name: 'record_event',
      arguments: {
        agent_id: 'agent-1',
        event_type: 'email',
        content: 'Sent email about project deadline',
        entities: ['Alice'],
      },
    })

    const result = await client.callTool({
      name: 'search_events',
      arguments: { query: 'project deadline' },
    })

    const text = getText(result)
    expect(text).toContain('<search_results')
    expect(text).toContain('<event')
    expect(text).toContain('project deadline')
  })

  it('search_events filters by agent_id', async () => {
    await client.callTool({
      name: 'record_event',
      arguments: { agent_id: 'agent-1', event_type: 'observation', content: 'Agent 1 event' },
    })
    await client.callTool({
      name: 'record_event',
      arguments: { agent_id: 'agent-2', event_type: 'observation', content: 'Agent 2 event' },
    })

    const result = await client.callTool({
      name: 'search_events',
      arguments: { query: 'event', agent_id: 'agent-1' },
    })

    const text = getText(result)
    expect(text).toContain('Agent 1 event')
    expect(text).not.toContain('Agent 2 event')
  })

  // ========== GET TIMELINE ==========

  it('get_timeline returns chronological events', async () => {
    await client.callTool({
      name: 'record_event',
      arguments: { agent_id: 'agent-1', event_type: 'observation', content: 'Timeline event' },
    })

    const now = new Date()
    const result = await client.callTool({
      name: 'get_timeline',
      arguments: {
        agent_id: 'agent-1',
        start: new Date(now.getTime() - 60000).toISOString(),
        end: new Date(now.getTime() + 60000).toISOString(),
      },
    })

    const text = getText(result)
    expect(text).toContain('<timeline')
    expect(text).toContain('Timeline event')
  })

  // ========== GET EVENT ==========

  it('get_event returns single event details', async () => {
    const createResult = await client.callTool({
      name: 'record_event',
      arguments: {
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'Specific event content',
        entities: ['TestEntity'],
        metadata: { key: 'value' },
      },
    })

    const createText = getText(createResult)
    const idMatch = createText.match(/id="([^"]+)"/)
    expect(idMatch).not.toBeNull()
    const eventId = idMatch![1]

    const result = await client.callTool({
      name: 'get_event',
      arguments: { event_id: eventId },
    })

    const text = getText(result)
    expect(text).toContain('Specific event content')
    expect(text).toContain('TestEntity')
    expect(text).toContain('&quot;key&quot;:&quot;value&quot;')
  })

  it('get_event returns error for missing event', async () => {
    const result = await client.callTool({
      name: 'get_event',
      arguments: { event_id: 'nonexistent-id' },
    })

    const text = getText(result)
    expect(text).toContain('<error>')
    expect(text).toContain('not found')
  })

  // ========== UPDATE CORE MEMORY ==========

  it('update_core_memory append creates and appends', async () => {
    const result = await client.callTool({
      name: 'update_core_memory',
      arguments: {
        block_type: 'persona',
        block_key: 'default',
        operation: 'append',
        content: 'I am a helpful assistant.',
      },
    })

    const text = getText(result)
    expect(text).toContain('core_memory_updated')
    expect(text).toContain('block_type="persona"')

    const block = sqlite.getCoreMemoryBlock('persona', 'default')
    expect(block).not.toBeNull()
    expect(block!.content).toBe('I am a helpful assistant.')
  })

  it('update_core_memory replace overwrites', async () => {
    await client.callTool({
      name: 'update_core_memory',
      arguments: { block_type: 'persona', block_key: 'default', operation: 'append', content: 'Original' },
    })

    await client.callTool({
      name: 'update_core_memory',
      arguments: { block_type: 'persona', block_key: 'default', operation: 'replace', content: 'Replaced' },
    })

    const block = sqlite.getCoreMemoryBlock('persona', 'default')
    expect(block!.content).toBe('Replaced')
  })

  it('update_core_memory remove deletes block', async () => {
    await client.callTool({
      name: 'update_core_memory',
      arguments: { block_type: 'persona', block_key: 'default', operation: 'append', content: 'To delete' },
    })

    await client.callTool({
      name: 'update_core_memory',
      arguments: { block_type: 'persona', block_key: 'default', operation: 'remove', content: '' },
    })

    const block = sqlite.getCoreMemoryBlock('persona', 'default')
    expect(block).toBeNull()
  })

  // ========== STORE LEARNING ==========

  it('store_learning creates entity', async () => {
    const result = await client.callTool({
      name: 'store_learning',
      arguments: {
        content: 'User prefers TypeScript over JavaScript',
      },
    })

    const text = getText(result)
    expect(text).toContain('learning_stored')
    expect(text).toContain('name=')

    expect(sqlite.getEntityCount()).toBe(1)
  })

  // ========== UPDATE ENTITY ==========

  it('update_entity creates new entity', async () => {
    const result = await client.callTool({
      name: 'update_entity',
      arguments: {
        name: 'Alice',
        entity_type: 'person',
        observations: ['Works in engineering', 'Prefers Python'],
      },
    })

    const text = getText(result)
    expect(text).toContain('entity_updated')
    expect(text).toContain('name="Alice"')
    expect(text).toContain('observations="2"')

    const entity = sqlite.getEntity('Alice')
    expect(entity).not.toBeNull()
    expect(entity!.observations).toHaveLength(2)
  })

  it('update_entity merges observations', async () => {
    await client.callTool({
      name: 'update_entity',
      arguments: { name: 'Bob', entity_type: 'person', observations: ['Likes coffee'] },
    })
    await client.callTool({
      name: 'update_entity',
      arguments: { name: 'Bob', entity_type: 'person', observations: ['Likes tea'] },
    })

    const entity = sqlite.getEntity('Bob')
    expect(entity!.observations).toContain('Likes coffee')
    expect(entity!.observations).toContain('Likes tea')
  })

  // ========== CREATE RELATION ==========

  it('create_relation links entities', async () => {
    await client.callTool({
      name: 'update_entity',
      arguments: { name: 'Alice', entity_type: 'person' },
    })
    await client.callTool({
      name: 'update_entity',
      arguments: { name: 'ProjectX', entity_type: 'project' },
    })

    const result = await client.callTool({
      name: 'create_relation',
      arguments: {
        from_entity: 'Alice',
        to_entity: 'ProjectX',
        relation_type: 'works_on',
      },
    })

    const text = getText(result)
    expect(text).toContain('relation_created')
    expect(text).toContain('from="Alice"')
    expect(text).toContain('to="ProjectX"')
    expect(text).toContain('type="works_on"')
  })

  it('create_relation fails for missing entity', async () => {
    await client.callTool({
      name: 'update_entity',
      arguments: { name: 'Alice', entity_type: 'person' },
    })

    const result = await client.callTool({
      name: 'create_relation',
      arguments: {
        from_entity: 'Alice',
        to_entity: 'NonExistent',
        relation_type: 'knows',
      },
    })

    const text = getText(result)
    expect(text).toContain('<error>')
    expect(text).toContain('not found')
  })

  // ========== SEARCH KNOWLEDGE ==========

  it('search_knowledge returns entities', async () => {
    await client.callTool({
      name: 'update_entity',
      arguments: {
        name: 'TypeScript',
        entity_type: 'tool',
        observations: ['A typed superset of JavaScript'],
        summary: 'Programming language',
      },
    })

    const result = await client.callTool({
      name: 'search_knowledge',
      arguments: { query: 'programming language' },
    })

    const text = getText(result)
    expect(text).toContain('<knowledge_results')
    expect(text).toContain('TypeScript')
  })

  // ========== RECALL ==========

  it('recall includes core memory', async () => {
    await client.callTool({
      name: 'update_core_memory',
      arguments: { block_type: 'persona', block_key: 'default', operation: 'replace', content: 'I am a test agent' },
    })

    await client.callTool({
      name: 'record_event',
      arguments: { agent_id: 'agent-1', event_type: 'observation', content: 'Test event for recall' },
    })

    const result = await client.callTool({
      name: 'recall',
      arguments: { query: 'test agent' },
    })

    const text = getText(result)
    expect(text).toContain('<core_memory>')
    expect(text).toContain('I am a test agent')
    expect(text).toContain('<recall_results')
  })

  it('recall returns scored memories', async () => {
    await client.callTool({
      name: 'record_event',
      arguments: { agent_id: 'agent-1', event_type: 'observation', content: 'Important meeting notes' },
    })

    const result = await client.callTool({
      name: 'recall',
      arguments: { query: 'meeting notes', include_core: false },
    })

    const text = getText(result)
    expect(text).toContain('<recall_results')
    expect(text).toContain('score=')
    expect(text).toContain('recency=')
    expect(text).toContain('importance=')
    expect(text).toContain('relevance=')
  })

  // ========== REFLECT ==========

  it('reflect returns error without API key', async () => {
    const result = await client.callTool({
      name: 'reflect',
      arguments: { agent_id: 'agent-1' },
    })

    const text = getText(result)
    expect(text).toContain('<error>')
    expect(text).toContain('ANTHROPIC_API_KEY')
  })

  // ========== CONSOLIDATE ==========

  it('consolidate runs cleanup', async () => {
    const result = await client.callTool({
      name: 'consolidate',
      arguments: {},
    })

    const text = getText(result)
    expect(text).toContain('consolidation_result')
    expect(text).toContain('entities_updated="0"')
    expect(text).toContain('observations_pruned="0"')
  })

  // ========== MEMORY STATUS ==========

  it('memory_status returns stats', async () => {
    await client.callTool({
      name: 'record_event',
      arguments: { agent_id: 'agent-1', event_type: 'observation', content: 'Event 1' },
    })
    await client.callTool({
      name: 'update_entity',
      arguments: { name: 'TestEntity', entity_type: 'concept' },
    })

    const result = await client.callTool({
      name: 'memory_status',
      arguments: {},
    })

    const text = getText(result)
    expect(text).toContain('<memory_status>')
    expect(text).toContain('<events>1</events>')
    expect(text).toContain('<entities>1</entities>')
    expect(text).toContain('<vector_embeddings>2</vector_embeddings>')
  })

  it('memory_status shows never for unset timestamps', async () => {
    const result = await client.callTool({
      name: 'memory_status',
      arguments: {},
    })

    const text = getText(result)
    expect(text).toContain('<last_reflection>never</last_reflection>')
    expect(text).toContain('<last_consolidation>never</last_consolidation>')
  })

  // ========== XML ESCAPING ==========

  it('escapes XML special characters in event content', async () => {
    await client.callTool({
      name: 'record_event',
      arguments: {
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'User said <script>alert("xss")</script> & more',
        entities: ['Alice & Bob', 'Project "X"'],
      },
    })

    const result = await client.callTool({
      name: 'search_events',
      arguments: { query: 'script' },
    })

    const text = getText(result)
    expect(text).toContain('&lt;script&gt;')
    expect(text).toContain('&amp; more')
    expect(text).not.toContain('<script>')
  })

  it('escapes XML special characters in entity names', async () => {
    await client.callTool({
      name: 'update_entity',
      arguments: {
        name: 'Test & "Entity"',
        entity_type: 'concept',
        observations: ['Has <special> chars'],
        summary: 'A "summary" with <tags>',
      },
    })

    const result = await client.callTool({
      name: 'search_knowledge',
      arguments: { query: 'special chars' },
    })

    const text = getText(result)
    expect(text).toContain('Test &amp; &quot;Entity&quot;')
    expect(text).toContain('&lt;special&gt;')
    expect(text).toContain('A &quot;summary&quot; with &lt;tags&gt;')
  })

  // ========== isError FLAG ==========

  it('get_event error has isError flag', async () => {
    const result = await client.callTool({
      name: 'get_event',
      arguments: { event_id: 'nonexistent' },
    })

    expect(result.isError).toBe(true)
  })

  it('create_relation error has isError flag', async () => {
    await client.callTool({
      name: 'update_entity',
      arguments: { name: 'Alice', entity_type: 'person' },
    })

    const result = await client.callTool({
      name: 'create_relation',
      arguments: { from_entity: 'Alice', to_entity: 'Missing', relation_type: 'knows' },
    })

    expect(result.isError).toBe(true)
  })

  it('reflect error has isError flag', async () => {
    const result = await client.callTool({
      name: 'reflect',
      arguments: { agent_id: 'agent-1' },
    })

    expect(result.isError).toBe(true)
  })

  // ========== STORE LEARNING WITH IMPORTANCE ==========

  it('store_learning with explicit importance stores it correctly', async () => {
    await client.callTool({
      name: 'store_learning',
      arguments: {
        content: 'Critical insight about architecture',
        importance: 0.9,
      },
    })

    const entities = sqlite.getAllEntities('concept')
    expect(entities).toHaveLength(1)
    expect(entities[0].importance).toBe(0.9)
  })

  it('store_learning without importance uses default', async () => {
    await client.callTool({
      name: 'store_learning',
      arguments: {
        content: 'A minor observation',
      },
    })

    const entities = sqlite.getAllEntities('concept')
    expect(entities).toHaveLength(1)
    expect(entities[0].importance).toBe(0.5)
  })

  // ========== DATE VALIDATION ==========

  it('get_timeline rejects invalid start date', async () => {
    const result = await client.callTool({
      name: 'get_timeline',
      arguments: {
        agent_id: 'agent-1',
        start: 'not-a-date',
        end: '2025-12-31T00:00:00Z',
      },
    })

    // Zod validation error returned as MCP error
    expect(result.isError).toBe(true)
  })

  it('get_timeline rejects invalid end date', async () => {
    const result = await client.callTool({
      name: 'get_timeline',
      arguments: {
        agent_id: 'agent-1',
        start: '2025-01-01T00:00:00Z',
        end: 'tomorrow',
      },
    })

    expect(result.isError).toBe(true)
  })

  it('search_events rejects invalid date in start param', async () => {
    const result = await client.callTool({
      name: 'search_events',
      arguments: {
        query: 'test',
        start: 'invalid-date',
      },
    })

    expect(result.isError).toBe(true)
  })

  // ========== METADATA SIZE LIMITS ==========

  it('record_event rejects oversized metadata', async () => {
    const bigMetadata: Record<string, string> = {}
    for (let i = 0; i < 200; i++) {
      bigMetadata[`key_${i}`] = 'x'.repeat(100)
    }

    const result = await client.callTool({
      name: 'record_event',
      arguments: {
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'Test',
        metadata: bigMetadata,
      },
    })

    expect(result.isError).toBe(true)
  })

  // ========== RECALL TOUCH PARAMETER ==========

  it('recall with touch=false does not update access_count', async () => {
    const createResult = await client.callTool({
      name: 'record_event',
      arguments: {
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'Touch test event',
      },
    })

    const createText = getText(createResult)
    const idMatch = createText.match(/id="([^"]+)"/)
    const eventId = idMatch![1]

    // Recall with touch=false
    await client.callTool({
      name: 'recall',
      arguments: { query: 'touch test', touch: false },
    })

    const event = sqlite.getEvent(eventId)
    expect(event!.access_count).toBe(0)
  })

  it('recall with default touch updates access_count', async () => {
    const createResult = await client.callTool({
      name: 'record_event',
      arguments: {
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'Touch default event',
      },
    })

    const createText = getText(createResult)
    const idMatch = createText.match(/id="([^"]+)"/)
    const eventId = idMatch![1]

    // Recall with default (touch=true)
    await client.callTool({
      name: 'recall',
      arguments: { query: 'touch default' },
    })

    const event = sqlite.getEvent(eventId)
    expect(event!.access_count).toBeGreaterThanOrEqual(1)
  })

  // ========== WHITESPACE QUERIES ==========

  it('recall rejects whitespace-only query', async () => {
    const result = await client.callTool({
      name: 'recall',
      arguments: { query: '   ' },
    })

    expect(result.isError).toBe(true)
  })

  it('search_events rejects whitespace-only query', async () => {
    const result = await client.callTool({
      name: 'search_events',
      arguments: { query: '  \t  ' },
    })

    expect(result.isError).toBe(true)
  })

  it('search_knowledge rejects whitespace-only query', async () => {
    const result = await client.callTool({
      name: 'search_knowledge',
      arguments: { query: '   ' },
    })

    expect(result.isError).toBe(true)
  })

  // ========== START > END VALIDATION ==========

  it('search_events returns error when start > end', async () => {
    const result = await client.callTool({
      name: 'search_events',
      arguments: {
        query: 'test',
        start: '2025-12-31T00:00:00Z',
        end: '2025-01-01T00:00:00Z',
      },
    })

    const text = getText(result)
    expect(result.isError).toBe(true)
    expect(text).toContain('start must be before end')
  })

  it('get_timeline returns error when start > end', async () => {
    const result = await client.callTool({
      name: 'get_timeline',
      arguments: {
        agent_id: 'agent-1',
        start: '2025-12-31T00:00:00Z',
        end: '2025-01-01T00:00:00Z',
      },
    })

    const text = getText(result)
    expect(result.isError).toBe(true)
    expect(text).toContain('start must be before end')
  })

  // ========== PARTIAL TIME RANGES ==========

  it('search_events accepts start without end', async () => {
    await client.callTool({
      name: 'record_event',
      arguments: { agent_id: 'agent-1', event_type: 'observation', content: 'Recent event' },
    })

    const result = await client.callTool({
      name: 'search_events',
      arguments: {
        query: 'recent',
        start: '2020-01-01T00:00:00Z',
      },
    })

    expect(result.isError).toBeUndefined()
    const text = getText(result)
    expect(text).toContain('<search_results')
  })

  it('search_events accepts end without start', async () => {
    await client.callTool({
      name: 'record_event',
      arguments: { agent_id: 'agent-1', event_type: 'observation', content: 'Past event' },
    })

    const result = await client.callTool({
      name: 'search_events',
      arguments: {
        query: 'past',
        end: '2099-01-01T00:00:00Z',
      },
    })

    expect(result.isError).toBeUndefined()
    const text = getText(result)
    expect(text).toContain('<search_results')
  })
})
