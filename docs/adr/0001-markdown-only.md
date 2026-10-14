# ADR-0001 — Local markdown-only memory; no embeddings, vectors, servers, or keys

**Status:** accepted. **Date:** 2026-10-15.

## Context

The surveyed default is SQLite + FTS + embeddings with RAG/RRF retrieval. V1's most adopted local plugin (`opencode-mem`) does Turso/libSQL vectors with ONNX embeddings. The project goal is a no-fuss plugin for all developers with zero subscription and zero daemon.

## Decision

The source of truth is git-backed markdown under `.opencode/memory/`. No embeddings, no vector index, no SQLite, no server, no API keys in the default path. Retrieval is exact-match grep + link-walking (§4.4) plus the tell-tale pointer system (§4.5).

## Consequences

- Positive: $0 cost, offline, inspectable (`grep`, PR review), no model downloads (100MB–2GB), no re-embed migrations/locks, no platform exclusions (Intel Mac, Windows single-session), no per-token embedding spend.
- Negative: no semantic search; recall depends on INDEX discipline and symbol naming. Accepted: the adopted vector-failure analysis (exact binding vs. semantic closeness, chunking breaks scope, index drift) and §4.8 (compilers need determinism, not closeness) show semantic recall is actively harmful for code precision.
- Deferred: optional SQLite FTS mirror as an explicit opt-in (P2), never the default.
