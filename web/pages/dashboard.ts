import type { RefObject } from 'react';
import type { Work } from '../../src/model';
import type { OpenGroup } from '../groups';
import type { IntegrationJob } from '../../src/coordination';
import type { predictQueue } from '../../src/merge-queue';
import type { Features } from '../features';
import type { StepTransition } from '../flow-replay';

/**
 * The dashboard state every page reads and the actions it may take. The App in
 * web/main.tsx owns the state; pages under web/pages/ render one view of it each.
 */
export interface Dashboard {
  token: string; work: Work[]; status: any; error: string; connected: boolean; lastUpdated: string | null;
  view: string; setView(view: string): void;
  /** The Work page's group filter: the tile last pressed, or null for every group. */
  filter: OpenGroup | null; setFilter(filter: OpenGroup | null): void;
  selected: string | null; setSelected(id: string | null): void;
  creating: boolean; setCreating(creating: boolean): void;
  busy: boolean; setBusy(busy: boolean): void;
  observedAt: number; jobs: IntegrationJob[];
  query: string; setQuery(query: string): void;
  operatorAgents: any[]; events: any[];
  /** Why the operator-automation read failed, when it did; null when it answered. */
  operatorAgentsError: string | null;
  /** Which optional features have anything configured; see web/features.ts. */
  features: Features;
  editingRequirements: boolean; setEditingRequirements(value: boolean | ((value: boolean) => boolean)): void;
  codexAvailable: boolean;
  /**
   * Each item's recorded moves between the seven steps (the steps drill-down, read about once a
   * minute), which start the "In step" clock; null or absent until they are read.
   */
  stepMoves?: StepTransition[] | null;
  queue: ReturnType<typeof predictQueue>;
  /** Bumped on sign-out so a stale response never lands in a newer session. */
  sessionEpoch: RefObject<number>;
  api(path: string, data?: unknown): Promise<any>;
  refresh(epoch: number): Promise<void>;
  action(id: string, command: string, data?: unknown): Promise<void>;
  setError(message: string): void;
  signOut(): void;
}
