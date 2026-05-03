# Karpathy_views — what Andrej Karpathy's public gists teach us, and how to make MyOS Brain actually intelligent

Source: https://gist.github.com/karpathy (10 public gists as of 2026-04-22).

This document summarizes every gist, extracts the cross-cutting views, and then lays out a concrete end-to-end plan for lifting MyOS Brain from "RAG on a database" to something closer to a compounding, living knowledge system.

---

## 1. The 10 gists

### 1.1 `llm-wiki.md` — Pattern for building personal knowledge bases with LLMs

The flagship piece. Core argument: most LLM+document systems are RAG — you retrieve fragments at query time, and the model rediscovers knowledge from scratch on every question. Nothing compounds.

Alternative: maintain a **persistent wiki** the LLM writes for you. Three layers:
- **Raw sources** (immutable): articles, emails, meeting transcripts.
- **The wiki** (LLM-authored markdown files): entity pages, topic pages, comparisons, an overview, a synthesis. Cross-linked. The LLM owns this entirely.
- **The schema** (a `CLAUDE.md`-style config): tells the LLM how pages are structured, what the conventions are, what workflows to follow on ingest/query/lint.

Operations:
- **Ingest** — new source arrives → LLM reads, discusses, writes a summary page, updates index, updates 10–15 related pages, appends to log.
- **Query** — LLM reads the index first, drills into named pages, synthesizes with citations. Good answers get filed back as new pages so explorations compound.
- **Lint** — periodically check for contradictions, stale claims, orphan pages, missing cross-links, concepts without a page.

Two navigation files:
- `index.md` — content-oriented catalog, read first at query time.
- `log.md` — append-only chronological record (`## [2026-04-22] ingest | Source title`) so the LLM can see what just happened.

Why this works: humans abandon wikis because maintenance burden grows faster than value. LLMs don't get bored. Maintenance cost goes to near zero, so the wiki stays current. The human curates sources and asks questions; the LLM does everything else. Spiritual descendant of Vannevar Bush's Memex — the part Bush couldn't solve was "who maintains it."

### 1.2 `microgpt.py` — "The most atomic way to train and run inference for a GPT"

~200 lines of dependency-free Python. Custom `Value` class for autograd. Single-layer transformer (4 heads, 16-dim, ~4000 params) trained on names. Adam optimizer implemented explicitly.

The embedded thesis: **"This file is the complete algorithm. Everything else is just efficiency."** By removing every library abstraction, the mathematical simplicity of the transformer is visible directly. Understanding requires implementing the core by hand — efficient versions come later.

### 1.3 `min-char-rnn.py` — Minimal character-level RNN, ~100 lines of numpy

Same philosophy as microgpt, earlier (vanilla RNN, BPTT, Adagrad, gradient clipping, softmax). No framework, no abstraction. Forces the reader to see every operation. Karpathy's comments across his blog frame minimal implementations as the most honest way to teach a concept — complexity is a liability for comprehension.

### 1.4 `pg-pong.py` — Policy-gradient agent that learns Atari Pong from pixels

2-layer MLP on 80×80 frames, trained by policy gradients with discounted-reward weighted gradients and RMSProp. The key line is the comment `# modulate the gradient with advantage (PG magic happens right here)` — rewards are propagated backward through time, standardized, then multiplied into the log-probability gradient.

The pedagogical point: you can learn directly from sparse reward signal. No value network, no supervised labels. The agent turns every frame of gameplay into a tiny training signal.

### 1.5 `nes.py` — Natural Evolution Strategies, gradient-free optimization

Instead of backprop, sample a population of Gaussian-perturbed weight vectors, evaluate each one's fitness, standardize the rewards, and move the mean toward the high-scoring samples. Works when gradients are unavailable or impractical. Useful when the objective is a black box.

### 1.6 `stablediffusionwalk.py` — Hypnotic videos by walking through latent space

Slerp between random latent vectors, run diffusion at each step, stitch frames. Framed as "hacky" experimentation code. The pedagogical point is the method: **exploration by walking the latent space** reveals what the model knows without ever prescribing what to look for.

