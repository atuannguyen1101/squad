# Shared scratchpad

The scratchpad is an ephemeral key-value store that lets agents share
artifacts during a run. Any agent can read any key, and keys are
conventionally namespaced as `agent:artifact-name`. The store is
cleared between runs — nothing persists to disk.

## When to use it

Use the scratchpad when one agent produces data that another agent
needs in the same run (schemas, test results, build output).

## API

| Method | Signature | Description |
|--------|-----------|-------------|
| `write` | `write(key, value, producer, tags?)` | Write or overwrite a key. Returns `{ success, key, created, error? }`. |
| `read` | `read(key)` | Read an entry by key. Returns `ScratchpadEntry \| null`. |
| `list` | `list({ producer?, tag? }?)` | List entries, optionally filtered by producer or tag. |
| `delete` | `delete(key)` | Delete a key. Returns `true` if the key existed. |
| `clear` | `clear()` | Remove all entries (called between runs). |
| `stats` | `stats()` | Return entry count, total size, and per-producer counts. |

## Bounds

- **Max entries:** 200 (configurable via `maxEntries`)
- **Max value size:** 50,000 characters (configurable via `maxValueSize`)

## Events

Subscribe to writes with `onWrite(listener)`. The returned function
unsubscribes the listener. Listener errors never break a write.

## Example

```ts
import { Scratchpad } from './scratchpad.js';

const pad = new Scratchpad();
pad.write('EECOM:schema', 'CREATE TABLE users …', 'EECOM', ['db']);

// Another agent reads the schema
const entry = pad.read('EECOM:schema');
console.log(entry?.value);

// Check usage
const { entryCount, producers } = pad.stats();
```
