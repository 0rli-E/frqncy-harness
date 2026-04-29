/**
 * x402 payments — public exports.
 */

export {
  // schemas
  PaymentRequirementsSchema,
  PaymentRequiredBodySchema,
  PaymentPayloadSchema,
  ExactEvmPayloadSchema,
  ExactEvmPayloadAuthorizationSchema,
  SettleResponseSchema,
  NetworkSchema as X402NetworkSchema,
  // constants
  SCHEMES as X402_SCHEMES,
  X402_REQUEST_HEADER,
  X402_RESPONSE_HEADER,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
  NETWORK_TO_CHAIN_ID,
  // types
  type PaymentRequirements,
  type PaymentRequiredBody,
  type PaymentPayload,
  type ExactEvmPayload,
  type ExactEvmPayloadAuthorization,
  type SettleResponse,
  type X402Network,
  type Scheme as X402Scheme,
} from './schemes.js';

export {
  createPaymentPayload,
  encodePaymentHeader,
  decodePaymentHeader,
  type CreatePaymentOptions,
} from './sign.js';

export {
  signPermit,
  encodePermitHeader,
  decodePermitHeader,
  PERMIT_TYPES,
  PERMIT_PRIMARY_TYPE,
  type PermitMessage,
  type SignPermitOptions,
  type EncodedPermitPayload,
} from './permit.js';

export {
  createFacilitatorClient,
  createCdpFacilitatorAuth,
  type FacilitatorClient,
  type FacilitatorConfig,
  type VerifyResult,
  type DiscoveredResource,
} from './facilitator.js';

export {
  wrapFetchWithPayment,
  X402Error,
  type WrapFetchWithPaymentOptions,
  type PaymentTraceFn,
  type PrePaymentHook,
} from './client.js';

export {
  paymentMiddleware,
  type PaymentMiddlewareOptions,
  type PaywallRoute,
  type Middleware as X402Middleware,
} from './server.js';

export {
  createBudgetState,
  checkBudget,
  recordSpend,
  markWarned,
  formatAtomicUsdc,
  usdCentsToUsdcAtomic,
  DEFAULT_SOFT_WARN_USD_CENTS,
  DEFAULT_HARD_ABORT_USD_CENTS,
  type BudgetState,
  type BudgetCheck,
} from './budget.js';

export {
  createPayTool,
  createDiscoverAgentsTool,
  createPaymentToolset,
  PayInputSchema,
  DiscoverAgentsInputSchema,
  type PayInput,
  type PayOutput,
  type DiscoverAgentsInput,
  type DiscoverAgentsOutput,
  type CreatePayToolOptions,
  type CreateDiscoverAgentsToolOptions,
} from './tool.js';

export {
  createPaymentTraceWriter,
  createInboundPaymentTraceWriter,
  createPrePaymentHookGate,
  type CreatePaymentTraceWriterOptions,
  type CreatePrePaymentHookGateOptions,
} from './trace.js';

export {
  createSettleFeedbackWriter,
  AutoFeedbackConfigSchema,
  type AutoFeedbackConfig,
  type CreateSettleFeedbackWriterOptions,
  type LookupAgentId,
} from './feedback.js';