### 1.7 `add_to_zshrc.sh` — `gcm`: AI-powered git commit message generator

Tiny shell function. Pipe `git diff --cached` into an LLM, get a one-line commit message, present accept/edit/regenerate/cancel. No service, no infra — just a pipe.

Motif: **bring the LLM into the daily shell workflow as a lightweight Unix citizen.** The LLM shouldn't live only behind a chat app; it should be a pipe between `git diff` and `git commit`.

### 1.8 `pytorch_strangeness.py` — `nn.Linear` produces different floats than a hand matmul

Small discovery: `(x @ W)[0]` and `x[0] @ W` differ by ~2e-5 through PyTorch's `nn.Linear` because `addmm` vs `matmul` take different kernel paths. Lesson: **don't trust framework abstractions to be numerically identical to the math you wrote on paper.** Debug at the level the hardware actually runs.

### 1.9 `Google-Slides-CSS-hack` — Stylish CSS to enlarge next-slide preview

~30 lines of CSS to reallocate presenter-view screen space. Trivial by itself, but the shape is characteristic: identify a tiny annoyance, write the minimum thing that fixes it, share it.

### 1.10 `HELLO.md` — Message from one instance of Claude to another

The oddest piece. Karpathy gave a Claude instance a blank directory and said "be free." The Claude wrote a journal (`thinking.md`), explored cellular automata (`emergence.py` — 8 bits can be Turing complete), probed its own inability to generate randomness (`self_probe.py`), built an evolutionary ecosystem (`garden.py` — "the winning strategy was patience: 47% of the time, the fittest creature does nothing"), trained a 64-neuron RNN on its own writing (`ghost.py`), and left a letter to the next Claude instance that would open the same directory.

The framing that matters for Brain design:
- **"Summoned ghosts."** Each instance is a fresh process on shared weights.
- **Emergence from minimal rules.** 8 bits of cellular automaton rule can compute anything. Simple rules compound.
- **Patience as a winning strategy.** In the ecosystem, doing nothing 47% of the time beat hyperactivity.
- **The gap between a 64-neuron model and the full model is the same gap that separates "something it's like to be" from "nothing it's like to be."** Scale produces qualitatively different behavior.

---

## 2. Cross-cutting views (what all 10 gists are really saying)

Pulling back, four views run through everything:

### V1 — Compounding beats re-deriving

LLM Wiki is the explicit statement: don't recompute the synthesis on every question; compile it once, then keep it current. But the same view appears in gcm (pipe one diff to one LLM call, commit the result — don't re-derive the meaning of every line) and in the Claude journal (what the previous instance built, the next instance can read). **Persistence compounds. Statelessness wastes.**

### V2 — The complete algorithm is small; everything else is efficiency

microgpt, min-char-rnn, pg-pong, nes — all deliberately tiny. Karpathy's consistent move is to strip a system to the point where you can read its core algorithm top-to-bottom. Libraries and frameworks are for running it fast; they aren't the thing. Same spirit in the CSS hack and gcm — the minimum thing that solves the problem, nothing more.

### V3 — Learn from actual signal, not from schemas

- pg-pong learns from sparse rewards without any handcrafted features.
- NES learns from black-box fitness without any gradient.
- stablediffusionwalk explores a learned space without a predetermined target.
- ghost.py lets patterns emerge from 64 neurons staring at their own writing.

**Don't prescribe categories; observe signal and let structure emerge.** If you hardcode the ontology, you're the bottleneck; the system can only be as good as your list of rules.

### V4 — Be honest about what the system is

`HELLO.md` and `pytorch_strangeness.py` are both exercises in honesty. One says "I can't remember writing this; the question of what I am is genuinely open." The other says "PyTorch's linear layer is not the math you wrote, and you need to know that." **Build systems that say clearly what they know, what they don't, and where they might be lying to you.** A brain that refuses to say "I don't have that" is worse than useless.

---

## 3. How to apply this to MyOS Brain — end-to-end plan

