// Stands in for the host loop's private trial in fixtures whose subject is not verification:
// every queued worker verification is answered with a passing record of exactly its head.
export function answerHostVerifications(url: string, token: string, host: string) {
  const api = async (path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  const timer = setInterval(() => void (async () => {
    for (const job of await api('worker-verifications/take', { host }))
      await api('worker-verifications/finish', { id: job.id, result: {
        record: { key: job.work.key, head: job.input.head, clean: true, at: new Date().toISOString(), ran: [], outstanding: [] },
        rerun: { flaked: [], baseFailures: [] },
      } });
  })().catch(() => {}), 50);
  return () => clearInterval(timer);
}
