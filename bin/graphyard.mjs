#!/usr/bin/env node
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
