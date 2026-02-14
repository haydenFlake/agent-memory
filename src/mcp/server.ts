import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { Config } from '../core/config.js'
import type { EmbeddingProvider, EventType, EntityType } from '../core/types.js'
import { EpisodicMemory } from '../memory/episodic.js'
import { SemanticMemory } from '../memory/semantic.js'
import { RetrievalEngine } from '../memory/retrieval.js'
import { ReflectionEngine } from '../memory/reflection.js'
import { ConsolidationEngine } from '../memory/consolidation.js'
import type { SqliteStorage } from '../storage/sqlite.js'
import type { LanceStorage } from '../storage/lance.js'
import { logger } from '../utils/logger.js'
import { escapeXml } from '../utils/xml.js'

export async function createMcpServer(
  sqlite: SqliteStorage,
  lance: LanceStorage,
  embeddings: EmbeddingProvider,
  config: Config,
): Promise<McpServer> {
  const episodic = new EpisodicMemory(sqlite, lance, embeddings, config)
  const semantic = new SemanticMemory(sqlite, lance, embeddings, config)
  const retrieval = new RetrievalEngine(sqlite, lance, embeddings, config)
  const reflection = new ReflectionEngine(sqlite, lance, embeddings, config)
  const consolidation = new ConsolidationEngine(sqlite, lance, embeddings, config)

  const server = new McpServer({
    name: 'agent-memory',
    version: '0.1.0',
  })

  // ========== EPISODIC MEMORY TOOLS ==========

  server.tool(
    'record_event',
    'Record an immutable event in the episodic timeline. Use this to log messages, emails, actions, decisions, observations, communications, file changes, errors, or milestones.',
    {
      agent_id: z.string().min(1).max(255).describe('Your agent identifier (use a consistent ID across sessions)'),
      event_type: z.enum(['message', 'email', 'action', 'decision', 'observation', 'communication', 'file_change', 'error', 'milestone']).describe('Type of event'),
      content: z.string().min(1).max(50000).describe('Full natural language description of the event'),
      entities: z.array(z.string().min(1).max(500)).optional().describe('Names of people, projects, or things involved'),
      metadata: z.record(z.unknown()).optional().describe('Additional structured data'),
      importance: z.number().min(0).max(1).optional().describe('Override importance score (0-1). If omitted, auto-scored by LLM.'),
    },
    async (args) => {
      const event = await episodic.recordEvent({
        agent_id: args.agent_id,
        event_type: args.event_type as EventType,
        content: args.content,
        entities: args.entities,
        metadata: args.metadata,
        importance: args.importance,
      })

      return {
        content: [
          {
            type: 'text' as const,
            text: formatXml('event_recorded', {
              id: event.id,
              importance: event.importance.toFixed(2),
              created_at: event.created_at,
            }),
          },
        ],
      }
    },
  )

  server.tool(
    'search_events',
    'Search the episodic event timeline using semantic similarity and keyword matching. Returns events ranked by relevance.',
    {
      query: z.string().min(1).max(1000).describe('Natural language search query'),
      agent_id: z.string().min(1).max(255).optional().describe('Filter to a specific agent'),
      event_type: z.enum(['message', 'email', 'action', 'decision', 'observation', 'communication', 'file_change', 'error', 'milestone']).optional().describe('Filter by event type'),
      start: z.string().optional().describe('Start of time range (ISO-8601)'),
      end: z.string().optional().describe('End of time range (ISO-8601)'),
      entities: z.array(z.string().min(1).max(500)).optional().describe('Filter to events involving these entities'),
      limit: z.number().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    async (args) => {
      const events = await episodic.searchEvents({
        query: args.query,
        agent_id: args.agent_id,
        event_type: args.event_type as EventType | undefined,
        time_range: args.start && args.end ? { start: args.start, end: args.end } : undefined,
        entities: args.entities,
        limit: args.limit,
      })

      const formatted = events.map(e =>
        `<event id="${escapeXml(e.id)}" type="${escapeXml(e.event_type)}" importance="${e.importance.toFixed(2)}" at="${escapeXml(e.created_at)}"${e.entities.length > 0 ? ` entities="${escapeXml(e.entities.join(', '))}"` : ''}>\n${escapeXml(e.content)}\n</event>`,
      ).join('\n\n')

      return {
        content: [{ type: 'text' as const, text: `<search_results count="${events.length}">\n${formatted}\n</search_results>` }],
      }
    },
  )

  server.tool(
    'get_timeline',
    'Retrieve events in chronological order within a time range. Use for reviewing what happened during a specific period.',
    {
      agent_id: z.string().min(1).max(255).describe('Agent identifier'),
      start: z.string().describe('Start of time range (ISO-8601)'),
      end: z.string().describe('End of time range (ISO-8601)'),
      event_type: z.enum(['message', 'email', 'action', 'decision', 'observation', 'communication', 'file_change', 'error', 'milestone']).optional(),
      limit: z.number().min(1).max(200).optional().describe('Max results (default 50)'),
    },
    async (args) => {
      const events = episodic.getTimeline({
        agent_id: args.agent_id,
        start: args.start,
        end: args.end,
        event_type: args.event_type as EventType | undefined,
        limit: args.limit,
      })

      const formatted = events.map(e =>
        `<event id="${escapeXml(e.id)}" type="${escapeXml(e.event_type)}" at="${escapeXml(e.created_at)}">\n${escapeXml(e.content)}\n</event>`,
      ).join('\n\n')

      return {
        content: [{ type: 'text' as const, text: `<timeline count="${events.length}" from="${escapeXml(args.start)}" to="${escapeXml(args.end)}">\n${formatted}\n</timeline>` }],
      }
    },
  )

  server.tool(
    'get_event',
    'Retrieve a specific event by its ID.',
    {
      event_id: z.string().min(1).max(255).describe('The event ID to retrieve'),
    },
    async (args) => {
      const event = episodic.getEvent(args.event_id)
      if (!event) {
        return { content: [{ type: 'text' as const, text: '<error>Event not found</error>' }], isError: true }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `<event id="${escapeXml(event.id)}" type="${escapeXml(event.event_type)}" importance="${event.importance.toFixed(2)}" at="${escapeXml(event.created_at)}" entities="${escapeXml(event.entities.join(', '))}">\n${escapeXml(event.content)}\n<metadata>${escapeXml(JSON.stringify(event.metadata))}</metadata>\n</event>`,
        }],
      }
    },
  )

  // ========== SEMANTIC MEMORY TOOLS ==========

  server.tool(
    'update_core_memory',
    'Edit the agent\'s persistent core memory blocks. Use "persona" to update your personality/behavior guidelines. Use "user_profile" to store key facts about users you interact with. Core memory is included in every recall response.',
    {
      block_type: z.enum(['persona', 'user_profile']).describe('Which memory block to update'),
      block_key: z.string().min(1).max(255).describe('Block identifier (e.g., "default" for persona, or a username for user profiles)'),
      operation: z.enum(['append', 'replace', 'remove']).describe('How to modify the block'),
      content: z.string().max(50000).describe('Content to append/replace with (ignored for remove)'),
    },
    async (args) => {
      const block = semantic.updateCoreMemory({
        block_type: args.block_type,
        block_key: args.block_key,
        operation: args.operation,
        content: args.content,
      })

      return {
        content: [{
          type: 'text' as const,
          text: formatXml('core_memory_updated', {
            block_type: block.block_type,
            block_key: block.block_key,
            length: block.content.length.toString(),
            updated_at: block.updated_at,
          }),
        }],
      }
    },
  )

  server.tool(
    'store_learning',
    'Record a new learning, insight, or preference as an entity in the knowledge graph. Use this when you discover something worth remembering long-term.',
    {
      content: z.string().min(1).max(50000).describe('The learning or insight to store'),
      entities: z.array(z.string().min(1).max(500)).optional().describe('Related entity names'),
      importance: z.number().min(0).max(1).optional().describe('Importance score (0-1, default 0.5)'),
    },
    async (args) => {
      const entity = await semantic.updateEntity({
        name: `learning_${Date.now()}`,
        entity_type: 'concept',
        observations: [args.content],
        summary: args.content,
      })

      if (args.entities) {
        for (const entityName of args.entities) {
          const related = semantic.getEntity(entityName)
          if (related) {
            semantic.createRelation({
              from_entity: entity.name,
              to_entity: entityName,
              relation_type: 'related_to',
            })
          }
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: formatXml('learning_stored', {
            id: entity.id,
            name: entity.name,
          }),
        }],
      }
    },
  )

  server.tool(
    'update_entity',
    'Create or update an entity in the knowledge graph. Entities represent people, projects, concepts, preferences, tools, organizations, locations, or topics. Observations accumulate over time.',
    {
      name: z.string().min(1).max(500).describe('Entity name (unique identifier)'),
      entity_type: z.enum(['person', 'project', 'concept', 'preference', 'tool', 'organization', 'location', 'topic']).describe('Type of entity'),
      observations: z.array(z.string().min(1).max(5000)).optional().describe('New facts to add (merged with existing)'),
      summary: z.string().max(10000).optional().describe('Updated summary (replaces existing)'),
    },
    async (args) => {
      const entity = await semantic.updateEntity({
        name: args.name,
        entity_type: args.entity_type as EntityType,
        observations: args.observations,
        summary: args.summary,
      })

      return {
        content: [{
          type: 'text' as const,
          text: formatXml('entity_updated', {
            id: entity.id,
            name: entity.name,
            type: entity.entity_type,
            observations: entity.observations.length.toString(),
          }),
        }],
      }
    },
  )

  server.tool(
    'create_relation',
    'Create a directed relationship between two entities. Old relationships of the same type are automatically invalidated (bi-temporal). Use active voice for relation types (e.g., "works_on", "prefers", "manages").',
    {
      from_entity: z.string().min(1).max(500).describe('Source entity name'),
      to_entity: z.string().min(1).max(500).describe('Target entity name'),
      relation_type: z.string().min(1).max(255).describe('Relationship type in active voice (e.g., "works_on", "prefers", "manages")'),
      metadata: z.record(z.unknown()).optional().describe('Additional relationship metadata'),
    },
    async (args) => {
      try {
        const relation = semantic.createRelation({
          from_entity: args.from_entity,
          to_entity: args.to_entity,
          relation_type: args.relation_type,
          metadata: args.metadata,
        })

        return {
          content: [{
            type: 'text' as const,
            text: formatXml('relation_created', {
              id: relation.id,
              from: args.from_entity,
              to: args.to_entity,
              type: relation.relation_type,
            }),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `<error>${escapeXml(err instanceof Error ? err.message : String(err))}</error>` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'search_knowledge',
    'Semantic search over the knowledge graph (entities, their observations, and summaries). Use to find what you know about a topic.',
    {
      query: z.string().min(1).max(1000).describe('Natural language search query'),
      entity_type: z.enum(['person', 'project', 'concept', 'preference', 'tool', 'organization', 'location', 'topic']).optional().describe('Filter by entity type'),
      limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
    },
    async (args) => {
      const entities = await semantic.searchKnowledge({
        query: args.query,
        entity_type: args.entity_type as EntityType | undefined,
        limit: args.limit,
      })

      const formatted = entities.map(e => {
        const obs = e.observations.map(o => `  <observation>${escapeXml(o)}</observation>`).join('\n')
        const relations = semantic.getRelationsFor(e.name)
        const rels = relations.map(r => {
          const from = sqlite.getEntityById(r.from_entity)
          const to = sqlite.getEntityById(r.to_entity)
          return `  <relation from="${escapeXml(from?.name ?? r.from_entity)}" to="${escapeXml(to?.name ?? r.to_entity)}" type="${escapeXml(r.relation_type)}" />`
        }).join('\n')

        return `<entity name="${escapeXml(e.name)}" type="${escapeXml(e.entity_type)}"${e.summary ? ` summary="${escapeXml(e.summary)}"` : ''}>\n${obs}${rels ? '\n' + rels : ''}\n</entity>`
      }).join('\n\n')

      return {
        content: [{ type: 'text' as const, text: `<knowledge_results count="${entities.length}">\n${formatted}\n</knowledge_results>` }],
      }
    },
  )

  // ========== MEMORY MANAGEMENT TOOLS ==========

  server.tool(
    'recall',
    'The primary memory retrieval tool. Returns the most relevant memories across ALL stores (events, entities, reflections), scored by recency x importance x relevance. Also includes core memory blocks (persona + user profiles) as a header. Use this as your main way to remember context.',
    {
      query: z.string().min(1).max(1000).describe('What are you trying to remember? Describe the context or question.'),
      limit: z.number().min(1).max(50).optional().describe('Max memories to return (default 20)'),
      include_core: z.boolean().optional().describe('Include core memory blocks in response (default true)'),
      agent_id: z.string().min(1).max(255).optional().describe('Filter to a specific agent'),
    },
    async (args) => {
      const result = await retrieval.recall({
        query: args.query,
        limit: args.limit,
        include_core: args.include_core,
        agent_id: args.agent_id,
      })

      let output = ''

      if (result.core_memory.length > 0) {
        const coreBlocks = result.core_memory.map(b =>
          `<${b.block_type} key="${escapeXml(b.block_key)}">\n${escapeXml(b.content)}\n</${b.block_type}>`,
        ).join('\n')
        output += `<core_memory>\n${coreBlocks}\n</core_memory>\n\n`
      }

      const memories = result.memories.map(m =>
        `<memory id="${escapeXml(m.id)}" source="${escapeXml(m.source)}" score="${m.score.toFixed(3)}" recency="${m.recency_score.toFixed(3)}" importance="${m.importance_score.toFixed(3)}" relevance="${m.relevance_score.toFixed(3)}" at="${escapeXml(m.created_at)}">\n${escapeXml(m.content)}\n</memory>`,
      ).join('\n\n')

      output += `<recall_results count="${result.memories.length}" searched="${result.total_searched}">\n${memories}\n</recall_results>`

      return { content: [{ type: 'text' as const, text: output }] }
    },
  )

  server.tool(
    'reflect',
    'Trigger a reflection cycle on recent events. Generates higher-level insights by synthesizing patterns across events. Requires Anthropic API key. Reflections are stored and become part of recall results.',
    {
      agent_id: z.string().min(1).max(255).describe('Agent identifier'),
      force: z.boolean().optional().describe('Force reflection even if importance threshold not met'),
    },
    async (args) => {
      if (!reflection.enabled) {
        return {
          content: [{ type: 'text' as const, text: '<error>Reflection requires ANTHROPIC_API_KEY to be configured</error>' }],
          isError: true,
        }
      }

      const reflections = await reflection.reflect(args.agent_id, args.force)

      if (reflections.length === 0) {
        return {
          content: [{ type: 'text' as const, text: '<reflection_result>No reflections generated (threshold not met or no unreflected events)</reflection_result>' }],
        }
      }

      const formatted = reflections.map(r =>
        `<reflection id="${escapeXml(r.id)}" depth="${r.depth}" importance="${r.importance.toFixed(2)}" sources="${r.source_ids.length}">\n${escapeXml(r.content)}\n</reflection>`,
      ).join('\n\n')

      return {
        content: [{ type: 'text' as const, text: `<reflection_result count="${reflections.length}">\n${formatted}\n</reflection_result>` }],
      }
    },
  )

  server.tool(
    'consolidate',
    'Run a memory consolidation cycle. Prunes old low-importance observations, refreshes entity summaries, and compresses knowledge. Runs automatically on schedule, but can be triggered manually.',
    {
      max_age_days: z.number().min(1).optional().describe('Override prune age (default from config)'),
    },
    async (args) => {
      const result = await consolidation.consolidate(args.max_age_days)

      return {
        content: [{
          type: 'text' as const,
          text: formatXml('consolidation_result', {
            entities_updated: result.entities_updated.toString(),
            observations_pruned: result.observations_pruned.toString(),
            summaries_refreshed: result.summaries_refreshed.toString(),
          }),
        }],
      }
    },
  )

  server.tool(
    'memory_status',
    'Get memory system statistics including event count, entity count, last reflection time, and storage health.',
    {},
    async () => {
      const stats = sqlite.getStats()
      const vectorCount = await lance.count()

      const output = `<memory_status>
  <events>${stats.event_count}</events>
  <entities>${stats.entity_count}</entities>
  <relations>${stats.relation_count}</relations>
  <reflections>${stats.reflection_count}</reflections>
  <core_memory_blocks>${stats.core_memory_blocks}</core_memory_blocks>
  <vector_embeddings>${vectorCount}</vector_embeddings>
  <last_reflection>${escapeXml(stats.last_reflection_at ?? 'never')}</last_reflection>
  <last_consolidation>${escapeXml(stats.last_consolidation_at ?? 'never')}</last_consolidation>
  <oldest_event>${escapeXml(stats.oldest_event ?? 'none')}</oldest_event>
  <newest_event>${escapeXml(stats.newest_event ?? 'none')}</newest_event>
</memory_status>`

      return { content: [{ type: 'text' as const, text: output }] }
    },
  )

  return server
}

export async function startMcpServer(
  sqlite: SqliteStorage,
  lance: LanceStorage,
  embeddings: EmbeddingProvider,
  config: Config,
): Promise<void> {
  const server = await createMcpServer(sqlite, lance, embeddings, config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info('Agent Memory MCP server started (stdio transport)')
}

function formatXml(tag: string, attrs: Record<string, string>): string {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeXml(v)}"`)
    .join(' ')
  return `<${tag} ${attrStr} />`
}
