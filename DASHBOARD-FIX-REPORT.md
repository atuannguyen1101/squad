# Dashboard Fix Report

**Date:** 2026-03-23  
**Issue:** Dashboard not starting, missing HTTP server code in MCP server  
**Status:** ✅ **FIXED**

## Problem

The error "[mcp-bridge] Failed to initialize: this.toolRegistry.registerTool is not a function" was not the real issue. The actual problem was that the dashboard HTTP server code had been removed from `src/mcp/server.ts`.

## Root Cause

Git history analysis showed that commits like `dee8c8b` ("feat: surface dashboard URL in squad_status output") previously included dashboard HTTP server code that:
- Created an HTTP server on port 3850
- Served the dashboard HTML from `squad-cli/src/dashboard/index.html`
- Provided REST API endpoints (/api/status, /api/dispatch, /api/close)
- Returned the dashboard URL in `squad_status` tool responses

This code was removed in subsequent refactoring.

## Changes Made

### 1. Added Missing Imports
```typescript
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
```

### 2. Added Dashboard URL Tracking
```typescript
let dashboardUrl: string | null = null;
```

### 3. Updated squad_status Tool
Added dashboard URL to status output:
```typescript
dashboardUrl ? `Dashboard: ${dashboardUrl}` : null,
```

### 4. Restored Dashboard HTTP Server (125 lines)
- Reads port from `SQUAD_DASHBOARD_PORT` env var (default: 3850)
- Resolves dashboard HTML path (checks multiple locations)
- Creates HTTP server with CORS-enabled API routes:
  - `GET /` → serves index.html
  - `GET /api/status` → server status + events
  - `POST /api/dispatch` → dispatch tasks to agents
  - `POST /api/close` → close agent sessions
- Handles port conflicts (falls back to random port)
- Logs dashboard URL to stderr on successful binding

### 5. Added Eager Server Start
```typescript
ensureStarted().catch(() => {
  process.stderr.write('[squad-mcp] Eager start failed — will retry on first dispatch\n');
});
```

### 6. Updated Shutdown Handler
Added dashboard server cleanup:
```typescript
let dashServer: http.Server | null = null;
const shutdown = async () => {
  process.stderr.write('[squad-mcp] Shutting down...\n');
  if (dashServer) dashServer.close();
  if (started) await server.stop();
  process.exit(0);
};
```

## Verification

### Build
```bash
cd packages/squad-sdk
npx tsc --build --force
# ✓ Build succeeded (no errors)
```

### Compiled Output
- **Before:** `dist/mcp/server.js` = 206 lines
- **After:** `dist/mcp/server.js` = 318 lines
- **Dashboard code present:** ✅ Confirmed (grep for "3850", "dashboardUrl")

### Runtime Test
```bash
SQUAD_ROOT=Q:\work\squad-fork node packages\squad-sdk\dist\mcp\entry.js
```

**Output:**
```
[squad-mcp] Squad MCP server ready (waiting for Copilot)
[squad-mcp] Dashboard: http://localhost:3850
[persistence] Recovered state: 1 session(s) from 2026-03-23T17:21:44.812Z
[squad-mcp] Server connected to Copilot backend
```

**netstat verification:**
```
TCP    0.0.0.0:3850           0.0.0.0:0              LISTENING       129156
TCP    [::]:3850              [::]:0                 LISTENING       129156
```

✅ **Dashboard is now listening on port 3850**

## API Endpoints Restored

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Serve dashboard HTML |
| `/api/status` | GET | Get server status + recent events (100 max) |
| `/api/dispatch` | POST | Dispatch task to agent (JSON: {agentName, message, context?}) |
| `/api/close` | POST | Close agent session (JSON: {agentName}) |

## Notes

- **Removed endpoints:** `/api/sessions/:agent` and `/api/send` were removed because `AgentSessionManager` does not expose `getMessages()` or `sendFollowUp()` methods.
- **Dashboard HTML location:** Must exist at `packages/squad-cli/src/dashboard/index.html` (verified: ✅ exists)
- **Port configuration:** Set `SQUAD_DASHBOARD_PORT` environment variable to change from default 3850
- **Port conflict handling:** If 3850 is in use, server automatically binds to a random available port

## Files Modified

- `packages/squad-sdk/src/mcp/server.ts` (+125 lines)
  - Added imports
  - Added dashboard HTTP server
  - Added eager start
  - Updated shutdown handler
  - Updated squad_status output

## Rebuild Instructions

```bash
cd q:\work\squad-fork\packages\squad-sdk
npx tsc --build --force
```

Then verify with:
```bash
netstat -ano | findstr "3850"
```

---

**Fixed by:** eecom (general-purpose agent)  
**Timestamp:** 2026-03-23T17:42:00Z
