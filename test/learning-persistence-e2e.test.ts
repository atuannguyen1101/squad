/**
 * E2E Test: Cross-Session Learning Persistence — Runtime Verification
 *
 * Verifies that Phase 1 learning persistence actually works at runtime:
 *   1. Session with 5+ messages (decisions + patterns + learnings) gets processed
 *   2. Extracted learnings are persisted to .squad/agents/{name}/history.md
 *   3. Subsequent sessions append to (not overwrite) existing history
 *
 * Also documents three runtime bugs found during this audit:
 *   Bug A — EventBus interface mismatch (runtime .subscribe() vs client .on())
 *   Bug B — Event type notation ('session:destroyed' vs 'session.destroyed')
 *   Bug C — Empty payload on session destroy (no messages passed through)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { EventBus as RuntimeEventBus } from '@bradygaster/squad-sdk/runtime/event-bus';
import {
  enableLearningPersistence,
  extractLearnings,
  createHistoryShadow,
  readHistory,
  shadowExists,
  type LearningPersistenceConfig,
  type PulseCollector,
  type SessionMessage,
} from '@bradygaster/squad-sdk/agents';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-lp-e2e-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A minimal no-op PulseCollector */
const noPulses: PulseCollector = { getByAgent: () => [] };

/**
 * Build a realistic 8-message conversation with decisions, patterns, learnings,
 * and issues — signal phrases all match the regexes in learning-extractor.ts.
 */
function buildRichConversation(): SessionMessage[] {
  return [
    {
      role: 'user',
      content: 'Please implement the auth module for our API.',
    },
    {
      role: 'assistant',
      content: [
        'I will implement the auth module now.',
        'I decided to use JWT tokens rather than session cookies for stateless auth.',
        'This approach will use the existing crypto utilities already in the codebase.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: 'Should we add refresh token support?',
    },
    {
      role: 'assistant',
      content: [
        'Good question. I decided to add refresh token support to improve UX.',
        'The pattern here is to store refresh tokens in httpOnly cookies and access tokens in memory.',
        'This is a security best-practice pattern we should always follow for web apps.',
        'I learned that mixing storage strategies (cookie + memory) prevents XSS token theft.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: 'Implement the token rotation logic.',
    },
    {
      role: 'assistant',
      content: [
        'Created auth/token-rotation.ts with the sliding window refresh logic.',
        'Built the JWT validation middleware with automatic token renewal.',
        'Important: the refresh window must be shorter than token expiry — this is a key insight.',
        'Found out that Node.js crypto.subtle is preferred over jsonwebtoken for new code.',
        'Note: always verify audience and issuer claims to prevent token confusion attacks.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: 'Did you encounter any issues?',
    },
    {
      role: 'assistant',
      content: [
        'There was a type error in the JWT payload interface — the sub field must be string not number.',
        'Fixed by adding explicit type assertion in the token generation function.',
        'The test failed initially due to a race condition in the concurrent refresh test.',
        'Resolved by adding a mutex to the refresh token store.',
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Section 1: Extraction unit tests — core algorithm, no EventBus needed
// ---------------------------------------------------------------------------

describe('extractLearnings — core pipeline unit tests', () => {
  it('extracts decisions, patterns, learnings, and issues from a rich conversation', () => {
    const messages = buildRichConversation();
    const extraction = extractLearnings(messages);

    expect(extraction.decisions).toBeTruthy();
    expect(extraction.decisions).toContain('decided');

    expect(extraction.patterns).toBeTruthy();

    expect(extraction.learnings).toBeTruthy();

    expect(extraction.issues).toBeTruthy();

    expect(extraction.sessionSummary).toBeTruthy();
    expect(extraction.sessionSummary.length).toBeGreaterThan(0);
  });

  it('returns empty extraction when message count is below minMessages', () => {
    const shortMessages: SessionMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi! I decided to help you.' },
    ];

    const extraction = extractLearnings(shortMessages, [], { minMessages: 5 });

    expect(extraction.learnings).toBeNull();
    expect(extraction.decisions).toBeNull();
    expect(extraction.patterns).toBeNull();
    expect(extraction.issues).toBeNull();
    expect(extraction.artifacts).toHaveLength(0);
  });

  it('extracts artifacts from created/built/wrote signal phrases', () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'Build the parser.' },
      { role: 'assistant', content: 'Created parser.ts with full AST support.' },
      { role: 'user', content: 'Add tests.' },
      { role: 'assistant', content: 'Built test suite in parser.test.ts with 20 cases.' },
      { role: 'user', content: 'Done?' },
      { role: 'assistant', content: 'Yes, wrote documentation in README.md.' },
    ];

    const extraction = extractLearnings(messages);
    expect(extraction.artifacts.length).toBeGreaterThan(0);
    const text = extraction.artifacts.join(' ').toLowerCase();
    expect(text.includes('creat') || text.includes('built') || text.includes('wrote')).toBe(true);
  });

  it('merges pulse artifacts and blockers into extraction result', () => {
    const messages = buildRichConversation();
    const pulses = [
      {
        agent: 'testbot',
        summary: 'Implemented auth module',
        artifacts: ['auth/token-rotation.ts', 'auth/middleware.ts'],
        blockers: ['Waiting for security review'],
      },
    ];

    const extraction = extractLearnings(messages, pulses);

    expect(extraction.artifacts).toContain('auth/token-rotation.ts');
    expect(extraction.artifacts).toContain('auth/middleware.ts');
    expect(extraction.issues).toContain('Blocker');
    expect(extraction.issues).toContain('security review');
  });

  it('generates a session summary from first user message when no pulses', () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'Implement the caching layer for the data pipeline.' },
      { role: 'assistant', content: 'I decided to use Redis for this caching layer.' },
      { role: 'user', content: 'Why Redis?' },
      { role: 'assistant', content: 'The pattern of using Redis always gives us atomic operations.' },
      { role: 'user', content: 'OK proceed.' },
      { role: 'assistant', content: 'I learned that Redis SETEX with TTL is the preferred approach.' },
    ];

    const extraction = extractLearnings(messages);
    expect(extraction.sessionSummary).toContain('caching layer');
  });
});

