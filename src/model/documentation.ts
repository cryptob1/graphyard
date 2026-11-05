import type { z } from 'zod';
import type { repositoryConfigSchema } from '../model-boundary/documentation.js';
/** The committed repository configuration file. */
export const repositoryConfigFile = 'graphyard.json';
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

/** Words as `wc -w` counts them: maximal runs of non-whitespace, markup and code included. */
export const docsWords = (text: string) => text.split(/\s+/).filter(Boolean).length;
