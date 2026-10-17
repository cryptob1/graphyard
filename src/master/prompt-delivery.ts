// Concern: prompt delivery — the submissions a runtime visibly accepts, and the pane's screen a stalled one is judged by.
import { setTimeout as sleep } from 'node:timers/promises';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { detectConsentPrompt, detectNoticeDialog } from '../consent-prompt.js';
import { herdrCall, herdrJson, herdrRun } from './herdr.js';

/**
 * Prompt delivery the runtime visibly accepted. Herdr submits the prompt and reports whether the
 * agent left its idle state for it; a runtime that reported ready before its input was (OpenCode
 * does, while its UI loads) drops the text and stays idle, which Herdr answers as a stalled prompt.
 * A stalled prompt is delivered again after a pause; one still refused after every attempt fails
 * the launch, whose caller closes the session and launches afresh. Anything else Herdr refuses
 * fails at once. Since GY-93 this is the path for a runtime without a request contract, for the
 * loop's one re-prompt of a session that has not taken up its request, and for the reviewer's
 * retry to post a verdict it already judged.
 *
 * GY-1863: a stall is not a refusal. Herdr answers `agent_prompt_stalled` when it *accepted* the
 * submission but saw no working or blocked state within its own 5 s window (herdr agent prompt
 * --help), so the session may only be slow to show its start — or sitting on a dialog the
 * submission cannot pass, as the production master session was for two hours of failed wakes.
 * Re-submitting blind told a slow session the same thing twice more and failed a dialog-bound one
 * with a bare stall triple, and every caller recorded the refusal as a session-liveness failure of
 * a session that was there all along. Now the pane is read before anything is typed — the
 * submission's Enter would choose a dialog's highlighted option, exactly as the production wake
 * would have answered the autocompact prompt — a notice the pane's dialog catalogue safely
 * dismisses is dismissed and the text delivered again, and otherwise the submission Herdr accepted
 * is waited out to the acceptance window before it is judged dropped (GY-93) and delivered again.
 * A dismissal never spends one of the attempts: the delivery it enabled is granted on top, so a
 * notice put away on the last attempt is followed by the delivery it cleared the pane for. What
 * the pane last showed travels on the error a final refusal carries, so the record names the
 * dialog instead of a stall triple. A consent dialog the pane ends on (credential, payment, trust
 * and the rest the catalogue names) is never typed at: the submission's text could fill its input
 * and its Enter choose the highlighted option, so delivery ends there, naming the dialog.
 */
