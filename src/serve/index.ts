/**
 * `src/serve/` — agent-as-a-service.
 *
 * Combines:
 *   - .well-known agent card (from src/identity/serve.ts)
 *   - x402-paid skill routes (src/serve/skill-route.ts + src/payments/server.ts)
 *   - inbound payment trace records (src/payments/trace.ts)
 *
 * Public surface: `serveAgent(opts)`. The CLI command (`src/commands/serve.ts`)
 * wraps it for the dev loop.
 */
export {
  serveAgent,
  type ServeAgentOptions,
  type ServeRouteSpec,
  type ServingHandle as ServeAgentHandle,
} from './server.js';

export {
  createSkillRouteHandler,
  type SkillRouteOptions,
  type PaidSkillResponse,
} from './skill-route.js';

export {
  ServeConfigSchema,
  ServeRouteConfigSchema,
  type ServeConfig,
  type ServeRouteConfig,
} from './config.js';
