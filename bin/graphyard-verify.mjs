#!/usr/bin/env node
// The host verification slot wrapper (GY-612): bin/verification/tsc and bin/verification/npx run
// this with their command's name. A heavy verification run (`tsc --noEmit`, `npx tsc …`) started in
// a Graphyard session takes a host slot first (src/master/verification-slots.ts); anything else
// runs the real command straight away. The real command is the next one on PATH after the wrappers.
import { spawn } from 'node:child_process';
import { tsImport } from 'tsx/esm/api';

const slots = await tsImport('../src/master/verification-slots.ts', import.meta.url);
const [command, ...args] = process.argv.slice(2);
const plan = slots.wrappedCommand(command, args);
if (!plan.real) { console.error(`graphyard: ${command} is not on PATH`); process.exit(127); }
const held = plan.heavy ? await slots.sessionVerificationSlot(`${command} ${args.join(' ')}`.trim()) : null;
const env = { ...process.env, PATH: plan.path, ...(held || process.env[slots.heldVariable] ? { [slots.heldVariable]: '1' } : {}) };
const child = spawn(plan.real, args, { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); held?.release(); process.exit(127); });
child.on('close', (code, signal) => { held?.release(); process.exit(code ?? (signal ? 1 : 0)); });
