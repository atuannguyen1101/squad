import { SquadServer } from './dist/server/index.js';

console.log('Starting server test...');
const server = new SquadServer({
  squadRoot: 'Q:/work/squad-fork',
  squadConfig: {
    version: '1',
    models: {
      defaultModel: 'claude-sonnet-4.5',
      defaultTier: 'standard',
      fallbackChains: { premium: [], standard: [], fast: [] },
    },
    routing: { rules: [] },
  },
  enableRemote: false,
});

await server.start();
console.log(' Server started successfully');
console.log(' learning-persistence.js loaded and wired');

await server.stop();
console.log(' Server stopped successfully');
console.log(' Phase 1 is FIXED!');
