import { useEffect, useRef, useState } from 'react';

const columns = 120, rows = 36;
type Session = { account: string | null; runtime: string | null; pane: string | null; state: string };

// xterm.js loads from the CDN at a pinned exact version, checked by its hash, only on a page that
// shows a terminal: never an npm dependency of the dashboard bundle.
const xterm = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0';
/** The part of xterm.js's Terminal this page uses. */
type TerminalClass = new (options: Record<string, unknown>) => {
  open(host: HTMLElement): void; focus(): void; write(data: Uint8Array | string): void; reset(): void; resize(cols: number, rows: number): void;
  cols: number; rows: number; getSelection(): string; paste(data: string): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void; dispose(): void;
  onData(listener: (data: string) => void): { dispose(): void };
};
let loading: Promise<TerminalClass> | undefined;
const loadTerminal = () => loading ??= new Promise((done, fail) => {
  const style = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${xterm}/css/xterm.css`,
    integrity: 'sha384-n2n7twoohnW+d3myBKaUgl7DSiwidw6MkQy9oesGzkPpMjejKRR3XlnD+5yCdtBD', crossOrigin: 'anonymous' });
  const script = Object.assign(document.createElement('script'), { src: `${xterm}/lib/xterm.js`,
    integrity: 'sha384-f/1U6Z9wM4D71a5eRXEZnyOTMOvjqxr2XLwh+Go1OvIl3L3tOcvUrzudnhbECwl4', crossOrigin: 'anonymous',
    onload: () => done((globalThis as unknown as { Terminal: TerminalClass }).Terminal),
    onerror: () => { loading = undefined; fail(new Error('xterm.js did not load')); } });
  document.head.append(style, script);
});

/**
 * The master pane's live terminal (GY-3211), over the control plane's /api/terminal WebSocket; workers
 * run headless and show their run log on the item page instead (GY-3259). The server decides who may type —
 * the operator or an invited maintainer, on the master's pane — and says so in its first message; everyone else
 * watches. Unmounting closes the socket, which detaches without stopping the pane.
 */
export default function LiveTerminal({ token, label }: { token: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const sendKey = useRef<(key: string) => void>(() => {});
  const [state, setState] = useState('connecting');
  const [session, setSession] = useState<Session | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    setSession(null); setReason(''); setState('connecting');
    if (!token) { setReason('Sign in to open the terminal.'); setState('refused'); return; }
    let live = true, stop = () => {};
    loadTerminal().then(Terminal => {
      if (!live) return;
      const terminal = new Terminal({ cols: columns, rows, scrollback: 5000, convertEol: false, cursorBlink: true, fontSize: 13 });
      terminal.open(host.current!);
      let socket: WebSocket, reconnect: ReturnType<typeof setTimeout>, delay = 250;
      let writable = false;
      const send = (value: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
      const input = (data: string) => { if (writable) send({ type: 'input', data }); };
      sendKey.current = key => { input(key); terminal.focus(); };
      const fit = () => {
        if (!host.current || !section.current) return;
        section.current.style.height = `calc(100dvh - ${section.current.getBoundingClientRect().top + 12}px)`;
        const screen = host.current.querySelector('.xterm-screen')?.getBoundingClientRect();
        if (!screen?.width || !screen.height) return;
        const cols = Math.max(10, Math.min(500, Math.floor((host.current.clientWidth - 16) / (screen.width / terminal.cols))));
        const rows = Math.max(10, Math.min(500, Math.floor(host.current.clientHeight / (screen.height / terminal.rows))));
        if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
        send({ type: 'resize', cols, rows });
      };
      const connect = () => {
        if (!live) return;
        writable = false;
        let opened = false, refused = false;
        const query = new URLSearchParams({ cols: String(terminal.cols), rows: String(terminal.rows) });
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal?${query}`, ['graphyard', token]);
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => { opened = true; };
        socket.onmessage = event => {
          if (!live) return;
          if (typeof event.data === 'string') {
            const message = JSON.parse(event.data);
            if (message.refused) { refused = true; writable = false; setReason(message.refused); setState('refused'); return; }
            if (message.type === 'scrollback') { terminal.reset(); terminal.write(message.data.replace(/\r?\n/g, '\r\n')); return; }
            if (message.session) setSession(message.session);
            if (message.mode) {
              writable = message.mode === 'control' && !!message.session?.pane; setState(message.mode); setReason(''); delay = 250;
              fit();
              if (writable && message.type === 'hello') terminal.focus();
            }
            return;
          }
          terminal.write(new Uint8Array(event.data));
        };
        socket.onclose = async () => {
          writable = false;
          if (!live || refused) return;
          // Browsers hide HTTP upgrade refusal details. Distinguish an unavailable
          // terminal from an offline server before deciding whether to retry.
          if (!opened) {
            const response = await fetch('/api/status', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => null);
            if (!live) return;
            if (response && response.status < 500) {
              setReason('Not available: sign in, and check the session still has a pane.'); setState('refused'); return;
            }
          }
          setState('reconnecting');
          reconnect = setTimeout(connect, delay); delay = Math.min(2000, delay * 2);
        };
      };
      const paste = async () => {
        try { terminal.paste(await navigator.clipboard.readText()); }
        catch { setReason('Clipboard access unavailable. Use Ctrl/Cmd+V, or Shift+right-click for the browser menu.'); }
      };
      terminal.attachCustomKeyEventHandler(event => {
        if (!navigator.clipboard) return true;
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && ['C', 'V'].includes(event.key.toUpperCase())) {
          if (event.type === 'keydown') {
            if (event.key.toUpperCase() === 'C') void navigator.clipboard.writeText(terminal.getSelection()).catch(() => setReason('Use your browser’s Copy command.'));
            else void paste();
          }
          event.preventDefault(); return false;
        }
        return true;
      });
      const context = (event: MouseEvent) => { if (event.shiftKey || !navigator.clipboard) return; event.preventDefault(); void paste(); };
      host.current!.addEventListener('contextmenu', context);
      const typing = terminal.onData(input);
      const observer = new ResizeObserver(fit); observer.observe(host.current!);
      window.addEventListener('resize', fit);
      fit(); connect();
      stop = () => {
        clearTimeout(reconnect); observer.disconnect(); window.removeEventListener('resize', fit);
        host.current?.removeEventListener('contextmenu', context);
        typing.dispose(); socket.close(); terminal.dispose(); sendKey.current = () => {};
      };
    }, () => { if (live) { setReason('xterm.js did not load. Reload to try again.'); setState('refused'); } });
    return () => { live = false; stop(); };
  }, [token]);
  return <section ref={section} className="live-terminal" aria-label={label} data-terminal={state}>
    <div className="terminal-info" role="status">
      {session && <span className="terminal-session">{session.account ?? 'Account unknown'} · {session.runtime ?? 'Runtime unknown'} · {session.state} · {session.pane ?? 'No pane'}</span>}
      <span>{state === 'connecting' ? 'Connecting…' : state === 'reconnecting' ? 'Reconnecting…' : state === 'control' ? 'You can type here' : state === 'observe' ? 'read-only: only the operator and maintainers can type into the master' : `refused: ${reason}`}</span>
      {session?.state === 'absent' && <span>The loop relaunches the master on its own.</span>}
      {reason && state !== 'refused' && <span>{reason}</span>}
    </div>
    <div ref={host} className="terminal-host"/>
    <div className="terminal-keys" role="group" aria-label="Terminal keys">
      {([['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl-C', '\x03'], ['←', '\x1b[D'], ['↓', '\x1b[B'], ['↑', '\x1b[A'], ['→', '\x1b[C'], ['Enter', '\r']] as const).map(([name, key]) =>
        <button type="button" key={name} disabled={state !== 'control' || !session?.pane} onPointerDown={event => event.preventDefault()} onClick={() => sendKey.current(key)}>{name}</button>)}
    </div>
  </section>;
}
