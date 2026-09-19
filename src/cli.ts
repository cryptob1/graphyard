// The launcher entry point. Commands live under src/cli/, one module per command group;
// see docs/development.md for where a new command goes.
import { main } from './cli/index.js';

main().catch(error => { console.error(error.message); process.exitCode = 1; });
