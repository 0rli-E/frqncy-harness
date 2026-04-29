/**
 * @frqncy-network/harness — public API
 *
 * v0.0.1 surface: chat() and stream(), with the trace writer behind them.
 * v0.1+ adds: tools, agent loop, MCP client, CLI, sandbox, external artifacts.
 */
export { chat } from './chat.js';
export { stream } from './stream.js';

export {
  TRACE_SCHEMA_VERSION,
  PROVIDERS,
  API_PROVIDERS,
  SUBSCRIPTION_PROVIDERS,
  SDK_PROVIDERS,
  isSubscriptionProvider,
  isSdkProvider,
  type ChatInput,
  type ChatResult,
  type Message,
  type ModelString,
  type Provider,
  type ApiProvider,
  type SubscriptionProvider,
  type SdkProvider,
  type Role,
  type StreamEvent,
  type TraceRecord,
  type TraceRecordType,
  type IndexRecord,
  type ConversationStatus,
  type Usage,
} from './types.js';

export {
  DEFAULT_TRACE_DIR,
  getTraceFilePath,
  getIndexFilePath,
  appendTraceRecord,
  appendIndexRecord,
  recordConversationEnd,
} from './trace.js';

export { parseModelString, getProvider } from './providers/index.js';
export {
  runSubscription,
  isClaudeCodeAvailable,
  isCodexAvailable,
  type SubscriptionRunOptions,
} from './providers/subprocess.js';
export {
  runSdkProvider,
  isClaudeAgentSdkAvailable,
  type SdkRunOptions,
} from './providers/sdk.js';

export { computeCost, getModelRate, DEFAULT_RATES, type ModelRate } from './pricing.js';

// ── Tools (v0.2) ─────────────────────────────────────────────
export {
  toAiSdkTool,
  toAiSdkToolSet,
  detectLethalTrifecta,
  type HarnessTool,
  type Permission,
  type ToolFlags,
  type ToolContext,
} from './tools/index.js';
export { bashTool, BashInputSchema, type BashInput, type BashOutput } from './tools/bash.js';
export {
  readTool,
  writeTool,
  grepTool,
  globTool,
  ReadInputSchema,
  WriteInputSchema,
  GrepInputSchema,
  GlobInputSchema,
  type ReadInput,
  type ReadOutput,
  type WriteInput,
  type WriteOutput,
  type GrepInput,
  type GrepOutput,
  type GlobInput,
  type GlobOutput,
  type GrepMatch,
} from './tools/file.js';
export { webFetchTool, WebFetchInputSchema, type WebFetchInput, type WebFetchOutput } from './tools/web.js';
export {
  webSearchTool,
  WebSearchInputSchema,
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchResultItem,
} from './tools/web-search.js';

// ── Sandbox (v0.2) ───────────────────────────────────────────
export {
  createSandbox,
  createGtrSandbox,
  createTempdirSandbox,
  isGtrAvailable,
  type Sandbox,
  type CreateSandboxOptions,
} from './sandbox/index.js';

// ── Approval (v0.2) ──────────────────────────────────────────
export {
  ApprovalManager,
  type ApprovalCallback,
  type ApprovalRequest,
  type ApprovalManagerOptions,
} from './approval.js';

// ── Skills (v0.7) ────────────────────────────────────────────
export {
  loadSkills,
  matchSkills,
  parseSkillFile,
  formatSkillsForSystemPrompt,
  resolveSkillsForPrompt,
  DEFAULT_SKILLS_DIR,
  SkillFrontmatterSchema,
  type LoadedSkill,
  type SkillFrontmatter,
  type ResolvedSkills,
} from './skills/index.js';

// ── Project instructions (v0.7) ──────────────────────────────
export {
  loadProjectInstructions,
  INSTRUCTION_FILES,
  type LoadedInstructions,
} from './instructions.js';

// ── Hooks (v0.5) ─────────────────────────────────────────────
export {
  HookManager,
  HookEntrySchema,
  HooksConfigSchema,
  DEFAULT_HOOKS,
  bundledAutoCommitTraces,
  bundledMacosNotification,
  bundledEditorialLint,
  bundledCostCapMonitor,
  bundledTrifectaMonitor,
  type HookEvent,
  type HookContext,
  type PreAgentContext,
  type PostToolUseContext,
  type PostAgentContext,
  type PrePaymentContext,
  type PrePaymentDecision,
  type GuardrailEvents,
  type HookResult,
  type HookEntry,
  type HooksConfig,
} from './hooks/index.js';

