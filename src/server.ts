// The HTTP entry point. Routes live under src/server/routes/, one module per resource,
// and src/server/index.ts assembles them; see docs/development.md for where a new route goes.
import { pathToFileURL } from 'node:url';
import { main } from './server/main.js';

export { server, principalSchema, type Credential } from './server/index.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exit(1); });
