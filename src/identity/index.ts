/**
 * ERC-8004 identity surface — public exports.
 */

export {
  IDENTITY_REGISTRY_ABI,
  REPUTATION_REGISTRY_ABI,
  RESERVED_METADATA_KEYS,
  REGISTRATION_TYPE_V1,
} from './abi.js';

export {
  AgentCardSchema,
  Erc8004ServiceSchema,
  Erc8004RegistrationEntrySchema,
  Erc8004RegistrationFileSchema,
  TRUST_MODELS,
  withIdentity,
  withPayments,
  withA2A,
  toErc8004RegistrationFile,
  toA2AAgentCard,
  toAgentRegistrationProof,
  formatAgentRegistry,
  type AgentCard,
  type Erc8004Service,
  type Erc8004RegistrationEntry,
  type Erc8004RegistrationFile,
  type TrustModel,
  type IdentityCtx,
  type PaymentsCtx,
  type A2aCtx,
} from './agent-card.js';

export {
  registerAgent,
  getAgent,
  setAgentWallet,
  giveFeedback,
  getFeedbackSummary,
  type RegisterAgentOptions,
  type RegisterAgentResult,
  type GetAgentOptions,
  type AgentRecord,
  type SetAgentWalletOptions,
  type GiveFeedbackOptions,
  type FeedbackSummary,
} from './registry.js';

export { serveAgentCard, type ServeOptions, type ServingHandle } from './serve.js';

export {
  signSetAgentWalletAuthorization,
  readContractEip712Domain,
  SET_AGENT_WALLET_PRIMARY_TYPE,
  SET_AGENT_WALLET_TYPES,
  type SignSetAgentWalletOptions,
  type SignSetAgentWalletResult,
  type ContractEip712Domain,
} from './sign-wallet.js';
