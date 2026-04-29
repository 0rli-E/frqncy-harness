/**
 * Serve config schema — `config.serve.routes[]`.
 *
 * Lives at `~/.frqncy-harness/config.json` under the `serve` block. The CLI
 * `frqncy-harness serve` reads this and merges it with command-line flags
 * (flags win on conflict, additive on routes).
 */
import { z } from 'zod';

export const ServeRouteConfigSchema = z.object({
  /** Skill name — must exist at ~/.frqncy-harness/skills/<skill>/SKILL.md */
  skill: z.string().min(1),
  /** Price in USD cents. 0 = free (no payment middleware). */
  priceUsdCents: z.number().int().nonnegative(),
  /** Per-route model override. */
  model: z.string().optional(),
  /** Override path; defaults to `/skills/<skill>`. */
  path: z.string().regex(/^\/[A-Za-z0-9_\-/]+$/).optional(),
});
export type ServeRouteConfig = z.infer<typeof ServeRouteConfigSchema>;

export const ServeConfigSchema = z.object({
  routes: z.array(ServeRouteConfigSchema).default([]),
  /** Default port. Default 3030. */
  port: z.number().int().positive().max(65535).optional(),
  /** Default model used when routes don't pin one. */
  defaultModel: z.string().optional(),
  /** Override receiver address. Defaults to signer.smartAccount ?? signer.address. */
  payTo: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});
export type ServeConfig = z.infer<typeof ServeConfigSchema>;
