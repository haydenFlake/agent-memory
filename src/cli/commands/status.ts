import type { Config } from '../../core/config.js'
import { LanceStorage } from '../../storage/lance.js'
import { SqliteStorage } from '../../storage/sqlite.js'

export async function runStatus(config: Config): Promise<void> {
  const sqlite = new SqliteStorage(config)
  const lance = new LanceStorage(config)

  try {
    const stats = sqlite.getStats()
    const vectorCount = await lance.count()

    console.log('\nAgent Memory Status')
    console.log('===================')
    console.log(`Events:           ${stats.event_count}`)
    console.log(`Entities:         ${stats.entity_count}`)
    console.log(`Relations:        ${stats.relation_count}`)
    console.log(`Reflections:      ${stats.reflection_count}`)
    console.log(`Core Memory:      ${stats.core_memory_blocks} blocks`)
    console.log(`Vector Embeddings: ${vectorCount}`)
    console.log(`Oldest Event:     ${stats.oldest_event ?? 'none'}`)
    console.log(`Newest Event:     ${stats.newest_event ?? 'none'}`)
    console.log(`Last Reflection:  ${stats.last_reflection_at ?? 'never'}`)
    console.log(`Last Consolidation: ${stats.last_consolidation_at ?? 'never'}`)
    console.log()
  } finally {
    sqlite.close()
    lance.close()
  }
}