// ── Payment trace body (v0.9.2) ─────────────────────────────
export {
  PaymentTraceBodySchema,
  type PaymentTraceBody,
} from './types.js';

// ── Auth (v0.2) ──────────────────────────────────────────────
export {
  loadAuthStore,
  saveAuthStore,
  resolveApiKey,
  hydrateApiKeysIntoEnv,
  AUTH_PROVIDERS,
  ENV_VAR_BY_PROVIDER,
  DEFAULT_AUTH_PATH,
  AuthStoreSchema,
  type AuthProvider,
  type AuthStore,
} from './auth/index.js';

// ── Codify (v0.8) — self-improvement primitive ───────────────
export {
  runCodifyCommand,
  buildCodifyPrompt,
  extractFailureSignal,
  generateSlug,
  extractTestCode,
  formatManifestEntry,
  INOCULATION_SENTENCE,
  type CodifyCommandOptions,
  type CodifyResult,
  type FailureSignal,
} from './commands/codify.js';

// ── Reflect (v0.8) — cross-trace failure-mode synthesis ──────
export {
  runReflectCommand,
  buildReflectionPrompt,
  buildTraceSummary,
  renderProposalDocument,
  parseSince as parseReflectSince,
  REFLECT_SYSTEM_PROMPT,
  type ReflectCommandOptions,
  type ReflectResult,
  type TraceSummary,
} from './commands/reflect.js';

// ── Ralph (v0.8) — persistent outer loop ─────────────────────
export {
  runRalphCommand,
  matchesCompletionPredicate,
  buildInitialPrompt as buildRalphInitialPrompt,
  buildContinuationPrompt as buildRalphContinuationPrompt,
  fileExists as ralphFileExists,
  RALPH_SYSTEM_PROMPT,
  type RalphCommandOptions,
  type RalphResult,
  type RalphStatus,
  type IterationRecord,
} from './commands/ralph.js';

// ── Evolve (v0.8) — closes the self-improvement loop ────────
export {
  runEvolveCommand,
  parseProposalsFromMarkdown,
  buildImplementationPrompt,
  parseChangedFiles,
  upgradeToSdkLane,
  type EvolveCommandOptions,
  type EvolveResult,
  type EvolveStatus,
  type ParsedProposal,
  type ExecResult as EvolveExecResult,
} from './commands/evolve.js';

// ── Evolve safety gates (v0.8.1) — rubric + voice + inoculation ──
export {
  rubricAnchorGate,
  voiceAnchorGate,
  inoculationAuditGate,
  runPreEvolveGate,
  parseVoiceAnchor,
  loadVoiceAnchor,
  matchesAnyAnchor,
  extractAddedLines,
  DEFAULT_RUBRIC_ANCHORS,
  DEFAULT_VOICE_ANCHOR_PATH,
  INOCULATION_REQUIRED_PHRASE,
  type GateName,
  type GateResult,
  type ChangeSet,
  type VoiceAnchor,
  type PreEvolveGateInput,
  type PreEvolveGateResult,
} from './commands/evolve-safety.js';

// ── Evolve auto-PR (v0.8.2) — closes the last manual step ──
export {
  createPullRequest,
  generateBranchName,
  formatPrTitle,
  formatCommitMessage,
  formatPrBody,
  extractPrUrl,
  PROTECTED_BRANCHES,
  type AutoPrStatus,
  type AutoPrInput,
  type AutoPrResult,
  type ExecResult as AutoPrExecResult,
  type ExecFn,
} from './commands/evolve-pr.js';

// ── Gain (v0.9) — cost decomposition by tool / model / conversation ──
export {
  runGainCommand,
  parsePeriod as parseGainPeriod,
  aggregateToolStats,
  inferToolName,
  type GainCommandOptions,
  type GainResult,
  type ModelSpend,
  type ToolCallStat,
  type TopConversation,
  type X402Spend,
} from './commands/gain.js';

// ── Compress-memory (v0.9) — token-saving on stable agent inputs ──
export {
  runCompressMemoryCommand,
  hashContent,
  parseFrontmatter,
  isAlreadyCompressed,
  getCompressedSourceHash,
  buildCompressedFile,
  COMPRESS_SYSTEM_PROMPT,
  type CompressStatus,
  type CompressFileResult,
  type CompressMemoryCommandOptions,
  type CompressMemoryResult,
} from './commands/compress-memory.js';

// ── Eval three-arm (v0.9) — methodological gate against placebo skills ──
export {
  runEvalThreeArmCommand,
  scoreFixture,
  loadFixtures,
  type ArmName,
  type ArmResult,
  type EvalFixture,
  type EvalThreeArmCommandOptions,
  type EvalThreeArmResult,
  type FixtureRun,
} from './commands/eval-three-arm.js';

