# RooFlow Study and Lessons for Graphyard

## 1. What RooFlow Is

### Purpose
RooFlow (`README.md`) is an open-source workflow configuration and system prompt suite designed for the [Roo Code](https://github.com/RooVetGit/Roo-Code) VS Code extension. It provides an alternative operational model centered around token-optimized YAML system prompts, role-specialized operational modes, and continuous cross-session memory preservation (`README.md:21-32`).

### Moving Parts
1. **Specialized Modes (`config/.roomodes`, `modules/modes.yml`)**:
   - `flow-architect` (`config/.roo/system-prompt-flow-architect`): System design, project structure, and bootstrapping/governing the project Memory Bank. Has read, edit, browser, and MCP tools, but lacks command execution privileges.
   - `flow-code` (`config/.roo/system-prompt-flow-code`): Core implementation, code modification, surgical diffs, and local test execution. Possesses full read, edit, browser, command, and MCP tool access.
   - `flow-debug` (`config/.roo/system-prompt-flow-debug`): Diagnostic investigation, test failure troubleshooting, and root cause analysis.
   - `flow-ask` (`config/.roo/system-prompt-flow-ask`): Read-only advisory mode for exploratory Q&A, codebase navigation, and architecture explanation. Stripped of file modification and terminal execution privileges.
   - `flow-orchestrator` (`config/.roo/system-prompt-flow-orchestrator`): Strategic coordination, problem decomposition, and delegation across specialist modes. Possesses read, browser, and MCP capabilities, but cannot edit code files directly.

2. **Memory Bank and Context Strategy**:
   - **File-Based Memory Bank (`memory-bank/`)**: Maintained in five standardized Markdown files (`config/.roo/system-prompt-flow-architect:1068-1166`, `README.md:217-230`):
     - `productContext.md`: High-level goals, key features, and overall system architecture.
     - `activeContext.md`: Immediate working focus, recent modifications, and active questions/blockers.
     - `decisionLog.md`: Append-only record of architectural and implementation decisions with rationale.
     - `progress.md`: Milestone tracking, task lists (completed, current, next steps).
     - `systemPatterns.md`: Recurring design, coding, and testing patterns.
   - **Real-Time Event Triggers (`memory_bank_updates`)**: Prompts prescribe deterministic triggers for updating memory files mid-flight (e.g., updating `decisionLog.md` upon any design fork, updating `progress.md` upon task transitions).
   - **UMB Command (`umb`)**: An explicit trigger pattern (`^(Update Memory Bank|UMB)$`) in mode prompts (`config/.roo/system-prompt-flow-architect:1228-1259`) that halts current work, parses conversation history across modes, synchronizes all affected files, and prepares a clean continuation state.
   - **ConPort Alternative (`config/roo_code_conport_strategy`)**: An MCP-backed SQLite persistence layer (`context_portal/context.db`) providing full-text search (`search_decisions_fts`), semantic vector search (`semantic_search_conport`), knowledge-graph linking (`link_conport_items`), and recent activity summaries (`get_recent_activity_summary`).

3. **Prompts and Templating Engine**:
   - **YAML System Prompts (`modules/rooflow_core_prompt.yaml`, `config/.roo/system-prompt-*`)**: Replaces verbose natural-language Markdown prompts with compact, schema-validated YAML encoding identity, tool schemas, and behavioral rules (R01 through R15).
   - **Dynamic MCP Injection (`config/generate_mcp_yaml.py`, `config/install_rooflow.sh`, `config/install_rooflow_conport.sh`)**: Installer scripts parse connected MCP servers from Markdown documentation, serialize them into YAML blocks, and inject them into prompt template placeholders alongside operating system, shell, and workspace variables.

### Task Flow
1. **Initialization**: On session start, the active mode checks workspace files (`list_files`). If `memory-bank/` is missing, it offers initialization through `flow-architect`; if present, it sequentially reads all core files (`productContext.md`, `activeContext.md`, `systemPatterns.md`, `decisionLog.md`, `progress.md`) and emits `[MEMORY BANK: ACTIVE]`.
2. **Decomposition & Delegation**: A complex user request arrives at `flow-orchestrator`. The orchestrator executes semantic codebase search (`codebase_search`), decomposes the problem into sequential milestones, and delegates the first milestone to `flow-code` or `flow-architect` via `new_task` or `switch_mode` (the "Boomerang" pattern).
3. **Execution & Recording**: The specialized mode inspects files with line numbers (`read_file`), prepares surgical edits (`apply_diff`), executes commands (`execute_command`), and logs decisions or status updates to `memory-bank/` as they occur.
4. **Synchronization**: Before session conclusion or mode switching, the agent triggers real-time updates or executes the UMB routine to persist continuation points, open issues, and completed tasks for the next session.

---

## 2. What RooFlow Does Well That Graphyard Does Not, or Does Worse

### 1. Cross-Session Continuity and Attempt Handover
- **Mechanism**: RooFlow's `activeContext.md` and `progress.md` (or ConPort's `get_recent_activity_summary`, `config/roo_code_conport_strategy:39`) explicitly capture current focus, recent modifications, and open issues. Any agent session starting in the workspace immediately absorbs this state.
- **Why it works**: A succeeding agent does not start from zero context; it continues from the exact frontier where the prior agent stopped, without re-exploring failed paths or re-reading unchanged files.
- **Graphyard Mapping (`memory between sessions`, `dispatch`)**: Graphyard isolates attempts in fresh epochs and worktrees, but already hands a retried item over. When a worker attempt ends by interruption or by its provider account running out, `preservePartialWork` (`src/master/launch.ts`) commits the worktree's uncommitted changes, and `workerPrompt` (`src/master/dispatch.ts`) appends `resumedAttempt`: the successor's launch prompt names the prior epoch, why it ended, and the kept commit, branch and worktree to merge or cherry-pick, plus any human answer an earlier attempt received. The remaining gap is narrower: the handover carries code and an exit reason, not diagnostics — the commands the prior attempt ran, the failing test output it saw, or the hypotheses it ruled out — so a successor that fails the same way (as GY-1123's attempts 10–15 timed out in sequence) can still repeat the same trajectory.

### 2. Dense YAML Prompt Envelopes and Token Optimization
- **Mechanism**: RooFlow structures its system instructions, tool definitions, and operational constraints as dense YAML keys (`modules/rooflow_core_prompt.yaml`, `config/.roomodes`).
- **Why it works**: YAML syntax uses concise indentation rather than repetitive Markdown headers, lists, and prose formatting tags. LLM tokenizers parse YAML with significantly fewer tokens while retaining clear key-value semantic boundaries, minimizing instruction drift and context consumption.
- **Graphyard Mapping (`agent instructions and context`, `token cost`)**: Graphyard prompts (`AGENTS.md`, master instructions, and worker launch payloads) consist of multi-page narrative Markdown with extensive discursive repetition. This consumes significant context window capacity before the agent inspects any repository source code.

### 3. Strict Pre-Edit Discipline and Deterministic Error Recovery
- **Mechanism**: Rules R14 (`R14_FileEditPreparation`) and R15 (`R15_FileEditErrorRecovery`) in `config/.roo/system-prompt-flow-code:929-939` mandate that before any file edit (`apply_diff`, `write_to_file`), the agent must read the fresh file content with line numbers. If an edit fails, the agent must immediately re-read the entire file to verify line numbers; upon a second diff failure, the agent deterministically falls back to rewriting the whole file.
- **Why it works**: Prevents hallucinated line numbers, stale patch application, and infinite retry loops on mismatched whitespace or offsets.
- **Graphyard Mapping (`agent instructions and context`)**: Graphyard worker prompt guidelines do not enforce a rigid pre-edit re-read and fallback protocol. Workers frequently fail diff applications, loop repeatedly on stale line numbers, and exhaust their lease epochs.

### 4. Role-Constrained Tool Privileges
- **Mechanism**: Modes in `config/.roomodes` partition capabilities strictly at the configuration level: `flow-orchestrator` has read, browser, and MCP tools, but cannot edit files; `flow-architect` can edit documentation and memory files, but cannot execute arbitrary shell commands; `flow-ask` is strictly read-only.
- **Why it works**: Prevents orchestrators or advisory agents from making premature code modifications, and prevents unprivileged modes from causing destructive side effects.
- **Graphyard Mapping (`orchestration`, `dispatch`)**: Graphyard already scopes tools by role, for Claude sessions under a repository that carries Claude settings. `sessionHarnessPlan` (`src/master/harness.ts`) builds each role's rules and `prepareSessionHarness` writes them to `.graphyard/harness/<role>-<profile>.json`, loaded with `--setting-sources user --settings FILE` in place of the repository's settings: workers get the worktree plan from `workerHarnessPlan` (push only to their assigned branch, no trusted evidence, no review verdicts); reviewers are read-only (`Edit` and `Write` denied, no commit or push, one verdict on their own pull request); proof producers are denied secrets, pushes/commits, and review verdicts, but `Edit` and `Write` are not denied. Those are tool rules only: under `bypassPermissions` an unmatched shell write (`sed -i`, a redirection) still runs, and the coordinator confinement (`sessionConfinement` in `src/master/launch.ts`) makes the coordinator root read-only while leaving the session's own allocated checkout writable. The remaining gaps are: no producer write protection at either the tool or the shell level; no role file at all when the managed repository has no `.claude/settings.json` or `.claude/settings.local.json` (`prepareSessionHarness` then returns no file and no arguments, so the session runs on the operator's user settings alone); and non-Claude sessions (Codex, opencode, Cursor, Pi) load no generated rules, leaving role boundaries to the lease, credentials, the coordinator confinement and branch protection.

