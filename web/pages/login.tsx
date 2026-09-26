import { useEffect, useState } from 'react';
import type { Dashboard } from './dashboard';

/** How long the first status read may take before the page says the control plane cannot be reached. */
export const VERIFY_TIMEOUT_MS = 10_000;
export const REJECTED_NOTICE = 'That token was not accepted';
export const HELPER_TEXT = 'Tokens are scoped to your role and kept for this browser session.';
/** How the human operator signs in without a token (GY-738). */
export const SIGN_IN_LINK_TEXT = 'Operator? Open the one-time link graphyard login prints: it signs you in as a human, no token needed.';
export const LINK_REFUSED_NOTICE = 'That sign-in link has expired or was already used. Ask for a new one.';

/** The one-time code a sign-in link carries in its fragment (`/#sign-in=CODE`), which never reaches a server log. */
export const signInCode = (hash: string) => /^#sign-in=([A-Za-z0-9_-]{16,200})$/.exec(hash)?.[1] ?? null;
/**
 * Redeem a sign-in link's code for a human session token. The link is single use: the server
 * forgets it on the first attempt, whatever the outcome.
 */
export async function redeemSignIn(code: string, fetcher: typeof fetch): Promise<{ kind: 'signed-in'; token: string } | { kind: 'refused' } | { kind: 'unreachable' }> {
  try {
    const response = await fetcher('/api/sign-in', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (response.status === 401 || response.status === 400) return { kind: 'refused' };
    if (!response.ok) return { kind: 'unreachable' };
    const { token } = await response.json() as { token?: unknown };
    return typeof token === 'string' ? { kind: 'signed-in', token } : { kind: 'unreachable' };
  } catch { return { kind: 'unreachable' }; }
}

/** What the sign-in page shows: the token form, the first status read in flight, or that read gone unanswered. */
export type LoginState = { kind: 'form' } | { kind: 'verifying' } | { kind: 'unreachable'; host: string };
export type VerifyOutcome = { kind: 'accepted'; status: unknown } | { kind: 'rejected' } | { kind: 'unreachable' };
export interface VerifyClock { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }

/**
 * Reads /api/status with the token once, then runs `load` (the dashboard's first read) with the status. It always
 * settles: accepted with the status, rejected on 401 or 403 (or when `load` throws an error marked unauthorized), and unreachable on any other failure or when the
 * status reply and the load have not both finished within VERIFY_TIMEOUT_MS.
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
    {state.kind === 'form' && <form className="login-form" onSubmit={e => { e.preventDefault(); submit(); }}>
      {error && <p role="alert" className="notice danger">{error}</p>}
      <label>Access token<input type="password" required autoFocus value={draftToken} onChange={e => setDraftToken(e.target.value)} autoComplete="off" placeholder="Your Graphyard token"/></label>
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
    {state.kind === 'form' && <p className="login-help">{SIGN_IN_LINK_TEXT}</p>}
    <p className="login-help">{HELPER_TEXT}</p>
  </main>;
}

/** The token prompt, and the verifying state while the first status read is in flight. */
export default function LoginPage({ token, error, signOut, setError, sessionEpoch, setToken, draftToken, setDraftToken, host, onVerified }: Pick<Dashboard, 'token' | 'error' | 'signOut' | 'setError' | 'sessionEpoch'> & { setToken(token: string): void; draftToken: string; setDraftToken(value: string): void; host: string; onVerified(status: unknown, signal: AbortSignal): Promise<void> }) {
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // A sign-in link opens here: its code is taken out of the address bar at once, redeemed, and the
  // human session token it returns is verified exactly as a typed token is.
  useEffect(() => {
    const code = signInCode(location.hash);
    if (!code) return;
    history.replaceState(null, '', location.pathname + location.search);
    const epoch = ++sessionEpoch.current;
    void redeemSignIn(code, (input, init) => fetch(input, init)).then(outcome => {
      if (epoch !== sessionEpoch.current) return;
      if (outcome.kind === 'signed-in') { setError(''); sessionStorage.setItem('graphyard-token', outcome.token); setToken(outcome.token); }
      else setError(outcome.kind === 'refused' ? LINK_REFUSED_NOTICE : `Can't reach the control plane at ${host}`);
    });
  }, []);
  useEffect(() => {
    if (!token) return;
    setUnreachable(false);
    const epoch = sessionEpoch.current; let active = true;
    const check = verifyToken(token, (input, init) => fetch(input, init), { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }, onVerified);
    void check.result.then(outcome => {
      if (!active || epoch !== sessionEpoch.current) return;
      if (outcome.kind === 'accepted') return;
      if (outcome.kind === 'rejected') { signOut(); setError(REJECTED_NOTICE); }
      else setUnreachable(true);
    });
    return () => { active = false; check.cancel(); };
  }, [token, attempt]);
  const state: LoginState = !token ? { kind: 'form' } : unreachable ? { kind: 'unreachable', host } : { kind: 'verifying' };
  const submit = () => { const value = draftToken.trim(); if (!value) { setError('Enter an access token.'); return; } sessionEpoch.current++; setError(''); sessionStorage.setItem('graphyard-token', value); setToken(value); };
  return <LoginView state={state} error={error} draftToken={draftToken} setDraftToken={setDraftToken} submit={submit} retry={() => setAttempt(n => n + 1)} useAnotherToken={signOut}/>;
}
