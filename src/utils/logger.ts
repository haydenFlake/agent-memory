export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let currentLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel]
}

function timestamp(): string {
  return new Date().toISOString()
}

export const logger = {
  debug(msg: string, data?: unknown): void {
    if (shouldLog('debug')) {
      console.error(`[${timestamp()}] DEBUG: ${msg}`, data !== undefined ? data : '')
    }
  },
  info(msg: string, data?: unknown): void {
    if (shouldLog('info')) {
      console.error(`[${timestamp()}] INFO: ${msg}`, data !== undefined ? data : '')
    }
  },
  warn(msg: string, data?: unknown): void {
    if (shouldLog('warn')) {
      console.error(`[${timestamp()}] WARN: ${msg}`, data !== undefined ? data : '')
    }
  },
  error(msg: string, data?: unknown): void {
    if (shouldLog('error')) {
      console.error(`[${timestamp()}] ERROR: ${msg}`, data !== undefined ? data : '')
    }
  },
}
