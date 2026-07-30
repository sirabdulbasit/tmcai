# Kit engine maintenance

The kit engine is DERIVED from the reference project's orchestrator:
1. `cp <project>/orchestrator.cjs orch-kit/orchestrator.cjs`
2. run the config-extraction script (see the v86-kit commit for the canonical
   patch list: CFG loader + models/harness/caps/stampPaths/codex.auto refs)
3. `node --check`, commit, push.
Never hand-patch the kit engine with ad-hoc block grabs — three mirror failures
on 2026-07-27 came from exactly that.