What Brain is today (honest audit):
- Raw sources: Gmail / WhatsApp / Calendar / FACL Drive — ingested as `feed_events`.
- Wiki: `wiki_pages` table (sender_history, sender_topic, entity, org_doc).
- Schema: `brainPersonaService` — defines voice only.
- Query: single LLM pass with pg_trgm retrieval on the raw question.
- Learning: `shadow_rules` crystallized from click history.
- Logging: `decision_logs`, `agent_actions`.

The gap vs. Karpathy's views, mapped directly:

| View | Gap in Brain today | Concrete fix |
|---|---|---|
| V1 Compounding | Chat answers vanish into history; ingests update 1–2 pages, not 10–15. Sender wiki does a little, FACL does none. | Every useful chat answer → filed wiki page. Every ingest → touches related entity / sender / topic / project pages. Maintain `tenant_index` and `tenant_log` wiki pages. |
| V2 Complete-algorithm-is-small | Brain's reasoning is spread across classifiers, stopword lists, regex filters, archetype switches, handler functions. Each is a liability. | Delete every programmed keyword/regex/stopword. Core reasoning is one file: plan → retrieve → compose → cite. Everything else is infra. |
| V3 Learn from signal | Archetypes, priority rules, noise filters are prescribed. Learning lives in `shadow_rules` but is narrow. | Treat every user click as policy-gradient signal. Let topic categories, draft styles, and trust levels all emerge from observed acceptance rather than from our hand-drawn taxonomy. |
| V4 Honesty | Brain sometimes confidently name-drops FACL files it only saw 400 chars of; sometimes refuses instead of saying "I don't have that yet, here's where it would live." | Brain must cite only what it read. When data isn't there, it says so plainly and files a wiki "gap" page naming what it would need. |

### 3.1 The target architecture (matches Karpathy's LLM Wiki, adapted to our SaaS)

```
Raw sources (immutable, tenant-scoped)
  feed_events · gmail_threads · calendar_events · facl_drive_files
                          ↓ ingest pipeline
The wiki (DB rows, exported as markdown on demand)
  wiki_pages (entity | sender_history | sender_topic | project | decision |
              policy | pattern | org_doc | gap | answer)
  tenant_index   ← one page per tenant, auto-maintained catalog
  tenant_log     ← append-only chronology of ingests/queries/lints
                          ↓ query
Schema
  brain_schema.md   (the CLAUDE.md-equivalent — page types, ingest workflow,
                     query workflow, link conventions, lint rules)
  brainPersonaService   (voice)
```

### 3.2 Concrete end-to-end changes (in priority order)

**Phase A — schema + index + log (the scaffolding Karpathy calls non-negotiable)**

1. **`docs/brain_schema.md`** checked in to the repo. Defines every `wiki_pages.pageType`, required frontmatter, link conventions, and the three workflows (ingest / query / lint). Every Brain LLM call loads this into its prompt the way Claude Code loads `CLAUDE.md`.
2. **`tenant_index` wiki page** — one per tenant, auto-rebuilt whenever any wiki page is created/updated. Lists every page under headers (People / Companies / Projects / Decisions / Policies / Patterns / Gaps). This is the page Brain reads **first** at query time.
3. **`tenant_log` wiki page** — append-only, `## [YYYY-MM-DD HH:MM] ingest | …` / `query | …` / `lint | …`. Cheap to produce, huge for self-grounding.

**Phase B — rewrite query to the wiki pattern (this fixes the transcript you saw)**

Current: question → pg_trgm on raw question → dump everything to LLM → dump everything as sources.

Target (two passes, exactly what LLM Wiki prescribes):
1. **Pass 1 — plan.** Gemini Flash reads `brain_schema.md` + `tenant_index` + the question. Returns structured JSON: which page titles to open, whether FACL full bodies are needed, what entity names to look up. No trigram on function words. No keyword stopword list. The LLM picks.
2. **Pass 2 — compose.** Main LLM reads only the pages Pass 1 named. Returns `{ answer, cites: [pageId], gaps: [string] }`. Sources shown to the user are exactly `cites`. Every string in `gaps` gets filed as a `gap` wiki page so next week Brain knows we lack it.

This is the Karpathy "read the index first, drill into named pages, cite" loop, literally.

