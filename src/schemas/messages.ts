import { z } from 'zod'

// Run begin data schema (reporter -> server): the identities of the tests the
// run about to start will execute, so the server can clear their previous
// results before the run's results stream in.
export const RunBeginDataSchema = z.object({
  testIds: z.array(z.string()),
})

export type RunBeginData = z.infer<typeof RunBeginDataSchema>
