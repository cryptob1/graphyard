import { useEffect, useRef, useState } from 'react';

const columns = 120, rows = 36;
type Session = { account: string | null; runtime: string | null; pane: string | null; state: string };

// xterm.js loads from the CDN at a pinned exact version, checked by its hash, only on a page that
// shows a terminal: never an npm dependency of the dashboard bundle.
const xterm = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0';
/** The part of xterm.js's Terminal this page uses. */
type TerminalClass = new (options: Record<string, unknown>) => {
  open(host: HTMLElement): void; focus(): void; write(data: Uint8Array | string): void; reset(): void; resize(cols: number, rows: number): void;
  cols: number; rows: number; getSelection(): string; paste(data: string): void; scrollLines(lines: number): void;
  buffer: { active: { viewportY: number; baseY: number } };
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void; dispose(): void;
  onData(listener: (data: string) => void): { dispose(): void };
};
/**
 * The master's program may switch its pane to the alternate screen (DEC 47/1047/1049), where a
 * terminal has no scrollback: the history the page was sent would be locked away and the wheel
 * would type arrows into the pane instead of scrolling (GY-3308). The switches are dropped from the
 * stream, so the pane's redraws land in the normal buffer and one stream stays one scrollable
 * history. Bytes are filtered as bytes: the stream is UTF-8, never decoded here.
 */