export const promptAttempts = 3, promptAcceptMs = 20_000, promptRetryPauseMs = 3_000;
/** How long a dismissed notice is given to clear before the text is delivered again. */
export const noticeSettleMs = 2_000;
export class PromptNotAcceptedError extends Error { readonly promptDropped = true; }
/** The delivery that stops at a consent dialog rather than submit into it. */
function consentRefusal(target: string, screen: string | null, stalls: string[]) {
  const consent = detectConsentPrompt(screen);
  // A settings-suggestion dialog (GY-1872) is the notice the delivery puts away, not a refusal.
  return consent && consent.kind !== 'settings' ? new PromptNotAcceptedError(`${target} shows a ${consent.kind} consent dialog, so its prompt is not submitted into it${stalls.length ? ` (${stalls.join(', ')})` : ''}; the session is closed and relaunched rather than left idle; the pane showed: "${consent.text}"`) : null;
}
export function herdrErrorCode(error: unknown) {
  const text = [(error as any)?.herdrCode, (error as any)?.stdout, (error as any)?.stderr, (error as any)?.message].filter(value => value !== undefined && value !== null).map(String).join('\n');
  return (error as any)?.herdrCode ?? /"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? null;
}
/** Everything a Herdr failure said, whichever stream it said it on. */
export function herdrErrorText(error: unknown) {
  return [(error as any)?.stdout, (error as any)?.stderr, error instanceof Error ? error.message : error].filter(value => value !== undefined && value !== null && value !== '').map(String).join('\n');
}
/** A runtime refusing the name it was given, rather than failing to start the session it names. */
export function nameRefusedByRuntime(error: unknown) {
  return /\b(?:agent|session) name\b|\binvalid (?:agent |session )?name\b/i.test(herdrErrorText(error));
}
export interface PromptDelivery { attempts?: number; acceptMs?: number; pauseMs?: number }
export async function deliverPrompt(target: string, text: string, run?: ChildRun, options: PromptDelivery & { confirm?: 'inline' | 'follow' } = {}) {
  const attempts = options.attempts ?? promptAttempts, acceptMs = options.acceptMs ?? promptAcceptMs, pauseMs = options.pauseMs ?? promptRetryPauseMs;
  const accepted = ['--until', 'working', '--until', 'blocked', '--timeout', String(acceptMs)];
  const stalls: string[] = [], dismissed: string[] = [];
  let shown: string | null = null;
  // A dismissal grants the delivery it enabled on top of the attempts, never instead of one; the
  // grant is capped at the attempt count, so a pane that re-draws a notice every round is bounded.
  let granted = 0;
  for (let attempt = 1; attempt <= attempts + granted; attempt++) {
    try {
      // The first submission is read off the pane before it is typed: a notice dialog showing now
      // would take the submission's Enter as its own menu choice, before any stall is ever judged.
      if (attempt === 1) {
        shown = await readSessionScreen(target, run);
        const refused = consentRefusal(target, shown, stalls);
        if (refused) throw refused;
        const showing = detectNoticeDialog(shown);
        if (showing) {
          await herdrRun(['agent', 'send-keys', target, 'esc'], run);
          dismissed.push(showing.kind);
          await sleep(noticeSettleMs);
        }
      }
      // Herdr takes options only after the prompt text; 'follow' submits it and then waits for the
      // agent to leave idle, which is the same confirmation for a caller whose text must come last.
      if (options.confirm === 'follow') { await herdrJson(['agent', 'prompt', target, text], run); await herdrJson(['agent', 'wait', target, ...accepted], run); }
      else await herdrJson(['agent', 'prompt', target, text, '--wait', ...accepted], run);
      return { attempts: attempt, accepted: true as const, ...(dismissed.length ? { dismissed } : {}) };
    } catch (error) {
      if (error instanceof PromptNotAcceptedError) throw error;
      const code = herdrErrorCode(error);
      if (code !== 'agent_prompt_stalled' && code !== 'timeout') throw error;
      stalls.push(code);
      // What the pane is showing decides what the stall means: a notice dialog the catalogue
      // dismisses is put away and the text delivered again; anything else is a submission Herdr
      // already accepted, so the start it owes is waited out before the text is judged dropped.
      shown = await readSessionScreen(target, run);
      const refused = consentRefusal(target, shown, stalls);
      if (refused) throw refused;
      const notice = detectNoticeDialog(shown);
      if (notice) {
        await herdrRun(['agent', 'send-keys', target, 'esc'], run);
        dismissed.push(notice.kind);
        if (granted < attempts) granted += 1;
        await sleep(noticeSettleMs);
        continue;
      }
      // Every accepted submission is waited out, the last one too: only the retry pause is spared.
      if (code === 'agent_prompt_stalled') {
        try { await herdrJson(['agent', 'wait', target, ...accepted], run); return { attempts: attempt, accepted: true as const, ...(dismissed.length ? { dismissed } : {}) }; }
        catch (waited) {
          const waitCode = herdrErrorCode(waited);
          if (waitCode !== 'timeout' && waitCode !== 'agent_prompt_stalled') throw waited;
          stalls.push(`wait:${waitCode}`);
        }
      }
      // The pause is awaited on the event loop: nothing else in the process waits with it.
      if (attempt < attempts + granted) await sleep(pauseMs);
    }
  }
  const pane = shown ? sessionWords(shown, 200) : '';
  throw new PromptNotAcceptedError(`${target} did not visibly accept its prompt after ${attempts} deliveries (${stalls.join(', ')}); the session is closed and relaunched rather than left idle${pane ? `; the pane last showed: "${pane}"` : ''}`);
}

/** The session's terminal, as text; null when Herdr cannot read it. */
export async function readSessionScreen(target: string, run: ChildRun = defaultChildRun, lines = 80): Promise<string | null> {
  try { return String(await herdrCall(run, ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(lines)])); } catch { return null; }
}
const screenDecoration = /^[\s─━═╌┄┈│┃╭╮╰╯┌┐└┘├┤=_*·•-]*$|^[❯⏵✻✶✳✢·]|bypass permissions on|shift\+tab to cycle|for shortcuts|esc to interrupt|\? for help/;
/** The session's own last words: the tail of its screen without the runtime's frame, bounded for a ledger record. */
export function sessionWords(text: string | null, limit = 400) {
  const lines = (text ?? '').split('\n').map(line => line.trim()).filter(line => line && !screenDecoration.test(line));
  const words = lines.slice(-8).join(' ').replace(/\s+/g, ' ').trim();
  return words.length > limit ? `…${words.slice(-limit)}` : words;
}
