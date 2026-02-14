import { Command } from 'commander'
import { loadConfig } from '../core/config.js'
import { setLogLevel } from '../utils/logger.js'

export function createCli(): Command {
  const program = new Command()

  program
    .name('agent-memory')
    .description('Persistent memory MCP server for AI coding agents')
    .version('0.1.0')

  program
    .command('init')
    .description('Initialize the data directory for agent memory storage')
    .option('-d, --data-dir <path>', 'Data directory path', './data')
    .action(async (opts) => {
      const { runInit } = await import('./commands/init.js')
      runInit(opts.dataDir)
    })

  program
    .command('serve')
    .description('Start the Agent Memory MCP server (stdio transport)')
    .option('-d, --data-dir <path>', 'Data directory path')
    .option('--log-level <level>', 'Log level (debug, info, warn, error)')
    .action(async (opts) => {
      const config = loadConfig({
        dataDir: opts.dataDir,
        logLevel: opts.logLevel,
      })
      setLogLevel(config.logLevel as 'debug' | 'info' | 'warn' | 'error')

      const { runServe } = await import('./commands/serve.js')
      await runServe(config)
    })

  program
    .command('status')
    .description('Show memory system statistics')
    .option('-d, --data-dir <path>', 'Data directory path')
    .action(async (opts) => {
      const config = loadConfig({ dataDir: opts.dataDir })
      const { runStatus } = await import('./commands/status.js')
      await runStatus(config)
    })

  program
    .command('reflect')
    .description('Manually trigger a reflection cycle')
    .requiredOption('-a, --agent-id <id>', 'Agent identifier')
    .option('-f, --force', 'Force reflection even if threshold not met')
    .option('-d, --data-dir <path>', 'Data directory path')
    .action(async (opts) => {
      const config = loadConfig({ dataDir: opts.dataDir })
      const { runReflect } = await import('./commands/reflect.js')
      await runReflect(config, opts.agentId, opts.force ?? false)
    })

  program
    .command('consolidate')
    .description('Run memory consolidation (prune old observations, refresh summaries)')
    .option('-d, --data-dir <path>', 'Data directory path')
    .option('--max-age <days>', 'Max age in days for pruning', parseInt)
    .action(async (opts) => {
      const config = loadConfig({ dataDir: opts.dataDir })
      const { runConsolidate } = await import('./commands/consolidate.js')
      await runConsolidate(config, opts.maxAge)
    })

  return program
}
