import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { inspectRunnerRepository, oracleBundleDigest, snapshotRunnerSources } from '../runner-setup.js';
import { accountFileDigest, acknowledgeAttempt, assertRunnerCredentialScope, attemptGrantSchema, authorityWatch, containerNames, executionRecordSchema, observeContainers, runnerPlanSchema } from '../runner-executor.js';
import { assembleResult, collectArtifacts, collectionBinding, collectionInputs, collectorInputSchema, verifyExecutionAttestation } from '../runner-collector.js';
import { superviseAttempt, supervisionRequestSchema } from '../runner-attestor.js';
import { adapterContracts, reportAdapter } from '../report-adapters.js';
import { defineCommands } from './registry.js';

/**
 * Hand one attempt to the operator's host attestor and wait for the record it signed.
 *
 * The runner writes the plan, acknowledges the attempt once the attestor reports a clean
 * preflight, and reads back the execution record and attestation. It observes nothing
 * about the run itself, so there is no execution fact here for it to author: a runner
 * that rewrote the record it forwards would only invalidate the signature over it.
 * Losing attempt authority terminates the attestor, which aborts and settles.
 */
function superviseThroughAttestor(supervisor: { command: string; args: string[] }, request: unknown, acknowledge: () => Promise<void>, signal: AbortSignal, timeoutMs: number) {
  return new Promise<{ record: unknown; attestation: unknown; collection: unknown }>((settled, refused) => {
    const child = spawn(supervisor.command, supervisor.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', diagnostics = '', done = false, acknowledged = false;
    const stop = () => child.kill('SIGTERM');
    const finish = (report: () => void) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', stop); report(); };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (diagnostics.length < 4096) diagnostics += chunk; });
    child.stdout.on('data', chunk => {
      if (out.length > 16_777_216) return;
      out += chunk;
      const end = out.indexOf('\n');
      if (acknowledged || end === -1) return;
      acknowledged = true;
      let ready: any; try { ready = JSON.parse(out.slice(0, end)); } catch { /* reported below */ }
      out = out.slice(end + 1);
      if (ready?.preflight !== 'ready') { child.kill('SIGTERM'); finish(() => refused(new Error('The host attestor did not report a clean preflight; no container was started'))); return; }
      void acknowledge().then(() => child.stdin.end(`${JSON.stringify({ proceed: true })}\n`),
        (error: any) => { child.kill('SIGTERM'); finish(() => refused(error)); });
    });
    child.on('error', () => finish(() => refused(new Error(`The host attestor could not be started, so nothing was executed or acknowledged: ${supervisor.command}`))));
    child.on('close', code => finish(() => {
      const detail = diagnostics.trim() || `exit ${code}`;
      if (!acknowledged) return refused(new Error(`The execution boundary refused before acknowledgement; this attempt was never acknowledged and expires without holding protected resources: ${detail}`));
      try { settled(z.object({ record: executionRecordSchema, attestation: z.unknown(), collection: z.unknown() }).parse(JSON.parse(out))); }
      catch { refused(new Error(`The host attestor returned no signed execution record: ${detail}`)); }
    }));
    // The attestor may refuse and exit before reading the whole request; that is reported
    // through its exit, not as an unhandled pipe error here.
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

/** The packaged Playwright runner: inspection, the runner, the host attestor and the collector. */
export const runnerCommands = defineCommands([
  {
    name: 'runner',
    // The host attestor has a Graphyard credential of its own, read-only and named by an
    // environment variable its own sudo rule sets, so it never reads the connection file.
    readsConnection: id => id !== 'supervise',
    help: [
      '  runner inspect [DIRECTORY]   Discover Playwright inputs without executing repository code',
      '  runner snapshot file.json    Snapshot an explicit source-file list for review (not approval)',
      '  runner bundle-digest DIR      Content identity of an executable oracle bundle for approval',
      '  runner account-digest FILE    Measure an approved test-account env file for registration',
      '  runner adapters               Print each supported report adapter\'s declared contract',
      '  runner verify-report FORMAT INVENTORY REPORT',
      '                                Preview an adapter\'s verdict over two local files (not evidence)',
      '  runner attempt file.json      Hold one dispatched attempt while the host attestor runs it',
      '  runner supervise              Host attestor: run one attempt and attest what it observed',
      '  runner collect file.json      Verify one attempt and publish a trusted result (collector)',
    ],
    async run(context) {
      const { id, args, api, print } = context;
      if (id === 'inspect' && args.length <= 1) return print(await inspectRunnerRepository(resolve(args[0] ?? '.')));
      if (id === 'snapshot' && args.length === 1) return print(await snapshotRunnerSources(process.cwd(), JSON.parse(await readFile(args[0], 'utf8'))));
      if (id === 'bundle-digest' && args.length === 1) return print(await oracleBundleDigest(resolve(args[0])));
      // What an operator registers as `testAccountDigest` on the runner registration. It is
      // read here only to be measured: the entries never leave this process, and approving
      // them is a separate operator action against Graphyard.
      if (id === 'account-digest' && args.length === 1) return print({ testAccountDigest: await accountFileDigest(resolve(args[0])) });
      if (id === 'adapters' && !args.length) return print({ adapters: adapterContracts(), note: 'A format is pinned in the operator-approved bundle definition; the collector verifies only the pinned format and refuses every other structure.' });
      if (id === 'verify-report' && args.length === 3) {
        // A local preview of the pinned adapter's verdict over two files. It reads no attempt
        // authority and publishes nothing: evidence comes only from the collector, over bytes
        // the host attestor measured.
        const adapter = reportAdapter(args[0]);
        const inventory = adapter.parse('inventory', await readFile(resolve(args[1]))), report = adapter.parse('report', await readFile(resolve(args[2])));
        return print({ format: adapter.format, verification: adapter.verify(inventory.document, report.document), publishedReport: JSON.parse(report.published.bytes.toString('utf8')), evidence: false });
      }
      if (id === 'attempt' && args.length === 1) {
        // Runner path. This credential is a worker registration: it can acknowledge and
        // hold attempt authority, but it neither executes nor authors any execution fact.
        const { registration, supervisor, ...plan } = runnerPlanSchema.parse(JSON.parse(await readFile(args[0], 'utf8')));
        assertRunnerCredentialScope(await api('status'));
        const dispatched = await api('validation/dispatch', { registration });
        if (!dispatched.request) return print({ dispatched: false, reason: dispatched.reason });
        const grant = attemptGrantSchema.parse({ requestId: dispatched.request.id, attemptId: dispatched.attempt.id, epoch: dispatched.attempt.epoch,
          runner: registration, bundleDigest: dispatched.bundle.digest, runnerImageDigest: dispatched.bundle.runnerImageDigest, reportFormat: dispatched.bundle.reportFormat,
          executionHost: dispatched.executionAuthority.host, attestationPublicKey: dispatched.executionAuthority.attestationPublicKey,
          executionNetwork: dispatched.executionAuthority.network,
          // Never the runner's own configuration: which approved account material this
          // attempt may run with is operator-versioned authority like the target and network.
          testAccountDigest: dispatched.executionAuthority.testAccountDigest ?? null,
          targetUrl: dispatched.environment.url, deadline: dispatched.request.deadline });
        const attemptCommand = { requestId: grant.requestId, attemptId: grant.attemptId, epoch: grant.epoch };
        // A rejected heartbeat is the server saying this epoch may no longer act. The
        // container boundary fences the host, not the target, so the supervised execution
        // is aborted rather than left exercising the target until the request deadline.
        const authority = new AbortController();
        let beat = 0;
        const attemptAuthority = authorityWatch();
        let heartbeat: NodeJS.Timeout | undefined, authorityDeadline: NodeJS.Timeout | undefined;
        // Acknowledgement happens between the attestor's preflight and its first container.
        // Every local refusal therefore still precedes the ACK: an unacknowledged attempt
        // expires and releases its runner, environment and external reservations, while an
        // acknowledged one holds them until an operator settles it by hand. An ambiguous
        // answer is retried under the same request key and body until the control plane
        // confirms the acknowledgement; heartbeats start only after that confirmation.
        const acknowledge = async () => {
          await acknowledgeAttempt(api, attemptCommand);
          attemptAuthority.renewed();
          heartbeat = setInterval(() => { void api('validation/heartbeat', attemptCommand, `${grant.attemptId}-beat-${++beat}`)
            .then(() => attemptAuthority.renewed())
            .catch((error: unknown) => { attemptAuthority.failed(error); if (attemptAuthority.lost) authority.abort(); }); }, 20_000);
          authorityDeadline = setInterval(() => { if (attemptAuthority.lost) authority.abort(); }, 1_000);
        };
        try {
          const supervised = await superviseThroughAttestor(supervisor, { plan: { ...plan, grant } }, acknowledge, authority.signal, plan.timeoutMs * 2 + 120_000);
          return print({ dispatched: true, environment: { instance: dispatched.environment.instance, url: dispatched.environment.url },
            expected: { instance: dispatched.environment.instance, artifacts: dispatched.build.artifacts }, ...supervised });
        } finally { clearInterval(heartbeat); clearInterval(authorityDeadline); }
      }
      if (id === 'supervise' && args.length === 0) {
        // The operator-controlled host attestor. It runs under an OS identity the worker
        // cannot act as, owns the approved bytes and the signing key, and is reachable from
        // the runner only through this pipe. It signs the attempt it supervised itself; no
        // command anywhere signs an execution record that arrived from somewhere else.
        const keyFile = process.env.GRAPHYARD_ATTESTOR_KEY;
        if (!keyFile) throw new Error('The host attestor requires GRAPHYARD_ATTESTOR_KEY to name its Ed25519 private key; the signing key is never taken from the supervision request');
        const privateFile = async (path: string, subject: string) => {
          const info = await stat(path);
          if (!info.isFile() || info.mode & 0o077) throw new Error(`Host-attestor ${subject} must be a private regular file (mode 0600)`);
          if (info.uid !== (process.getuid?.() ?? -1)) throw new Error(`Host-attestor ${subject} must belong to the supervising identity`);
          return (await readFile(path, 'utf8'));
        };
        const key = await privateFile(keyFile, 'private key');
        // The attestor's own read-only credential and server. Both are named by environment
        // variables the attestor's sudo rule supplies, never by the supervision request: a
        // runner that could choose either would be choosing what "current authority" means.
        const authorityUrl = process.env.GRAPHYARD_ATTESTOR_URL, tokenFile = process.env.GRAPHYARD_ATTESTOR_TOKEN_FILE;
        if (!authorityUrl || !tokenFile) throw new Error('The host attestor requires GRAPHYARD_ATTESTOR_URL and GRAPHYARD_ATTESTOR_TOKEN_FILE; it verifies attempt authority against Graphyard itself rather than trusting the process that invoked it');
        const attestorToken = (await privateFile(tokenFile, 'Graphyard credential')).trim();
        if (!attestorToken) throw new Error('Host-attestor Graphyard credential file is empty');
        const authorityOrigin = new URL(authorityUrl).origin;
        /** What Graphyard currently holds for this attempt. Never what the caller says. */
        const readAttemptAuthority = async (requestId: string) => {
          const response = await fetch(`${authorityOrigin}/api/validation/attempt/${encodeURIComponent(requestId)}`,
            { headers: { Authorization: `Bearer ${attestorToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
          const body = await response.json();
          if (!response.ok) throw new Error(`Attempt authority could not be read independently, so no container was started: ${JSON.stringify(body)}`);
          return z.object({ grant: attemptGrantSchema, state: z.string().min(1).max(50), acknowledged: z.boolean(),
            expiresAt: z.iso.datetime(), now: z.iso.datetime() }).parse(body);
        };
        const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
        const nextLine = async () => { const { value, done } = await lines.next(); if (done) throw new Error('The supervision channel closed before the attempt could proceed'); return String(value); };
        const request = supervisionRequestSchema.parse(JSON.parse(await nextLine()));
        // Before anything is provisioned: the plan must carry exactly the authority Graphyard
        // dispatched. A schema-valid plan naming another target, network, bundle or image is
        // a fabrication regardless of who put it on the pipe.
        const dispatched = await readAttemptAuthority(request.plan.grant.requestId);
        if (!isDeepStrictEqual(dispatched.grant, request.plan.grant)) throw new Error('The supervision request does not carry the attempt authority Graphyard dispatched; nothing was provisioned');
        const authority = new AbortController();
        const abort = () => authority.abort();
        process.on('SIGTERM', abort); process.on('SIGINT', abort);
        // Preflight has passed and no container has started yet. The runner acknowledges
        // now; without its confirmation nothing is executed.
        const ready = async () => {
          process.stdout.write(`${JSON.stringify({ preflight: 'ready' })}\n`);
          if (JSON.parse(await nextLine())?.proceed !== true) throw new Error('The attempt was not acknowledged; no container was started');
          // The caller's `proceed` only says it has finished trying; it is a sequencing
          // signal and never the authority to execute. What starts containers is this
          // process's own re-read: the attempt must still be the current one, carry the same
          // authority, have been acknowledged by the runner under its own credential, and
          // hold an unexpired lease. `collecting` fails here too, so an attempt cannot start
          // a container after the collector has observed settlement.
          const current = await readAttemptAuthority(request.plan.grant.requestId);
          if (!isDeepStrictEqual(current.grant, request.plan.grant)) throw new Error('Attempt authority changed between preflight and execution; no container was started');
          if (current.state !== 'running' || !current.acknowledged) throw new Error(`Graphyard does not hold this attempt as acknowledged and executing (state ${current.state}); no container was started`);
          if (Date.parse(current.expiresAt) <= Date.parse(current.now)) throw new Error('The attempt lease has expired; no container was started');
        };
        // Under the documented `sudo` rule the runner's own identity is knowable, and the
        // container must not run as it: the output boundary is private to the container user.
        const callerUid = /^[0-9]{1,10}$/.test(process.env.SUDO_UID ?? '') ? Number(process.env.SUDO_UID) : undefined;
        try { process.stdout.write(`${JSON.stringify(await superviseAttempt(request, { privateKey: key, ready, signal: authority.signal, callerUid }))}\n`); return; }
        finally { process.off('SIGTERM', abort); process.off('SIGINT', abort); }
      }
      if (id === 'collect' && args.length === 1) {
        // Collector path. Separate credential, separate host: it re-reads the authority,
        // measures the target itself and never trusts candidate-authored JSON.
        const input = collectorInputSchema.parse(JSON.parse(await readFile(args[0], 'utf8')));
        const attemptCommand = { requestId: input.grant.requestId, attemptId: input.grant.attemptId, epoch: input.grant.epoch };
        let collectionBeat = 0, renewCollection: NodeJS.Timeout | undefined;
        const collectionAuthority = authorityWatch();
        try {
        // A local mistake must not spend the attempt's one collection transition. Taking
        // collection authority moves the live request to `collecting` and revokes the
        // runner's heartbeats, and neither can be undone: a configuration whose record does
        // not even bind to the grant and output path it was written with is refused here,
        // while the attempt can still be collected again from a corrected configuration.
        // This check is on caller-supplied values and so decides nothing; the binding that
        // matters is the one below, against the authority the collector re-read itself.
        const collectedFrom = await realpath(resolve(input.outputPath));
        const local = collectionBinding({ grant: input.grant, execution: input.record, collectedFrom });
        if (local.reasons.length) throw new Error(`Collection refused before taking collection authority: ${local.reasons.join('; ')}`);
        // Bind authority, record and boundary before anything is read or published: an
        // immutable artifact name published for the wrong bytes cannot be taken back.
        // Taking collection authority also revokes the runner's, so nothing this collector
        // observes — settlement above all — can be invalidated by a container started next.
        const grant = attemptGrantSchema.parse(await api('validation/collection-authority', attemptCommand));
        const binding = collectionBinding({ grant, execution: input.record, collectedFrom });
        if (binding.reasons.length) throw new Error(`Collection refused before reading the execution boundary: ${binding.reasons.join('; ')}`);
        await api('validation/collection-heartbeat', attemptCommand, `${input.grant.attemptId}-collection-beat-${++collectionBeat}`);
        collectionAuthority.renewed();
        // Renewed under exactly the rule the executing runner follows: a confirmed refusal
        // ends this collection for good, while one lost packet does not abandon the only
        // path that publishes this attempt's result.
        renewCollection = setInterval(() => { void api('validation/collection-heartbeat', attemptCommand, `${input.grant.attemptId}-collection-beat-${++collectionBeat}`)
          .then(() => collectionAuthority.renewed()).catch((error: unknown) => collectionAuthority.failed(error)); }, 20_000);
        // Settlement is the collector's own observation of the execution host, never the
        // runner's claim about itself.
        const settlementObservations = await observeContainers(containerNames(grant.attemptId), { dockerHost: grant.executionHost });
        // Read every approved kind the boundary holds, whatever this collector publishes:
        // behaviour cannot be verified from the execution report alone, and a kind left
        // unread would look like output the approved reporter never wrote. Only the upload
        // below is narrowed to the configured subset.
        const collected = await collectArtifacts(collectedFrom, collectionInputs(input.requiredArtifacts), grant.reportFormat);
        // Verify the host attestation, and the digests of the bytes just read, *before* the
        // first upload. An artifact name is published once per attempt and cannot be taken
        // back: a live grant plus schema-valid forged boundary files would otherwise consume
        // the names this attempt's real evidence needs, and no later correct collection could
        // republish them. Unattested bytes are therefore never uploaded — but the attempt
        // still publishes its refusal below, because a blocked attempt is a visible state
        // rather than a collection that quietly disappears.
        const attested = verifyExecutionAttestation(grant, input.record, collected, input.executionAttestation);
        const publish = attested.reasons.length ? new Set<string>() : new Set(input.requiredArtifacts);
        const uploaded: { name: string; digest: string; url: string }[] = [];
        const failures: string[] = [];
        for (const artifact of collected.artifacts.filter(a => publish.has(a.name))) {
          if (collectionAuthority.lost) throw new Error('Collection authority could not be renewed; no artifact or result was published');
          try {
            const body = { requestId: grant.requestId, attemptId: grant.attemptId, epoch: grant.epoch,
              name: artifact.name, mediaType: artifact.published.mediaType, bytes: artifact.published.bytes.toString('base64'), capturePolicy: 'approved-test-data-only' };
            let stored: any, error: unknown;
            for (let retry = 0; retry < 3 && !stored; retry++) try { stored = await api('validation/artifacts', body, `${grant.attemptId}-artifact-${artifact.name}`); } catch (caught) { error = caught; }
            if (!stored) throw error;
            uploaded.push({ name: artifact.name, digest: stored.digest, url: stored.url });
          } catch { failures.push(`Private storage rejected required artifact ${artifact.name}`); }
        }
        const assembled = assembleResult({ grant, execution: input.record, collectedFrom, expected: input.expected, observations: input.observations,
          maxGapMs: input.maxGapMs, requiredArtifacts: input.requiredArtifacts, cancelled: input.cancelled, settlementObservations,
          collected: { artifacts: collected.artifacts, reasons: [...collected.reasons, ...failures] }, uploaded, executionAttestation: input.executionAttestation });
        if (!assembled.report) throw new Error(`Collection refused: ${assembled.refusals.join('; ')}`);
        if (collectionAuthority.lost) throw new Error('Collection authority could not be renewed; no result was published');
        return print({ refusals: assembled.refusals, report: assembled.report, result: await api('validation/result', assembled.report, `${grant.attemptId}-result`) });
        } finally { if (renewCollection) clearInterval(renewCollection); }
      }
      throw new Error('Use runner inspect|snapshot|bundle-digest|account-digest|adapters|verify-report|attempt|supervise|collect');
    },
  },
]);
