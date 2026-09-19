import type { RefObject } from 'react';
import type { Stage, Work } from '../../src/model';
import type { IntegrationJob } from '../../src/coordination';
import type { predictQueue } from '../../src/merge-queue';

/**
 * The dashboard state every page reads and the actions it may take. The App in
 * web/main.tsx owns the state; pages under web/pages/ render one view of it each.
 */
export interface Dashboard {
  token: string; work: Work[]; status: any; error: string; connected: boolean; lastUpdated: string | null;
  view: string; setView(view: string): void;
  filter: Stage | null; setFilter(filter: Stage | null): void;
  selected: string | null; setSelected(id: string | null): void;
  creating: boolean; setCreating(creating: boolean): void;
  busy: boolean; setBusy(busy: boolean): void;
  observedAt: number; jobs: IntegrationJob[];
  query: string; setQuery(query: string): void;
  operatorAgents: any[]; events: any[];
  editingRequirements: boolean; setEditingRequirements(value: boolean | ((value: boolean) => boolean)): void;
  codexAvailable: boolean;
  queue: ReturnType<typeof predictQueue>;
  /** Bumped on sign-out so a stale response never lands in a newer session. */
  sessionEpoch: RefObject<number>;
  api(path: string, data?: unknown): Promise<any>;
  refresh(epoch: number): Promise<void>;
  action(id: string, command: string, data?: unknown): Promise<void>;
  showAutomation(): Promise<void>;
  setError(message: string): void;
  signOut(): void;
}
