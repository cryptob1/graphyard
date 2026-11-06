// The launcher entry point. Commands live under src/cli/, one module per command group.
import { main } from './cli/index.js';

main().catch(error => { console.error(error.message); process.exitCode = error.releaseHandover && process.env.GRAPHYARD_LAUNCHER === '1' ? 75 : 1; });