### 5. Architectural Decision Logging Decoupled from Code Diffs
- **Mechanism**: RooFlow prompts enforce immediate, real-time logging of architectural decisions, rationale, and consequences to `decisionLog.md` (`config/.roo/system-prompt-flow-architect:1127-1146`) whenever a design choice is made.
- **Why it works**: Git commit messages and PR diffs show *what* changed, but rarely capture *why* specific alternative approaches were rejected. An explicit decision log prevents subsequent sessions from re-introducing previously discarded designs.
- **Graphyard Mapping (`review`, `task decomposition`)**: Graphyard records decisions only when the master coordinator requests formal administrative decisions (`graphyard master decide`). Micro-architectural choices made by implementation workers are buried in commit messages or lost when branches rebase.

### 6. Dynamic, Selective Context Retrieval via ConPort
- **Mechanism**: The ConPort strategy (`config/roo_code_conport_strategy:305-346`) uses targeted full-text search (`search_decisions_fts`), semantic search (`semantic_search_conport`), and graph-link traversal (`get_linked_items`) to retrieve a minimal, highly relevant context set (top 3–5 items) rather than dumping large files into the prompt.
- **Why it works**: Balances deep historical context with prompt token budgets, ensuring context window scalability as projects grow.
- **Graphyard Mapping (`agent instructions and context`, `token cost`)**: Graphyard lacks a local searchable knowledge index for historical decisions, closed items, or component contracts. Workers must rely on full-file reads, broad grep scans, or manual documentation navigation.