const withoutAlternateScreen = (data: string) => data.replace(/\x1b\[\?(?:47|1047|1049)[hl]/g, '');
const bytesWithoutAlternateScreen = (bytes: Uint8Array) => {
  const kept = new Uint8Array(bytes.length); let length = 0;
  for (let i = 0; i < bytes.length;) {
    let skip = -1; // ESC [ ? <digits> h|l — a private mode switch; the alternate screen's codes go.
    if (bytes[i] === 0x1b && bytes[i + 1] === 0x5b && bytes[i + 2] === 0x3f) {
      let digits = i + 3;
      while (digits < bytes.length && bytes[digits]! >= 0x30 && bytes[digits]! <= 0x39) digits++;
      if ((bytes[digits] === 0x68 || bytes[digits] === 0x6c) && ['47', '1047', '1049'].includes(String.fromCharCode(...bytes.subarray(i + 3, digits)))) skip = digits + 1;
    }
    if (skip < 0) { kept[length++] = bytes[i]!; i++; } else i = skip;
  }
  return kept.subarray(0, length);
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
      /** Scrolls the view by LINES. A scroll that lands on the bottom row must resume following
       *  live output: xterm clears its held-view state only when the buffer itself scrolls onto the
       *  last line, so a scroll arriving there steps one line off and back (GY-3308). */
      const scrollBy = (lines: number) => {
        if (lines > 0 && terminal.buffer.active.viewportY + lines >= terminal.buffer.active.baseY) { terminal.scrollLines(-1); lines++; }
        terminal.scrollLines(lines);
      };
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
            if (message.type === 'scrollback') { terminal.reset(); terminal.write(withoutAlternateScreen(message.data.replace(/\r?\n/g, '\r\n'))); return; }
            if (message.note) { setReason(message.note); return; }
            if (message.session) setSession(message.session);
            if (message.mode) {
              writable = message.mode === 'control' && !!message.session?.pane; setState(message.mode); setReason(''); delay = 250;
              fit();
              if (writable && message.type === 'hello') terminal.focus();
            }
            return;
          }
          terminal.write(bytesWithoutAlternateScreen(new Uint8Array(event.data)));
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
      // Text goes in as one bracketed paste, never a raw ^V; a file or image is uploaded and its saved path pasted.
      const deliver = async (files: File[], pasted: string) => {
        if (!writable) { setReason('Paste refused: read-only, only the operator and maintainers can type into the master'); return; }
        for (const file of files) {
          if (file.size > 20 * 1024 * 1024) { setReason('Not pasted: files are limited to 20 MB'); continue; }
          const data = await new Promise<string>(done => { const reader = new FileReader(); reader.onload = () => done(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file); });
          send({ type: 'upload', name: file.name || 'file', data });
        }
        if (pasted) input(`\x1b[200~${pasted.replace(/\x1b/g, '').replace(/\r?\n/g, '\r')}\x1b[201~`);
        terminal.focus();
      };
      const paste = (event: ClipboardEvent) => { event.preventDefault(); event.stopPropagation(); void deliver([...event.clipboardData?.files ?? []], event.clipboardData?.getData('text/plain') ?? ''); };
      const drop = (event: DragEvent) => { event.preventDefault(); void deliver([...event.dataTransfer?.files ?? []], ''); };
      const over = (event: DragEvent) => event.preventDefault();
      const readClipboard = async () => {
        try {
          const files: File[] = []; let pasted = '';
          for (const item of await navigator.clipboard.read()) for (const type of item.types) {
            const blob = await item.getType(type);
            if (type === 'text/plain') pasted = await blob.text(); else if (type.startsWith('image/')) files.push(new File([blob], `image.${type.slice(6)}`, { type }));
          }
          await deliver(files, files.length ? '' : pasted);
        } catch { setReason('Clipboard access unavailable. Use Ctrl/Cmd+V.'); }
      };
      terminal.attachCustomKeyEventHandler(event => {
        // Shift+PageUp/PageDown walk the history: xterm binds no scroll keys of its own (GY-3308).
        if (event.type === 'keydown' && event.shiftKey && (event.key === 'PageUp' || event.key === 'PageDown')) {
          event.preventDefault(); scrollBy(event.key === 'PageUp' ? -(terminal.rows - 1) : terminal.rows - 1); return false;
        }
        // Ctrl/Cmd+V (with or without Shift) is left to the browser, whose paste event the page handles above.
        if ((event.ctrlKey || event.metaKey) && event.key.toUpperCase() === 'V') return false;
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toUpperCase() === 'C' && navigator.clipboard) {
          if (event.type === 'keydown') void navigator.clipboard.writeText(terminal.getSelection()).catch(() => setReason('Use your browser’s Copy command.'));
          event.preventDefault(); return false;
        }
        return true;
      });
      // A finger drag scrolls the history, as every phone reader expects: the screen has no wheel
      // and no PageUp (GY-3308). The pane itself is untouched; this moves only the view.
      let fingerY = 0;
      const touchStart = (event: TouchEvent) => { fingerY = event.touches[0]?.clientY ?? fingerY; };
      const touchMove = (event: TouchEvent) => {
        const y = event.touches[0]?.clientY;
        if (y === undefined) return;
        const cell = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect().height || 16;
        const lines = Math.round((fingerY - y) / cell);
        if (!lines) return;
        fingerY = y; scrollBy(lines); event.preventDefault();
      };
      const context = (event: MouseEvent) => { if (event.shiftKey || !navigator.clipboard) return; event.preventDefault(); void readClipboard(); };
      const element = host.current!;
      element.addEventListener('paste', paste, true); element.addEventListener('drop', drop); element.addEventListener('dragover', over); element.addEventListener('contextmenu', context);
      element.addEventListener('touchstart', touchStart, { passive: true }); element.addEventListener('touchmove', touchMove, { passive: false });
      const typing = terminal.onData(input);
      const observer = new ResizeObserver(fit); observer.observe(host.current!);
      window.addEventListener('resize', fit);
      fit(); connect();
      stop = () => {
        clearTimeout(reconnect); observer.disconnect(); window.removeEventListener('resize', fit);
        element.removeEventListener('paste', paste, true); element.removeEventListener('drop', drop); element.removeEventListener('dragover', over); element.removeEventListener('contextmenu', context);
        element.removeEventListener('touchstart', touchStart); element.removeEventListener('touchmove', touchMove);
        typing.dispose(); socket.close(); terminal.dispose(); sendKey.current = () => {};
      };
    }, () => { if (live) { setReason('xterm.js did not load. Reload to try again.'); setState('refused'); } });
    return () => { live = false; stop(); };
  }, [token]);
  return <section ref={section} className={`live-terminal${session?.state === 'working' ? ' working' : ''}`} aria-label={label} data-terminal={state}>
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
