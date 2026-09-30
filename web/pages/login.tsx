import { useEffect, useState } from 'react';
import type { Dashboard } from './dashboard';

/**
 * How long the server may take to answer the first status read before the page says the control
 * plane cannot be reached. /api/status alone ran 3 s at the median and 10-15 s at the tail on
 * 2026-09-30, so 10 s told reachable operators it was down.
 */
export const VERIFY_TIMEOUT_MS = 30_000;
export const REJECTED_NOTICE = 'That token was not accepted';
/** The username a password manager stores the token under; the site address already tells installations apart. */
export const LOGIN_USERNAME = 'graphyard';
const visuallyHidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0, padding: 0, margin: -1 } as const;
/**
 * Offers the accepted token to the browser's own password store (Credential Management API, where the browser
 * has it), so it is saved as a password beside what a password-manager extension picks up from the form.
 */
export function offerToSavePassword(token: string, scope: { PasswordCredential?: new (data: { id: string; password: string; name?: string }) => unknown; navigator?: { credentials?: { store?(credential: unknown): Promise<unknown> } } } = globalThis as never) {
  const Credential = scope.PasswordCredential, store = scope.navigator?.credentials?.store;
  if (!Credential || !store) return false;
  void store.call(scope.navigator!.credentials, new Credential({ id: LOGIN_USERNAME, password: token, name: 'Graphyard control plane' })).catch(() => {});
  return true;
}
export const HELPER_TEXT = 'Tokens are scoped to your role and kept for this browser session.';

/** What the sign-in page shows: the token form, the first status read in flight, or that read gone unanswered. */
export type LoginState = { kind: 'form' } | { kind: 'verifying' } | { kind: 'unreachable'; host: string };
export type VerifyOutcome = { kind: 'accepted'; status: unknown } | { kind: 'rejected' } | { kind: 'unreachable' };
export interface VerifyClock { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }

/**
 * Reads /api/status with the token once, then runs `load` (the dashboard's first read) with the status. It
 * settles accepted with the status, rejected on 401 or 403 (or when `load` throws an error marked unauthorized),
 * and unreachable on any other failure or when the status reply has not arrived within VERIFY_TIMEOUT_MS. The
 * deadline covers only reaching the server: once /api/status has answered, the server is reachable, so a slow
 * dashboard load keeps the page verifying (with its "Use another token" escape) instead of calling it unreachable.
 */
export function verifyToken(token: string, fetcher: typeof fetch, clock: VerifyClock, load: (status: unknown, signal: AbortSignal) => Promise<void> = async () => {}): { result: Promise<VerifyOutcome>; cancel(): void } {
  const controller = new AbortController();
  let timer: unknown;
  const timedOut = new Promise<VerifyOutcome>(resolve => { timer = clock.setTimeout(() => { controller.abort(); resolve({ kind: 'unreachable' }); }, VERIFY_TIMEOUT_MS); });
  const replied = (async (): Promise<VerifyOutcome> => {
    try {
      const response = await fetcher('/api/status', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (response.status === 401 || response.status === 403) return { kind: 'rejected' };
      if (!response.ok) return { kind: 'unreachable' };
      const status = await response.json();
      // The server answered: the reachability deadline is met, and the dashboard's first read runs without it.
      clock.clearTimeout(timer);
      await load(status, controller.signal);
      return { kind: 'accepted', status };
    } catch (error) { return (error as { unauthorized?: boolean })?.unauthorized ? { kind: 'rejected' } : { kind: 'unreachable' }; }
  })();
  return { result: Promise.race([replied, timedOut]).finally(() => clock.clearTimeout(timer)), cancel() { controller.abort(); clock.clearTimeout(timer); } };
}

export interface LoginViewProps {
  state: LoginState; error: string; draftToken: string;
  setDraftToken(value: string): void; submit(): void; retry(): void; useAnotherToken(): void;
}

/**
 * The sign-in page itself, without state: one column, one left edge. The brand, heading, tagline, the status
 * or form, and the helper text are all children of .login, and the helper is its own paragraph after the action.
 */
export function LoginView({ state, error, draftToken, setDraftToken, submit, retry, useAnotherToken }: LoginViewProps) {
  const escape = <button type="button" className="text-button login-escape" onClick={useAnotherToken}>Use another token</button>;
  return <main className="login">
    <div className="brand"><img className="mark" src="/graphyard-symbol.svg" alt="" width="32" height="32"/> graphyard</div>
    <h1>Keep the work<br/>moving forward.</h1>
    <p className="login-tagline">One place for ownership, evidence, and delivery.</p>
    {state.kind === 'form' && <form className="login-form" method="post" onSubmit={e => { e.preventDefault(); submit(); }}>
      {error && <p role="alert" className="notice danger">{error}</p>}
      {/* A password manager saves a login as a username/password pair: the fixed, visually hidden username lets
          1Password and the browser offer to save the token and fill it next time. */}
      <input type="text" name="username" autoComplete="username" value={LOGIN_USERNAME} readOnly tabIndex={-1} aria-hidden="true" style={visuallyHidden}/>
      <label>Access token<input type="password" name="password" required autoFocus value={draftToken} onChange={e => setDraftToken(e.target.value)} autoComplete="current-password" placeholder="Your Graphyard token"/></label>
      <button type="submit">Open control plane ↗</button>
    </form>}
    {state.kind === 'verifying' && <div className="login-status">
      <p role="status" aria-busy="true" aria-live="polite" className="login-progress"><span className="spinner" aria-hidden="true"/>Verifying connection…</p>
      {escape}
    </div>}
    {state.kind === 'unreachable' && <div className="login-status">
      <p role="alert" className="notice danger">Can't reach the control plane at {state.host}</p>
      <div className="login-actions"><button type="button" onClick={retry}>Retry</button>{escape}</div>
    </div>}
    <p className="login-help">{HELPER_TEXT}</p>
  </main>;
}

/** The token prompt, and the verifying state while the first status read is in flight. */
export default function LoginPage({ token, error, signOut, setError, sessionEpoch, setToken, draftToken, setDraftToken, host, onVerified }: Pick<Dashboard, 'token' | 'error' | 'signOut' | 'setError' | 'sessionEpoch'> & { setToken(token: string): void; draftToken: string; setDraftToken(value: string): void; host: string; onVerified(status: unknown, signal: AbortSignal): Promise<void> }) {
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!token) return;
    setUnreachable(false);
    const epoch = sessionEpoch.current; let active = true;
    const check = verifyToken(token, (input, init) => fetch(input, init), { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }, onVerified);
    void check.result.then(outcome => {
      if (!active || epoch !== sessionEpoch.current) return;
      if (outcome.kind === 'accepted') { offerToSavePassword(token); return; }
      if (outcome.kind === 'rejected') { signOut(); setError(REJECTED_NOTICE); }
      else setUnreachable(true);
    });
    return () => { active = false; check.cancel(); };
  }, [token, attempt]);
  const state: LoginState = !token ? { kind: 'form' } : unreachable ? { kind: 'unreachable', host } : { kind: 'verifying' };
  const submit = () => { const value = draftToken.trim(); if (!value) { setError('Enter an access token.'); return; } sessionEpoch.current++; setError(''); sessionStorage.setItem('graphyard-token', value); setToken(value); };
  return <LoginView state={state} error={error} draftToken={draftToken} setDraftToken={setDraftToken} submit={submit} retry={() => setAttempt(n => n + 1)} useAnotherToken={signOut}/>;
}