---

## 3. What Graphyard Already Does Better

1. **Transactional, Multi-Agent Control Plane**:
   - RooFlow is entirely client-side, running in a single user's VS Code instance without transactional concurrency controls, state locking, or tamper-proof persistence.
   - Graphyard manages a fleet of concurrent coding agents across multiple runtimes (Herdr, Claude, Cursor, Codex, opencode, Pi, Antigravity) using a robust PostgreSQL-backed state engine (`src/store/`), transactional mutations, and strict lease epoch fencing.

2. **Full Autonomous Delivery Pipeline with Independent Verification**:
   - RooFlow relies on self-reported completion (`attempt_completion`) and has no automated gates, independent review requirements, or objective verification.
   - Graphyard implements a strict autonomous delivery pipeline (`Ready → Build → Review → Test → Acceptance → Merge → Done`). Changes cannot merge on worker self-attestation; independent reviewer identities must review, and independent proof producers must execute automated test proofs against the exact candidate commit.

3. **Strict Autonomy Contract (Agents Approve Agents)**:
   - RooFlow repeatedly blocks waiting for human approval on individual tool uses, file modifications, mode switches, and setup confirmations (`tool_use_protocol:26`).
   - Graphyard enforces complete agent autonomy: agents act without asking, and agents approve agents. Only three decisions are reserved for humans (goals/priorities, financial/account actions, issuing personal credentials). All other operational decisions are settled autonomously by peer approver agents.

4. **Proof Exercise Requirements**:
   - RooFlow has no concept of test validity or proof integrity.
   - Graphyard requires proof exercise (`docs/master-agent.md:75-84`): automated test proofs are rerun with the criterion's implementation removed to verify that the proof genuinely fails when the required behavior is absent, preventing false-positive tests from passing gates.

