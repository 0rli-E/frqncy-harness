/**
 * Bridges — interop layers between the harness and other agent frameworks.
 *
 * Currently:
 *   - daydreams: tool/action conversions + Extension bundle for `@daydreamsai/core`
 *   - daydreams-router: x402-paid OpenAI-compatible inference at `ai.xgate.run`
 */

export {
  harnessToolToDaydreamsAction,
  daydreamsActionToHarnessTool,
  createDaydreamsExtension,
  daydreamsExtensionToHarnessTools,
  type DaydreamsActionLike,
  type DaydreamsExtensionLike,
  type HarnessToolToActionOptions,
  type ActionToHarnessToolOptions,
  type CreateDaydreamsExtensionOptions,
  type ExtensionToHarnessToolsOptions,
} from './daydreams.js';

export {
  createDaydreamsRouterFetch,
  daydreamsRouterChat,
  daydreamsRouterModels,
  DEFAULT_DAYDREAMS_ROUTER_URL,
  DAYDREAMS_PAYMENT_HEADER,
  DAYDREAMS_REQUIRED_HEADER,
  DAYDREAMS_SESSION_HEADER,
  type CreateDaydreamsRouterFetchOptions,
  type DaydreamsRouterChatRequest,
  type DaydreamsRouterChatResult,
} from './daydreams-router.js';
