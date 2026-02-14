# Agent Memory MCP Server

## What This Is
A persistent memory system for AI coding agents, exposed as an MCP server. Two memory systems:
1. **Episodic Memory** — Immutable, append-only event log (messages, emails, actions, decisions)
2. **Semantic Memory** — Evolving knowledge graph (entities, relations, personality, learnings)

## Tech Stack
- TypeScript (ES2022, strict mode, ESM)
- SQLite via better-sqlite3 (structured data + FTS5)
- LanceDB (vector embeddings)
- @huggingface/transformers (local embeddings, all-MiniLM-L6-v2)
- @modelcontextprotocol/sdk (MCP server, stdio transport)
- @anthropic-ai/sdk (optional — Haiku for importance scoring + reflections)
- zod (schema validation)
- commander (CLI)

## Architecture
```
src/core/       — Config, types, errors, ULID
src/storage/    — SQLite + LanceDB abstractions
src/embeddings/ — HuggingFace embedding provider
src/memory/     — Episodic, Semantic, Retrieval, Reflection, Consolidation, Importance
src/mcp/        — MCP server with 13 tools
src/cli/        — CLI commands (init, serve, status, reflect, consolidate)
bin/            — Entry point
```

## Key Patterns
- ULIDs for all IDs (time-sortable)
- Retrieval scoring: `score = recency * importance * relevance`
- Recency decay: `0.995^hours_since_access`
- Reflections trigger when cumulative importance > 150
- Relations are bi-temporal (valid_from, valid_until)
- Events are immutable; entities/knowledge evolve

## Commands
```bash
npm run build       # Compile TypeScript
npm run test        # Run vitest
npm run serve       # Start MCP server via tsx
npm run dev         # Watch mode development
```

## Testing
- Use vitest with in-memory SQLite for tests
- Test files live next to source: `foo.test.ts` alongside `foo.ts`

## Code Style
- No semicolons (prettier default)
- Single quotes
- 2-space indent
- Explicit return types on exported functions