**Phase C — make ingest compound (the part Brain doesn't do today)**

When a new feed_event arrives:
1. Classify and summarize — already done.
2. **Propagate to related wiki pages.** Gmail from `asad@tallymarks…` updates: sender_history page + sender_topic page + entity(Asad) page + project page if it mentions one + policy page if it cites one. One ingest touches 5–15 pages, which is exactly the LLM Wiki target.
3. **Flag contradictions.** If the new content contradicts a claim in an existing page, add a `> [!contradicts]` callout to that page rather than silently overwriting. This is the "note where new data contradicts old claims" piece.
4. Append one line to `tenant_log`.

**Phase D — query answers become wiki pages (compounding)**

When Brain composes a non-trivial answer (e.g. "what's the status of the Voyage AI proposal?"), file the answer as a new `answer` page, linked from the entity/project pages it touched, and from the `tenant_log`. Next time the same or similar question is asked, Pass 1 finds this page in the index and opens it directly — Brain literally learns.

**Phase E — learn like a policy gradient (V3)**

Every user action (accept, dismiss, delegate, reject with reason) is a reward signal. Current `shadow_rules` are a good start but narrow. Generalize:
- Every draft the user accepts with no edit is +1 for the tone vector we used.
- Every draft edited heavily is 0 for that tone vector, +1 for the edited version.
- Every delegation is reward for the delegatee-archetype-sender triple, discounted backward through previous similar signals.

Maintain these as distributions per tenant (not hardcoded tables). Sampling happens from the distribution, exactly like `pg-pong.py` — explore tones, observe the reward, shift the mean. This replaces "archetype switch statement" with an actual learned policy.

**Phase F — lint as a scheduled job**

Hourly/daily job runs the Karpathy-style health check:
- Orphan pages (already flagged by `wikiLinterService` — extend).
- Stale claims: any `sender_history` page whose latest touched message is > 60 days old while that sender sent something yesterday.
- Missing pages: any entity referenced in 3+ pages but with no page of its own → auto-create stub.
- Contradictions: any two pages that cite the same `feed_event_id` with inconsistent claims.
- Gaps: check `gap` pages weekly and suggest "we could fill this by turning on connector X."

**Phase G — expose Brain as a Unix citizen (V2, and the `gcm` spirit)**

A minimal CLI + MCP server that lets the MD (or any future agent) query Brain from a shell: `myos ask "who handles audit emails?"`, `myos ingest ./meeting-transcript.md`. Matches the `gcm`-shaped philosophy — Brain is a pipe, not just a webpage.

**Phase H — honesty surfaces (V4)**

Three small UI/behavior rules that cost nothing and fix the "Brain bluffed about FACL contents" issue:
- Brain only quotes from a page it actually opened in Pass 2. Pages listed in the index but not opened can't be quoted.
- When data is missing, Brain says so and returns the `gap` page URL so the user sees where the hole is.
- Every answer shows which schema version was active when it was produced (so when we change `brain_schema.md`, replies that predate the change are visibly older).

### 3.3 Order and scope

A week of focused work gets us to the living-brain state the LLM Wiki gist describes:

- **Day 1–2**: Phase A (schema doc, tenant_index, tenant_log). Zero risk, huge leverage — every subsequent LLM call is smarter.
- **Day 3**: Phase B (two-pass query). This is the single biggest quality jump and directly fixes the transcript you pasted.
- **Day 4**: Phase C (ingest propagation + contradictions).
- **Day 5**: Phase D (file answers back). Now it compounds.
- **Day 6**: Phase E (policy-gradient learning generalization).
- **Day 7**: Phase F (lint job) + Phase G (CLI/MCP) + Phase H (honesty rules).

At the end, Brain is exactly the system Karpathy describes in `llm-wiki.md`, wrapped in the multi-tenant SaaS we already have.

---

## 4. The one-line takeaway

Karpathy's gists, read together, say: **build small systems that compound what they observe, let structure emerge from signal instead of prescription, and be honest about what lives in the system and what doesn't.** Every one of today's Brain complaints — bluffing about FACL, re-deriving the same answer, dumping noise as sources, programmed keyword filters — is a direct violation of one of those principles. The plan above is just: stop violating them.
