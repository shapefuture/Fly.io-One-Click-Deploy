## Phase 1: Security & Core Reliability
- [x] **Hardening the Installer**: Pin specific `flyctl` versions and verify checksums in `backend/lib/installer.js` to prevent supply-chain attacks via the download matrix. #security
- [x] **Input Sanitization**: Implement stricter validation for `repoUrl` and `appName` in `backend/server.js` to prevent command injection risks, even though `execa` is used. #security
- [x] **Token Management**: Ensure `FLY_API_TOKEN` is never logged to stdout/stderr in `backend/server.js` during deployment streams. #security
- [x] **Volume Logic Robustness**: Refactor the regex-based volume detection in `backend/server.js` to use a proper TOML parser (like `@iarna/toml`) for reliability. #reliability

## Phase 2: Backend Refactoring & Architecture
- [x] **Modularize Server**: Extract route handlers from `backend/server.js` into dedicated controllers (`controllers/deploy.js`, `controllers/analyze.js`) to reduce file size and complexity. #refactor
- [x] **Unified Type System**: Add JSDoc type annotations to backend services (`lib/git.js`, `strategies/ai.js`) to improve developer experience and catch type errors. #dx
- [x] **Structured Logging**: Replace `console.log` with a structured logger (e.g., `winston` or `pino`) for better observability in production. #ops

## Phase 3: AI & Analysis Engine Enhancements
- [ ] **Context Window Optimization**: Improve the context slicing logic in `backend/strategies/ai.js`. Instead of a hard 12000 char limit, prioritize specific files (`package.json` > `Dockerfile` > `fly.toml`) and truncate less critical ones. #ai
- [ ] **Prompt Engineering**: Refine the system prompt in `backend/strategies/ai.js` to explicitly handle multi-stage builds and newer Fly.io machine sizes. #ai
- [ ] **Stack Detector Expansion**: Add specific detection strategies for common frameworks (Next.js, Laravel, Rails) in `backend/lib/stack-detector.js` to bypass AI for well-known patterns (deterministic vs probabilistic). #feature

## Phase 4: Frontend & UX Polish
- [ ] **Error Boundary**: Add a global Error Boundary in React to catch render failures gracefully. #ux
- [ ] **Log Accessibility**: Improve the `DeployConsole` component to support auto-scrolling toggles and "copy all logs" functionality. #ux
- [ ] **Deployment History**: Persist deployment history (status, app URL) to local storage so users don't lose links on refresh. #feature