// ── Frqncy OS router (v0.10/v0.12/v0.13) — persona-based agent organization ──
export {
  runFrqncyCommand,
  parsePersonaFile,
  defaultLoadPersona,
  listPersonas,
  parseRoutingDecision,
  buildSynthesisPrompt,
  formatCouncilDeliberation,
  generateDeliberationSlug,
  ROUTING_INSTRUCTIONS,
  SYNTHESIS_INSTRUCTIONS,
  COUNCIL_MEMBERS,
  DEFAULT_PERSONA_DIR,
  DEFAULT_FRQNCY_PERSONA,
  DEFAULT_DELIBERATIONS_DIR,
  type FrqncyCommandOptions,
  type FrqncyResult,
  type FrqncyMode,
  type RoutingDecision,
  type LoadedPersona,
  type PersonaFrontmatter,
  type PersonaResponse,
} from './commands/frqncy.js';

// ── Learning Agent (v0.11) — self-improvement on the FRQNCY OS organization ──
export {
  runLearningAgentRun,
  runLearningAgentCommand,
  isCouncilPersona,
  shouldRefusePersonaUpdate,
  formatProposalMarkdown,
  type LearningAgentSubcommand,
  type LearningAgentSubcommandRunOptions,
  type LearningAgentRunResult,
  type LearningAgentProposal,
  type LearningAgentStatus,
} from './commands/learning-agent.js';

// ── Wallet (v0.9) — pluggable signer for on-chain ops ────────
export {
  createSigner,
  loadWalletCredentials,
  saveWalletCredentials,
  getNetworkInfo,
  resolveNetwork,
  WalletCredentialsSchema,
  NETWORKS,
  type Signer,
  type Network as WalletNetwork,
  type NetworkInfo,
  type WalletCredentials,
  type CreateSignerOptions,
  type Eip712TypedData,
  type Address,
  type Hex,
} from './wallet/index.js';

// ── ERC-8004 identity (v0.9) ─────────────────────────────────
export {
  IDENTITY_REGISTRY_ABI,
  REPUTATION_REGISTRY_ABI,
  RESERVED_METADATA_KEYS,
  REGISTRATION_TYPE_V1,
  AgentCardSchema,
  Erc8004ServiceSchema,
  Erc8004RegistrationEntrySchema,
  Erc8004RegistrationFileSchema,
  TRUST_MODELS,
  withIdentity,
  withPayments as withPaymentsCard,
  withA2A,
  toErc8004RegistrationFile,
  toA2AAgentCard,
  toAgentRegistrationProof,
  formatAgentRegistry,
  registerAgent,
  getAgent,
  setAgentWallet,
  giveFeedback,
  getFeedbackSummary,
  serveAgentCard,
  type AgentCard,
  type Erc8004Service,
  type Erc8004RegistrationEntry,
  type Erc8004RegistrationFile,
  type TrustModel,
  type IdentityCtx,
  type PaymentsCtx as IdentityPaymentsCtx,
  type A2aCtx,
  type RegisterAgentOptions,
  type RegisterAgentResult,
  type GetAgentOptions,
  type AgentRecord,
  type SetAgentWalletOptions,
  type GiveFeedbackOptions,
  type FeedbackSummary,
  type ServeOptions as ServeAgentCardOptions,
  type ServingHandle,
} from './identity/index.js';

// ── Serve (v0.14) — agent-as-a-service ──────────────────────
export {
  serveAgent,
  createSkillRouteHandler,
  ServeConfigSchema,
  ServeRouteConfigSchema,
  type ServeAgentOptions,
  type ServeRouteSpec,
  type ServeAgentHandle,
  type SkillRouteOptions,
  type PaidSkillResponse,
  type ServeConfig,
  type ServeRouteConfig,
} from './serve/index.js';

