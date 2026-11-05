import { z } from 'zod';
/** What a producer submits as `exercise`. */
export const proofExerciseSchema = z.object({
  criterion: z.string().trim().min(1).max(80).optional(), behaviour: z.string().trim().min(1).max(300),
  result: z.enum(['pass', 'fail']), executed: z.number().int().min(0),
}).strict();