5. **Production Deployment Lifecycle and Invariant Monitoring**:
   - RooFlow ends at local file edits in a workspace.
   - Graphyard governs the entire software lifecycle through guarded merge queue landing, live deployment verification (`master verify-deployment`), automated rollback handling, and continuous system invariant monitoring (`tests/soak.test.ts`).

---

## 4. Ranked Lessons

### Lesson 1: Structured Attempt Handover Context for Retried Work Items
- **RooFlow Evidence**: `config/.roo/system-prompt-flow-architect:1088-1106` (`activeContext.md`) and `config/roo_code_conport_strategy:39` (`get_recent_activity_summary`).
- **Graphyard Change**: Extend the existing handover rather than add a parallel one. Kept work and the exit reason already reach the successor (`preservePartialWork` in `src/master/launch.ts`, `resumedAttempt` in `src/master/dispatch.ts`). Add the missing diagnostic data — the prior attempt's last observed screen or failing output and the commands it ran — to the record `resumedAttempt` reads, bounded in size, and cover attempts that end by lease expiry or timeout as well as interruption and capacity exhaustion.
- **Expected Gain**: Cuts retry loops where consecutive workers fail identically on the same timeout or unexpected error, beyond what kept commits already save.
- **Effort**: Small.

### Lesson 2: Dense YAML-Structured Instruction Templates for Agent Launch Harnesses
- **RooFlow Evidence**: `modules/rooflow_core_prompt.yaml` and `config/.roomodes`.
- **Graphyard Change**: Convert verbose Markdown system prompts and rule envelopes built by `src/master/dispatch.ts` (`workerPrompt`) and the role text and rules each session loads — the launch authorization written to the transient `.graphyard/launch/NAME.role` file (`writeLaunchFiles` in `src/master/launch.ts`) and the generated harness settings under `.graphyard/harness/` (`prepareSessionHarness` in `src/master/harness.ts`) — into structured YAML blocks specifying identity, role constraints, tool protocols, and execution rules.
- **Expected Gain**: 20–30% reduction in launch prompt token consumption and stronger rule adherence across diverse model runtimes.
- **Effort**: Small.

### Lesson 3: Mandatory Pre-Edit Re-Read and Error Recovery Protocol in Worker Instructions
- **RooFlow Evidence**: Rules R14 (`R14_FileEditPreparation`) and R15 (`R15_FileEditErrorRecovery`) in `config/.roo/system-prompt-flow-code:929-939`.
- **Graphyard Change**: In `workerPrompt` (`src/master/dispatch.ts`), inject explicit behavioral rules requiring workers to obtain fresh file contents with line numbers immediately before diff application, and upon any diff failure to re-read the target file before retrying (falling back to whole-file replacement on a second failure).
- **Expected Gain**: Slashes failed diff attempts, corrupted edits, and token churn during the implementation phase.
- **Effort**: Small.

### Lesson 4: Persistent Repository Decision Log and System Patterns Ledger
- **RooFlow Evidence**: `memory-bank/decisionLog.md` and `memory-bank/systemPatterns.md` in `config/.roo/system-prompt-flow-architect:1127-1166`.
- **Graphyard Change**: Add a standard repository directory (`docs/decisions/` or `.graphyard/decisions.json`) where workers document micro-architectural decisions and recurring patterns as part of their PR submission, verified during code review.
- **Expected Gain**: Prevents architectural drift across concurrent work items and stops workers from re-litigating settled design choices.
- **Effort**: Medium.

