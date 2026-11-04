import { createServer } from 'node:http';

/** Deterministic wire peer for the installed Codex binary; no login or paid request. */
export async function runtimeLaunchProvider() {
  const requests: unknown[] = [];
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    await ready;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const toolResult = payload.input?.some((item: { type: string }) => item.type === 'function_call_output');
    const tool = payload.tools?.find((tool: { name: string }) => ['exec_command', 'shell_command', 'shell'].includes(tool.name));
    const item = toolResult
      ? { id: 'msg_launch', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'runtime-request-completed', annotations: [] }] }
      : { id: 'fc_launch', type: 'function_call', status: 'completed', call_id: 'call_launch', name: tool?.name ?? 'exec_command', arguments: JSON.stringify(tool?.name === 'shell' ? { command: ['/bin/sh', '-c', 'printf runtime-tool-completed'] } : tool?.name === 'shell_command' ? { command: 'printf runtime-tool-completed' } : { cmd: 'printf runtime-tool-completed' }) };
    const event = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('response.created', { response: { id: 'resp_launch', status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    if (toolResult) event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'runtime-request-completed' });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id: 'resp_launch', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    requests,
    release,
    args: ['--ask-for-approval', 'never', 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write',
      '-c', 'model_provider="launch_test"', '-c', 'model="launch-test"',
      '-c', 'model_providers.launch_test.name="Launch regression"',
      '-c', `model_providers.launch_test.base_url="http://localhost:${port}/v1"`,
      '-c', 'model_providers.launch_test.wire_api="responses"',
      '-c', 'model_providers.launch_test.requires_openai_auth=false',
      '-c', 'model_providers.launch_test.request_max_retries=0',
      '-c', 'model_providers.launch_test.stream_max_retries=0'],
    close: () => new Promise<void>((resolve, reject) => { release(); server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}
