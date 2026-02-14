import type { Config } from '../../core/config.js'
import { TransformersEmbeddingProvider } from '../../embeddings/transformers-provider.js'
import { ReflectionEngine } from '../../memory/reflection.js'
import { LanceStorage } from '../../storage/lance.js'
import { SqliteStorage } from '../../storage/sqlite.js'

export async function runReflect(config: Config, agentId: string, force: boolean): Promise<void> {
  const sqlite = new SqliteStorage(config)
  const lance = new LanceStorage(config)
  const embeddings = new TransformersEmbeddingProvider(
    config.embeddingModel,
    config.embeddingDimensions,
  )

  try {
    const reflection = new ReflectionEngine(sqlite, lance, embeddings, config)

    if (!reflection.enabled) {
      console.error('Reflection requires ANTHROPIC_API_KEY to be configured')
      process.exit(1)
    }

    console.log(`Running reflection for agent: ${agentId}${force ? ' (forced)' : ''}`)

    const reflections = await reflection.reflect(agentId, force)

    if (reflections.length === 0) {
      console.log('No reflections generated (threshold not met or no unreflected events)')
    } else {
      console.log(`Generated ${reflections.length} reflections:`)
      for (const r of reflections) {
        console.log(`\n  [${r.id}] (depth: ${r.depth}, importance: ${r.importance.toFixed(2)})`)
        console.log(`  ${r.content}`)
      }
    }
  } finally {
    sqlite.close()
    lance.close()
  }
}
