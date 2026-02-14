import type { Config } from '../../core/config.js'
import { TransformersEmbeddingProvider } from '../../embeddings/transformers-provider.js'
import { ConsolidationEngine } from '../../memory/consolidation.js'
import { LanceStorage } from '../../storage/lance.js'
import { SqliteStorage } from '../../storage/sqlite.js'

export async function runConsolidate(config: Config, maxAgeDays?: number): Promise<void> {
  const sqlite = new SqliteStorage(config)
  const lance = new LanceStorage(config)
  const embeddings = new TransformersEmbeddingProvider(
    config.embeddingModel,
    config.embeddingDimensions,
  )

  const consolidation = new ConsolidationEngine(sqlite, lance, embeddings, config)

  console.log(`Running consolidation${maxAgeDays ? ` (max age: ${maxAgeDays} days)` : ''}...`)

  const result = await consolidation.consolidate(maxAgeDays)

  console.log('\nConsolidation complete:')
  console.log(`  Entities updated:      ${result.entities_updated}`)
  console.log(`  Observations pruned:   ${result.observations_pruned}`)
  console.log(`  Summaries refreshed:   ${result.summaries_refreshed}`)

  sqlite.close()
}
