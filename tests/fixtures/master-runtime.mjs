// Executable, credential-free native runtime fixture. Every launch is a real, independent process.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const kind = process.env.GY_RUNTIME, args = process.argv.slice(2), root = process.cwd();
const resumeAt = args.indexOf(kind === 'claude' ? '--resume' : 'resume');
const resume = resumeAt >= 0;
const id = resume ? args[resumeAt + 1] : kind === 'claude' ? args[args.indexOf('--session-id') + 1] : randomUUID();
if (!id || id.startsWith('-')) throw new Error('Missing native session id');
const home = kind === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const transcript = kind === 'claude' ? join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`)
  : join(home, 'sessions', '2026', '11', '01', `rollout-${id}.jsonl`);
if (resume && !existsSync(transcript)) throw new Error('Native resume record is absent');
const prior = existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
mkdirSync(dirname(transcript), { recursive: true });
const row = value => appendFileSync(transcript, JSON.stringify(value) + '\n');
if (!resume && kind === 'codex') row({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { id, cwd: root, timestamp: new Date().toISOString() } });
const input = text => row(kind === 'claude' ? { type: 'user', uuid: randomUUID(), message: { role: 'user', content: text } }
  : { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: randomUUID(), content: [{ type: 'text', text }] } } });
const final = () => row(kind === 'claude' ? { type: 'assistant', uuid: randomUUID(), message: { content: [{ type: 'text', text: 'Completed response' }], stop_reason: 'end_turn' } }
  : { type: 'event_msg', payload: { type: 'task_complete' } });
const request = args.at(-1);
input(request);
// Read the predecessor inside the actual master's namespace. Other account homes are masked by
// the test's outer namespace, so the only route is the managed record the launch names.
const record = /Read its full read-only transcript at (.+) on demand\./.exec(request)?.[1];
const predecessor = record ? readFileSync(record, 'utf8') : null;
let recordWritable = false;
if (record) { try { appendFileSync(record, 'forbidden'); recordWritable = true; } catch {} }
const otherHomeReadable = process.env.GY_OTHER_HOME ? existsSync(join(process.env.GY_OTHER_HOME, 'login-marker')) : false;
const result = { id, transcript, prior, request, predecessor, recordWritable, otherHomeReadable, pid: process.pid };
writeFileSync(process.env.GY_RESULT, JSON.stringify(result));
process.stdout.write('ready\n');
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.input !== undefined) input(command.input);
  if (command.partial) row(kind === 'claude' ? { type: 'assistant', uuid: randomUUID(), message: { content: [{ type: 'text', text: 'Partial response' }], stop_reason: null } }
    : { type: 'event_msg', payload: { type: 'agent_message', message: 'Partial response' } });
  if (command.tool) row(kind === 'claude' ? { type: 'user', uuid: randomUUID(), message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Tool output is not a person message' }] } }
    : { type: 'response_item', payload: { type: 'function_call_output', output: 'Tool output is not a person message' } });
  if (command.final) final();
  process.stdout.write('recorded\n');
}
