# Context windowing

Context windowing keeps agent sessions bounded by auto-summarizing
older messages when the history grows past a threshold. Recent messages
stay verbatim while older ones are compressed into a summary, so the
agent never loses important context but token usage stays predictable.

## How it works

1. Messages accumulate in a session.
2. When the count exceeds `maxMessages`, the engine splits the history:
   everything except the most recent `keepRecent` messages is summarized.
3. The summarized block is replaced with a single system message.
4. State tracks how many passes have occurred and the running summary.

Two summarization strategies are available. The **extractive** built-in
scans for decisions, errors, artifacts, and questions — no LLM needed.
An optional **LLM-based** `summarizer` callback can replace it; if it
throws, the engine falls back to extractive automatically.

## API

| Function | Description |
|----------|-------------|
| `applyContextWindow(messages, state, config?)` | Run a windowing pass. Returns `WindowResult`. |
| `extractiveSummarize(messages, maxLength)` | Built-in summarizer. Extracts key signals. |
| `createContextWindowState()` | Create a fresh zero-counter state. |

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `maxMessages` | 50 | Message count that triggers summarization. |
| `keepRecent` | 10 | Recent messages kept verbatim. |
| `maxSummaryLength` | 2,000 | Max character length for a summary. |
| `summarizer` | — | Optional async LLM summarizer callback. |

## Example

```ts
import { applyContextWindow, createContextWindowState } from './context-window.js';
const state = createContextWindowState();
const result = await applyContextWindow(messages, state, { maxMessages: 40, keepRecent: 8 });
if (result.summarized) console.log(`Compressed ${result.compressedCount} messages`);
```