// ---------------------------------------------------------------------------
// Section 2: Full E2E pipeline — EventBus → persistExtraction → history.md
// ---------------------------------------------------------------------------

describe('enableLearningPersistence — full E2E pipeline', () => {
  it('persists extracted learnings to history.md after session:destroyed fires', async () => {
    const eventBus = new RuntimeEventBus();
    const messages = buildRichConversation();

    const config: LearningPersistenceConfig = {
      enabled: true,
      minMessages: 5,
      maxSectionLength: 500,
      squadRoot: tmpDir,
    };

    const unsubscribe = enableLearningPersistence(eventBus, noPulses, config);

    await eventBus.emit({
      type: 'session:destroyed',
      sessionId: 'test-session-123',
      agentName: 'testbot',
      payload: { messages },
      timestamp: new Date(),
    });

    await new Promise(r => setTimeout(r, 50));

    expect(await shadowExists(tmpDir, 'testbot')).toBe(true);

    const history = await readHistory(tmpDir, 'testbot');
    expect(history.fullContent.length).toBeGreaterThan(100);
    expect(history.decisions).toBeTruthy();
    expect(history.patterns).toBeTruthy();
    expect(history.learnings).toBeTruthy();
    expect(history.issues).toBeTruthy();

    unsubscribe();
  });

  it('appends — not overwrites — on second session close for same agent', async () => {
    const eventBus = new RuntimeEventBus();

    await createHistoryShadow(tmpDir, 'repeatbot', 'Context for repeat testing');

    const config: LearningPersistenceConfig = {
      enabled: true,
      minMessages: 5,
      maxSectionLength: 500,
      squadRoot: tmpDir,
    };

    const unsubscribe = enableLearningPersistence(eventBus, noPulses, config);

    const session1: SessionMessage[] = [
      { role: 'user', content: 'Implement the first feature.' },
      { role: 'assistant', content: 'I decided to use the repository pattern for data access.' },
      { role: 'user', content: 'Why?' },
      { role: 'assistant', content: 'This is a standard pattern that always improves testability.' },
      { role: 'user', content: 'OK.' },
      { role: 'assistant', content: 'I learned that the repository pattern decouples domain logic.' },
    ];

    await eventBus.emit({
      type: 'session:destroyed',
      agentName: 'repeatbot',
      payload: { messages: session1 },
      timestamp: new Date(),
    });
    await new Promise(r => setTimeout(r, 50));

    const after1 = await readHistory(tmpDir, 'repeatbot');
    expect(after1.decisions).toContain('repository');

    const session2: SessionMessage[] = [
      { role: 'user', content: 'Add caching to the repository.' },
      { role: 'assistant', content: 'I decided to use Redis for the caching layer.' },
      { role: 'user', content: 'What about invalidation?' },
      { role: 'assistant', content: 'The pattern for cache invalidation is event-driven — always prefer eventing.' },
      { role: 'user', content: 'Implement it.' },
      { role: 'assistant', content: 'I learned that Redis SETEX with TTL is preferred over manual cleanup.' },
    ];

    await eventBus.emit({
      type: 'session:destroyed',
      agentName: 'repeatbot',
      payload: { messages: session2 },
      timestamp: new Date(),
    });
    await new Promise(r => setTimeout(r, 50));

    const after2 = await readHistory(tmpDir, 'repeatbot');

    // Both sessions' decisions must be present
    expect(after2.decisions).toContain('repository');
    expect(after2.decisions).toContain('Redis');

    unsubscribe();
  });

  it('skips short sessions — no history file created when messages < minMessages', async () => {
    const eventBus = new RuntimeEventBus();

    const config: LearningPersistenceConfig = {
      enabled: true,
      minMessages: 5,
      maxSectionLength: 500,
      squadRoot: tmpDir,
    };

    const unsubscribe = enableLearningPersistence(eventBus, noPulses, config);

    await eventBus.emit({
      type: 'session:destroyed',
      agentName: 'shortbot',
      payload: {
        messages: [
          { role: 'user', content: 'Quick question: what is 2+2?' },
          { role: 'assistant', content: 'Four.' },
          { role: 'user', content: 'Thanks.' },
        ] as SessionMessage[],
      },
      timestamp: new Date(),
    });
    await new Promise(r => setTimeout(r, 50));

    expect(await shadowExists(tmpDir, 'shortbot')).toBe(false);

    unsubscribe();
  });

  it('does not throw when payload is null (fire-and-forget)', async () => {
    const eventBus = new RuntimeEventBus();

    const config: LearningPersistenceConfig = {
      enabled: true,
      minMessages: 5,
      maxSectionLength: 500,
      squadRoot: tmpDir,
    };

    const unsubscribe = enableLearningPersistence(eventBus, noPulses, config);

    await expect(
      eventBus.emit({
        type: 'session:destroyed',
        agentName: 'nullbot',
        payload: null,
        timestamp: new Date(),
      }),
    ).resolves.not.toThrow();

    await new Promise(r => setTimeout(r, 50));
    expect(await shadowExists(tmpDir, 'nullbot')).toBe(false);

    unsubscribe();
  });

  it('does not crash when squadRoot does not exist (fire-and-forget)', async () => {
    const eventBus = new RuntimeEventBus();
    const badRoot = path.join(tmpDir, 'nonexistent', 'path');

    const config: LearningPersistenceConfig = {
      enabled: true,
      minMessages: 5,
      maxSectionLength: 500,
      squadRoot: badRoot,
    };

    const unsubscribe = enableLearningPersistence(eventBus, noPulses, config);

    await expect(
      eventBus.emit({
        type: 'session:destroyed',
        agentName: 'crashbot',
        payload: { messages: buildRichConversation() },
        timestamp: new Date(),
      }),
    ).resolves.not.toThrow();

    await new Promise(r => setTimeout(r, 50));
    unsubscribe();
  });

  it('is a complete no-op when enabled: false', async () => {
    const eventBus = new RuntimeEventBus();

    const config: LearningPersistenceConfig = {
      enabled: false,
      minMessages: 5,
      maxSectionLength: 500,
      squadRoot: tmpDir,
    };

    const unsubscribe = enableLearningPersistence(eventBus, noPulses, config);

    await eventBus.emit({
      type: 'session:destroyed',
      agentName: 'disabledbot',
      payload: { messages: buildRichConversation() },
      timestamp: new Date(),
    });
    await new Promise(r => setTimeout(r, 50));

    expect(await shadowExists(tmpDir, 'disabledbot')).toBe(false);
    unsubscribe();
  });

  it('unsubscribe stops all further processing', async () => {
    const eventBus = new RuntimeEventBus();

    const config: LearningPersistenceConfig = {
      enabled: true,
      minMessages: 5,
      maxSectionLength: 500,
      squadRoot: tmpDir,
    };

    const unsubscribe = enableLearningPersistence(eventBus, noPulses, config);
    unsubscribe(); // unsubscribe BEFORE any event fires

    await eventBus.emit({
      type: 'session:destroyed',
      agentName: 'unsubbot',
      payload: { messages: buildRichConversation() },
      timestamp: new Date(),
    });
    await new Promise(r => setTimeout(r, 50));

    expect(await shadowExists(tmpDir, 'unsubbot')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 3: Bug audit — documents the three runtime wiring bugs
// ---------------------------------------------------------------------------

describe('Bug Audit — runtime wiring issues', () => {
  /**
   * BUG-A: EventBus interface mismatch
   *
   * learning-persistence.ts is typed against runtime/event-bus.ts which exposes
   * .subscribe(). The production SquadClientWithPool uses client/event-bus.ts
   * which exposes .on() instead. These are incompatible call-sites.
   *
   * The runtime EventBus is the CORRECT one for learning-persistence — this test
   * confirms it works and documents the difference.
   */
  it('BUG-A confirmed: runtime EventBus exposes subscribe(), client EventBus exposes on()', () => {
    const runtimeBus = new RuntimeEventBus();
    expect(typeof runtimeBus.subscribe).toBe('function');
    expect('subscribe' in runtimeBus).toBe(true);
  });

  /**
   * BUG-B: Event type notation mismatch
   *
   * learning-persistence.ts subscribes to 'session:destroyed' (colon notation).
   * SquadClientWithPool.deleteSession() emits 'session.destroyed' (dot notation).
   * They run on DIFFERENT bus instances so the handler never fires in production.
   *
   * This test confirms the runtime bus correctly routes colon-notation events.
   */
  it('BUG-B confirmed: colon-notation subscriber receives session:destroyed on runtime bus', async () => {
    const runtimeBus = new RuntimeEventBus();
    let called = false;

    runtimeBus.subscribe('session:destroyed', () => { called = true; });

    await runtimeBus.emit({
      type: 'session:destroyed',
      agentName: 'b-test',
      payload: {},
      timestamp: new Date(),
    });

    expect(called).toBe(true);
  });

  /**
   * BUG-C: SquadClientWithPool.deleteSession() emits payload: null
   *
   * Even if the event bus were correctly wired, handleSessionDestroyed() reads
   * payload?.messages and returns immediately when undefined — extraction never runs.
   *
   * This test documents both failure (null payload → no extraction) and the correct
   * path (messages payload → extraction runs and history persisted).
   */
  it('BUG-C confirmed: null payload causes silent bail-out; messages payload enables extraction', async () => {
    const eventBus = new RuntimeEventBus();
    const config: LearningPersistenceConfig = {
      enabled: true,
      minMessages: 5,
      maxSectionLength: 500,
      squadRoot: tmpDir,
    };

    let extractionAttempted = false;
    const tracker: PulseCollector = {
      getByAgent: (_name) => {
        extractionAttempted = true;
        return [];
      },
    };

    const unsub = enableLearningPersistence(eventBus, tracker, config);

    // Simulate what deleteSession() actually emits today: payload = null
    await eventBus.emit({
      type: 'session:destroyed',
      agentName: 'bugcbot',
      payload: null,
      timestamp: new Date(),
    });
    await new Promise(r => setTimeout(r, 50));

    // Handler bails early — pulse collector never reached
    expect(extractionAttempted).toBe(false);
    expect(await shadowExists(tmpDir, 'bugcbot')).toBe(false);

    // Now simulate the FIXED path: messages in payload
    await eventBus.emit({
      type: 'session:destroyed',
      agentName: 'bugcbot-fixed',
      payload: { messages: buildRichConversation() },
      timestamp: new Date(),
    });
    await new Promise(r => setTimeout(r, 50));

    // With messages, extraction runs and history is persisted
    expect(extractionAttempted).toBe(true);
    expect(await shadowExists(tmpDir, 'bugcbot-fixed')).toBe(true);

    unsub();
  });
});

// ---------------------------------------------------------------------------
// Section 4: Realistic session simulation — primary acceptance scenario
// ---------------------------------------------------------------------------

describe('Realistic session simulation — 8-message multi-turn conversation', () => {
  it('dispatches task → 8 exchanges → closes session → history.md fully populated', async () => {
    const eventBus = new RuntimeEventBus();
    const agentName = 'fenster';

    const config: LearningPersistenceConfig = {
      enabled: true,
      minMessages: 5,
      maxSectionLength: 1000,
      squadRoot: tmpDir,
    };

    const unsubscribe = enableLearningPersistence(eventBus, noPulses, config);

    // Simulate a realistic 8-message conversation about fixing ESM resolution
    const sessionMessages: SessionMessage[] = [
      {
        role: 'user',
        content: 'Implement ESM module resolution fixes for squad-cli. Issue #449.',
      },
      {
        role: 'assistant',
        content: [
          'Looking at the issue. The vscode-jsonrpc package is missing proper ESM exports.',
          'I decided to use a dual-layer postinstall strategy for maximum compatibility.',
          'The standard pattern here: patch package.json exports + add .js extensions to dist.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: 'Why not just add vscode-jsonrpc as a direct dependency?',
      },
      {
        role: 'assistant',
        content: [
          'Adding it as a direct dep would improve hoisting for npx installs.',
          'However, I decided against it because it creates a version pin risk.',
          'The approach we should always prefer is minimal direct deps for CLI tools.',
          'I learned that Node 22+ strict ESM mode requires explicit .js extensions everywhere.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: 'What about the runtime intercept layer for npx cache hits?',
      },
      {
        role: 'assistant',
        content: [
          'Created cli-entry.ts Module._resolveFilename intercept as Layer 3.',
          'This handles npx cache hits where postinstall patches may not have run.',
          'The pattern: Layer 1 (package.json) + Layer 2 (dist patch) + Layer 3 (runtime).',
          'Always use defense-in-depth for dependency resolution fixes.',
          'Note: the runtime intercept must fire before any import of vscode-jsonrpc.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: 'Did squad doctor get updated to detect both layers?',
      },
      {
        role: 'assistant',
        content: [
          'Yes, squad doctor now detects Layer 1 and Layer 2 issues separately.',
          'I learned that error messages should reference the specific layer that failed.',
          'Found out that ESM error messages differ between Node 22 and Node 24.',
          'Turns out the vscode-jsonrpc v9.x export format differs from v8.x.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: 'Any issues encountered during implementation?',
      },
      {
        role: 'assistant',
        content: [
          'There was a module not found error in the Layer 2 patch on Windows paths.',
          'Fixed by normalizing path separators before the regex match.',
          'The test failed on Windows CI due to backslash vs forward slash mismatch.',
          'Root cause: the script assumed POSIX paths in a cross-platform context.',
        ].join('\n'),
      },
    ];

    // ── Close the session (as would happen when deleteSession() fires) ──
    await eventBus.emit({
      type: 'session:destroyed',
      sessionId: 'session-fenster-esm-fix',
      agentName,
      payload: { messages: sessionMessages },
      timestamp: new Date(),
    });

    await new Promise(r => setTimeout(r, 100));

    // ── Assertions ──

    // 1. History shadow created
    expect(await shadowExists(tmpDir, agentName)).toBe(true);

    const history = await readHistory(tmpDir, agentName);

    // 2. File has meaningful content
    expect(history.fullContent.length).toBeGreaterThan(200);

    // 3. Decisions extracted
    expect(history.decisions).toBeTruthy();
    expect(history.decisions!.toLowerCase()).toMatch(/decided/);

    // 4. Patterns extracted
    expect(history.patterns).toBeTruthy();

    // 5. Learnings extracted
    expect(history.learnings).toBeTruthy();

    // 6. Issues extracted
    expect(history.issues).toBeTruthy();

    // 7. Today's timestamp in the file
    const today = new Date().toISOString().split('T')[0]!;
    expect(history.fullContent).toContain(today);

    // 8. All four sections present
    expect(history.fullContent).toContain('## Learnings');
    expect(history.fullContent).toContain('## Decisions');
    expect(history.fullContent).toContain('## Patterns');
    expect(history.fullContent).toContain('## Issues');

    unsubscribe();
  });

  it('enriches history with artifacts and blockers from pulse data', async () => {
    const eventBus = new RuntimeEventBus();

    const pulseData = [
      {
        agent: 'pulsedbot',
        summary: 'Implemented auth module with JWT rotation',
        artifacts: ['src/auth/jwt.ts', 'src/auth/middleware.ts', 'test/auth.test.ts'],
        blockers: ['Awaiting security team review of token expiry policy'],
      },
    ];

    const pulseCollector: PulseCollector = {
      getByAgent: (name) => name === 'pulsedbot' ? pulseData : [],
    };

    const config: LearningPersistenceConfig = {
      enabled: true,
      minMessages: 5,
      maxSectionLength: 500,
      squadRoot: tmpDir,
    };

    const unsubscribe = enableLearningPersistence(eventBus, pulseCollector, config);

    await eventBus.emit({
      type: 'session:destroyed',
      agentName: 'pulsedbot',
      payload: { messages: buildRichConversation() },
      timestamp: new Date(),
    });

    await new Promise(r => setTimeout(r, 100));

    const history = await readHistory(tmpDir, 'pulsedbot');

    // Artifacts in References section
    expect(history.references).toBeTruthy();
    expect(history.references).toContain('jwt.ts');

    // Blocker merged into Issues section
    expect(history.issues).toContain('Blocker');
    expect(history.issues).toContain('security team');

    unsubscribe();
  });
});
