"""HaseebOS v15 Central Brain — decomposed into three concerns.

- `inference/`: stateless LLM routing (Gemini Pro). Deals with ambiguous
  inputs where an LLM call adds value (feed classification edge cases,
  natural-language queries, draft composition).
- `orchestration/`: deterministic ADK workflow agents (SequentialAgent,
  ParallelAgent) for predictable pipelines. No LLM calls — just wiring.
- `learning/`: asynchronous rule engine + Probabilistic Shadowing. Mines
  BigQuery training set nightly and proposes new DRAFT rules.
"""
