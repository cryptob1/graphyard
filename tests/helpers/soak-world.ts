// GY-2010: soak-world's SimulatedGitHub is gone with the API client.
// The clock helper remains for tests that stub Date without wall-clock time bombs.
let installed: { now: () => number; RealDate: DateConstructor } | null = null;
const RealDate = Date;

export const clock = {
  install(now: number | (() => number)) {
    if (installed) throw new Error('clock already installed');
    const read = typeof now === 'function' ? now : () => now;
    installed = { now: read, RealDate };
    // eslint-disable-next-line no-global-assign
    (globalThis as any).Date = class extends RealDate {
      constructor(...args: any[]) {
        if (args.length === 0) super(read());
        else super(...args as [any]);
      }
      static now() { return read(); }
    } as DateConstructor;
  },
  uninstall() {
    if (!installed) return;
    (globalThis as any).Date = installed.RealDate;
    installed = null;
  },
};
