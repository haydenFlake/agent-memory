# Agent Memory

Persistent memory MCP server for AI coding agents. Gives agents human-like memory: an episodic event log for "what happened" and a semantic knowledge graph for "what I know."

```
                         MCP Server (stdio)
                              |
                    +---------+---------+
                    |                   |
              Episodic Memory    Semantic Memory
              (event log)        (knowledge graph)
                    |                   |
              +-----+-----+      +-----+-----+
              |           |      |           |
           SQLite     LanceDB  SQLite     LanceDB
          (events,    (vector   (entities, (vector
           FTS5)     search)   relations) search)
                    |
              +-----+-----+
              |           |
          Reflection  Consolidation
          (insights)  (compression)
```

## Quick Start

```bash
# Clone and install
git clone https://github.com/haydenFlake/agent-memory.git
cd agent-memory
npm install

# Initialize data directory
npx tsx bin/agent-memory.ts init

# Start the MCP server
npx tsx bin/agent-memory.ts serve
```

## Configure with Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["tsx", "/path/to/agent-memory/bin/agent-memory.ts", "serve"],
      "env": {
        "DATA_DIR": "./data",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

The `ANTHROPIC_API_KEY` is optional. Without it, importance scoring defaults to 0.5 and reflections are disabled. Everything else works.

## Tools

The server exposes 13 MCP tools:

### Episodic Memory
| Tool | Description |
|------|-------------|
| `record_event` | Log an immutable event (message, email, action, decision, observation, etc.) |
| `search_events` | Semantic + keyword search across the event timeline |
| `get_timeline` | Retrieve events in chronological order within a time range |
| `get_event` | Retrieve a specific event by ID |

### Semantic Memory
| Tool | Description |
|------|-------------|
| `update_core_memory` | Edit persistent memory blocks (persona, user profiles) |
| `store_learning` | Record a new learning or insight |
| `update_entity` | Create/update entities (people, projects, concepts, tools, etc.) |
| `create_relation` | Link entities with bi-temporal relationships |
| `search_knowledge` | Semantic search over the knowledge graph |

### Memory Management
| Tool | Description |
|------|-------------|
| `recall` | Primary retrieval: scores memories by `recency x importance x relevance` |
| `reflect` | Generate higher-level insights from recent events (requires API key) |
| `consolidate` | Prune old observations, refresh entity summaries |
| `memory_status` | System statistics and health |

## How It Works

**Retrieval scoring** follows the Stanford Generative Agents formula:

```
score = weight_recency * recency + weight_importance * importance + weight_relevance * relevance
```

Where `recency = 0.995 ^ hours_since_last_access` (exponential decay).

**Reflections** are triggered when cumulative importance of unreflected events exceeds a threshold (default 150). Claude Haiku synthesizes abstract insights from recent events, which become part of future recall results.

**Consolidation** runs on a schedule (default 24h) or manually. It prunes entities with >20 observations down to 20 and refreshes stale summaries.

**Relations are bi-temporal**: when a relationship changes, the old one gets a `valid_until` timestamp and a new one is created, preserving history.

## Configuration

All settings via environment variables or `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | Storage directory for SQLite + LanceDB |
| `DECAY_RATE` | `0.995` | Recency decay per hour (0-1) |
| `REFLECTION_THRESHOLD` | `150` | Cumulative importance to trigger reflection |
| `CONSOLIDATION_INTERVAL` | `86400000` | Auto-consolidation interval (ms) |
| `WEIGHT_RECENCY` | `0.4` | Retrieval weight for recency |
| `WEIGHT_IMPORTANCE` | `0.3` | Retrieval weight for importance |
| `WEIGHT_RELEVANCE` | `0.3` | Retrieval weight for relevance |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace embedding model |
| `EMBEDDING_DIMENSIONS` | `384` | Embedding vector dimensions |
| `ANTHROPIC_API_KEY` | — | Optional: enables importance scoring + reflections |

## CLI Commands

```bash
npx tsx bin/agent-memory.ts init          # Initialize data directory
npx tsx bin/agent-memory.ts serve         # Start MCP server (stdio)
npx tsx bin/agent-memory.ts status        # Show memory stats
npx tsx bin/agent-memory.ts reflect       # Trigger reflection cycle
npx tsx bin/agent-memory.ts consolidate   # Trigger consolidation cycle
```

## Development

```bash
npm run build        # Compile TypeScript
npm test             # Run tests (115 tests across 12 files)
npm run test:watch   # Watch mode
npm run lint         # Type check
npm run dev          # Watch mode development server
```

## Architecture

```
src/
  core/           Config, types, errors, ULID generation
  storage/        SQLite (structured + FTS5) and LanceDB (vectors)
  embeddings/     HuggingFace local embedding provider
  memory/         Episodic, Semantic, Retrieval, Reflection, Consolidation, Importance
  mcp/            MCP server with 13 tools
  background/     Interval-based scheduler for auto-reflection and consolidation
  cli/            CLI commands
bin/              Entry point
```

## Research Foundations

- [Generative Agents](https://arxiv.org/abs/2304.03442) — Retrieval scoring formula (recency x importance x relevance)
- [MemGPT/Letta](https://arxiv.org/abs/2310.08560) — Tiered memory with core blocks
- [FadeMem](https://arxiv.org/abs/2504.18522) — Biologically-inspired importance-modulated forgetting
