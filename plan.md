# Universal Fly.io Deployer: Architectural Analysis & Modernization Plan

This document analyzes the current "Proxy-biased" state of the deployer and outlines a multi-phase strategic plan to transform it into a truly agnostic, production-grade DevOps platform.

## 1. First Principles Analysis

### Current Execution Model: "Hardcoded Heuristics"
The current tool uses a **"Happy Path + Specific Patches"** model.
1. **Ingest**: GitHub URL → Zip Download.
2. **Analyze**: Single-pass LLM query mixed with hardcoded string checks (e.g., `repo.includes('sniproxy')`).
3. **Patch**: Explicit hijacking of configuration if keywords match, overriding AI hallucinations with "known good" hardcoded stubs.
4. **Deploy**: Orchestrates `flyctl` via a high-performance installer designed for serverless environments.

### The "Universal" Challenge
To be universal, the system must transition from **Hardcoded Logic** to **Declarative Stack Detection**. A universal deployer must solve for four independent variables in any repository:
- **Build Primitive**: How do we transform source into a container? (Dockerfile vs. Nixpacks vs. Buildpacks).
- **Compute Contract**: Mapping code requirements to Fly.io hardware (CPU/RAM/Regions).
- **Environment Hydration**: Injecting secrets and runtime variables.
- **Dependency Orchestration**: Provisioning sidecars (Postgres, Redis, Volumes).

---

## 2. Identified Workarounds & Technical Debt

### A. The "Sniproxy" Trap (`backend/server.js:354`)
- **Current Workaround**: Explicitly hijacks the analysis if a repo name matches "sniproxy", forcing a specific Golang Dockerfile and DNS configuration.
- **Risk**: Violates the Open-Closed Principle. Adding a new "complex" app requires code changes to the deployer engine.
- **Strategic Fix**: Implement a **Preset Registry**. The engine should identify "signatures" (files/content) and map them to metadata-driven presets.

### B. Vercel Execution Ceiling
- **Current Workaround**: Aggressive `flyctl` installation in `/tmp` and 60s timeout handling in `vercel.json`.
- **Constraint**: Vercel functions have strict memory and timeout limits that conflict with Docker builds.
- **Workaround**: Remote builds are already used (`--remote-only`), but the SSE connection might drop.
- **Strategic Fix**: Implement **Job Polling/State Persistence**. Move from a "Stream and Forget" model to a "Job ID" model where the frontend can reconnect to a running deployment.

### C. Configuration "Healing" Logic (`backend/server.js:504`)
- **Current Workaround**: Post-analysis regex patching to force `auto_stop_machines = false`.
- **Strategic Fix**: Move from Regex manipulation to **AST-based TOML parsing**. Manipulate the configuration object model directly to ensure structural integrity.

---

## 3. Universal Modernization Plan

### Phase 1: Architectural Decoupling (The "Engine" Refactor)
1. **The Signature Engine**: Replace `if (repo.includes(...))` with a `StackDetector` class that uses glob patterns and file content analysis to generate a `Manifest`.
2. **Strategy Pattern Implementation**: Create `backend/strategies/`. Each strategy (e.g., `NodeJS`, `Go`, `Python`, `Static`) defines its own build logic, default `fly.toml` shapes, and required environment variables.
3. **Abstract Analyzer**: Stage 1 AI detects the stack; Stage 2 AI generates the specific config for that detected stack. This reduces "LLM Context Drift."

### Phase 2: Compute & Storage Primitives
1. **Volume Provisioning**: Support detection of SQLite or Upload folders. If detected, generate `fly volumes create` commands in the deployment queue.
2. **Database Auto-Link**: If `Prisma`, `TypeORM`, or `Drizzle` is detected, the UI should prompt: "This app seems to need a database. Create a Fly Postgres cluster?".
3. **Multi-Region Awareness**: Allow the analyzer to suggest "Regional Proximity" based on common latency patterns for specific stacks (e.g., placing DB and App in the same region).

### Phase 3: Advanced Environment & Secrets
1. **Build-Time Secrets**: Support for `FLY_BUILD_ARG` and `FLY_SECRET` injection. Crucial for apps that fetch private npm packages during the build phase.
2. **Dynamic Env Mapping**: Mapping detected environment variables (e.g., `PORT`, `DATABASE_URL`) to Fly.io's internal metadata (e.g., `.internal` addresses).

### Phase 4: Reliability & Enterprise UX
1. **Detached Runner Capability**: Allow the backend to survive Vercel function termination by offloading the `execa` call to a long-running process if detected (or providing a "Self-Host" instructions for the Deployer itself).
2. **Deployment Health Verification**: Instead of just waiting for the CLI to finish, the tool should perform an active `fetch()` to the app's health-check path and verify the `200 OK` from the perspective of the user.

---

## 4. Strategic Execution Roadmap

| Step | Action | Impact | Status |
| :--- | :--- | :--- | :--- |
| **1** | **Lib Extraction** | Move `installer.js` and `git.js` out of `server.js` to enable unit testing of the core primitives. | [X] |
| **2** | **Preset Migration** | Move "Sniproxy" and "Static" logic into external JSON/JS presets. | [X] |
| **3** | **Refined AI Prompting** | Update Gemini prompts to use `Type.OBJECT` schemas for analysis, removing the need for manual JSON parsing and regex fixes. | [X] |
| **4** | **Volume Provisioning** | Auto-detect `[mounts]` in `fly.toml` and run `fly volumes create` during deployment. | [X] |
| **5** | **Secrets UI** | Add a dynamic key-value editor to the `ConfigStep` for runtime secrets. | [X] |
| **6** | **Pre-flight Checks** | Add a phase to verify token permissions and "Organization" status before starting the remote build. | [X] |
| **7** | **Optimization: Policy Engine** | Extracted hardcoded deployment patches into a dedicated Policy Engine and switched to memory-safe streaming downloads. | [X] |
| **8** | **Bugfix: Invalid Handlers** | Fixed `fly.toml` generation in ProxyStrategy to prevent "Handlers must be one of..." error and added a safety heuristic to PolicyEngine. | [X] |