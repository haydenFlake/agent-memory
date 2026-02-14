export const stateKeys = {
  lastReflectedAt: (agentId: string): string => `last_reflected_at:${agentId}`,
  coreMemory: (agentId: string): string => `core_memory:${agentId}`,
  lastReflectionAt: 'last_reflection_at',
  lastConsolidationAt: 'last_consolidation_at',
}