// ── x402 payments (v0.9) ─────────────────────────────────────
export {
  PaymentRequirementsSchema,
  PaymentRequiredBodySchema,
  PaymentPayloadSchema,
  ExactEvmPayloadSchema,
  ExactEvmPayloadAuthorizationSchema,
  SettleResponseSchema,
  X402NetworkSchema,
  X402_SCHEMES,
  X402_REQUEST_HEADER,
  X402_RESPONSE_HEADER,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
  NETWORK_TO_CHAIN_ID,
  createPaymentPayload,
  encodePaymentHeader,
  decodePaymentHeader,
  createFacilitatorClient,
  createCdpFacilitatorAuth,
  wrapFetchWithPayment,
  X402Error,
  paymentMiddleware,
  createBudgetState,
  checkBudget,
  recordSpend,
  markWarned,
  formatAtomicUsdc,
  usdCentsToUsdcAtomic,
  DEFAULT_SOFT_WARN_USD_CENTS,
  DEFAULT_HARD_ABORT_USD_CENTS,
  createPayTool,
  createDiscoverAgentsTool,
  createPaymentToolset,
  PayInputSchema,
  DiscoverAgentsInputSchema,
  type PaymentRequirements,
  type PaymentRequiredBody,
  type PaymentPayload,
  type ExactEvmPayload,
  type ExactEvmPayloadAuthorization,
  type SettleResponse,
  type X402Network,
  type X402Scheme,
  type CreatePaymentOptions,
  type FacilitatorClient,
  type FacilitatorConfig,
  type VerifyResult,
  type DiscoveredResource,
  type WrapFetchWithPaymentOptions,
  type PaymentTraceFn,
  type PrePaymentHook,
  type PaymentMiddlewareOptions,
  type PaywallRoute,
  type X402Middleware,
  type BudgetState,
  type BudgetCheck,
  type PayInput,
  type PayOutput,
  type DiscoverAgentsInput,
  type DiscoverAgentsOutput,
  type CreatePayToolOptions,
  type CreateDiscoverAgentsToolOptions,
  // v0.9.2 — payment trace + pre-payment hook integration
  createPaymentTraceWriter,
  createInboundPaymentTraceWriter,
  createPrePaymentHookGate,
  type CreatePaymentTraceWriterOptions,
  type CreatePrePaymentHookGateOptions,
  // v0.13 — reputation auto-write on settled outbound payments
  createSettleFeedbackWriter,
  AutoFeedbackConfigSchema,
  type AutoFeedbackConfig,
  type CreateSettleFeedbackWriterOptions,
  type LookupAgentId,
  // v0.14.1 — verifiable settlement receipts
  signSettlementReceipt,
  verifySettlementReceipt,
  encodeReceiptHeader,
  decodeReceiptHeader,
  createReceiptIssuer,
  SettlementReceiptSchema,
  SETTLEMENT_RECEIPT_PRIMARY_TYPE,
  SETTLEMENT_RECEIPT_TYPES,
  X402_RECEIPT_HEADER,
  DEFAULT_RECEIPT_DOMAIN_NAME,
  DEFAULT_RECEIPT_DOMAIN_VERSION,
  type SettlementReceipt,
  type SignedSettlementReceipt,
  type SignSettlementReceiptOptions,
  type VerifySettlementReceiptOptions,
  type VerifyReceiptResult,
  type ReceiptDomain,
  type CreateReceiptIssuerOptions,
} from './payments/index.js';

// ── Bridges (v0.9.1) — Daydreams interop + router lane ──────
export {
  harnessToolToDaydreamsAction,
  daydreamsActionToHarnessTool,
  createDaydreamsExtension,
  daydreamsExtensionToHarnessTools,
  createDaydreamsRouterFetch,
  daydreamsRouterChat,
  daydreamsRouterModels,
  DEFAULT_DAYDREAMS_ROUTER_URL,
  DAYDREAMS_PAYMENT_HEADER,
  DAYDREAMS_REQUIRED_HEADER,
  DAYDREAMS_SESSION_HEADER,
  type DaydreamsActionLike,
  type DaydreamsExtensionLike,
  type HarnessToolToActionOptions,
  type ActionToHarnessToolOptions,
  type CreateDaydreamsExtensionOptions,
  type ExtensionToHarnessToolsOptions,
  type CreateDaydreamsRouterFetchOptions,
  type DaydreamsRouterChatRequest,
  type DaydreamsRouterChatResult,
} from './bridges/index.js';

// ── MCP (v0.2) ───────────────────────────────────────────────
export {
  loadMcpConfig,
  saveMcpConfig,
  getEnabledServers,
  claudeDesktopConfigPath,
  DEFAULT_MCP_CONFIG_PATH,
  McpConfigSchema,
  McpServerSchema,
  HarnessExtensionsSchema,
  connectMcpServer,
  connectMcpServers,
  callMcpTool,
  mcpToolToHarnessTool,
  flattenMcpToolset,
  type McpConfig,
  type McpServerEntry,
  type HarnessExtensions,
  type McpToolDescriptor,
  type ConnectedMcpServer,
  type ConnectMcpServersResult,
  type McpHarnessTool,
} from './mcp/index.js';