### Lesson 5: Role-Constrained Toolsets at the Launcher Boundary
- **RooFlow Evidence**: Tool group assignments per mode in `config/.roomodes` (Orchestrator and Ask modes restricted from file editing; Architect restricted from command execution).
- **Graphyard Change**: Role-scoped rules already exist for Claude sessions under a repository that carries Claude settings (`sessionHarnessPlan` and `prepareSessionHarness` in `src/master/harness.ts`: read-only reviewers with denied Edit/Write, push/commit/verdict-denied producers, branch-scoped workers). Evaluate the remaining gaps: give proof producers write protection on their detached checkouts — explicit `Edit` and `Write` denials in the Claude producer harness together with shell-write confinement (for example mounting the producer's checkout read-only, with a separate writable scratch directory for proof output), since tool denials alone leave `sed -i` and redirections running under `bypassPermissions`; write the role file for every Claude session, including under a repository with no `.claude/settings.json` or `.claude/settings.local.json`; carry the role boundaries to the other worker runtimes through their own configuration where they offer one; and consider scoping worker edits to `plannedFiles`.
- **Expected Gain**: Least-privilege tool boundaries on every runtime and every managed repository, not only Claude sessions under repositories with Claude settings, and write protection on proof producers so a producer cannot modify code or dirty its checkout by accident. Claude reviewers already have `Edit` and `Write` denied, so on Claude this gain is the producers' alone, plus the shell-level confinement that reviewers lack too.
- **Effort**: Medium.

### Lesson 6: Searchable Historical Knowledge Base for Completed Work Items
- **RooFlow Evidence**: ConPort MCP strategy in `config/roo_code_conport_strategy:305-346` (`context_portal/context.db`, `search_decisions_fts`, `search_custom_data_value_fts`, `get_item_history`).
- **Graphyard Change**: Expose a CLI command (`graphyard search-context <query>`) and local MCP server backed by full-text and semantic indexing of delivered work items, review findings, and post-mortems stored in the Graphyard database.
- **Expected Gain**: Workers can dynamically query past solutions to related problems without bloating prompt context windows.
- **Effort**: Large.

### Lesson 7: Explicit Knowledge-Graph Relational Linking Between Work Items and Decisions
- **RooFlow Evidence**: ConPort relationship linking in `config/roo_code_conport_strategy:347-386` (`proactive_knowledge_graph_linking`, `link_conport_items`).
- **Graphyard Change**: Extend Graphyard's work item schema with formal relational edge types (`implements_decision`, `supercedes`, `relates_to`, `mitigates_invariant`) and expose them in `graphyard status` and dependency resolution.
- **Expected Gain**: Provides rich traceability from architectural intent to merged pull requests and follow-up items.
- **Effort**: Large.

---

## 5. Ready-to-File Graphyard Work Items

### Work Item 1: Record and Inject Structured Attempt Handover Context for Retried Worker Sessions
- **Description**: The successor of an interrupted or capacity-exhausted worker attempt already receives the prior exit reason and its kept commit, branch and worktree (`preservePartialWork` in `src/master/launch.ts`, `resumedAttempt` in `src/master/dispatch.ts`). Extend that handover with the diagnostics it lacks — the last observed output and the commands the prior attempt ran — and record it for attempts that end by lease expiry or timeout too, so successors stop repeating identical failed trajectories.
- **Acceptance Criteria**:
  - AC-1: When a worker attempt ends before submission by interruption, capacity exhaustion, lease expiry or timeout, Graphyard records on the item, beside the existing partial-work record, a bounded diagnostic summary with the last observed output of the prior session.
  - AC-2: Tests verify that `workerPrompt` for attempt N+1 includes that diagnostic summary alongside the existing kept-work handover, and that an attempt with no recorded diagnostics produces the same prompt as today.

### Work Item 2: Adopt YAML-Structured Instruction Templates for Agent Launch Harnesses
- **Description**: Refactor verbose Markdown system prompt templates in Graphyard launch harnesses into schema-validated, compact YAML instruction envelopes. This reduces prompt token overhead across fleet sessions while improving structural rule adherence across diverse model runtimes.
- **Acceptance Criteria**:
  - AC-1: The launcher formats worker, reviewer, and master prompt templates as structured YAML conforming to an explicit schema defining identity, objective, tool rules, and constraints.
  - AC-2: A test in `tests/prompt-templates.test.ts` validates that generated prompt files parse as valid YAML and measure at least 20% fewer tokens than the corresponding markdown templates.

### Work Item 3: Enforce Surgical Pre-Edit and Edit Recovery Rules in Worker Instructions
- **Description**: Update the worker system prompt generator to inject strict pre-edit requirements mandating fresh line-numbered reads prior to diff operations. Add an error recovery protocol requiring immediate whole-file re-reading upon diff failures with a deterministic fallback to full-file writes on repeat errors.
- **Acceptance Criteria**:
  - AC-1: The worker launch prompt generator incorporates mandatory pre-edit rules requiring fresh file reads with line numbers before executing diff tools and specifies a two-step recovery protocol for failed modifications.
  - AC-2: Unit tests in `tests/worker-prompt-rules.test.ts` assert that generated worker request prompts include the required pre-edit and error-recovery rules.
