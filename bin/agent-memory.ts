#!/usr/bin/env node

import { createCli } from '../src/cli/index.js'
import { logger } from '../src/utils/logger.js'

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: reason })
  process.exit(1)
})

const program = createCli()
program.parse()
