/**
 * `setAgentWallet` EIP-712 authorization signer.
 *
 * Per EIP-8004, rotating an agent's bound `agentWallet` requires an off-chain
 * signature from the *new wallet* proving control. The on-chain function:
 *
 *   setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
 *
 * The signature is EIP-712 typed-data over:
 *
 *   SetAgentWallet(uint256 agentId, address newWallet, uint256 deadline)
 *
 * with the IdentityRegistry contract's EIP-712 domain. Per the spec the
 * signature MUST cover (agentId, newWallet, deadline) plus the registry's
 * domain (chainId + verifyingContract) so it can't be replayed across chains,
 * registries, or to other agents.
 *
 * The new wallet may be:
 *   - an EOA: `ecrecover` checks the signature directly
 *   - a smart-contract wallet (ERC-1271): the contract's `isValidSignature`
 *     validates. For our CDP smart accounts the *owner EOA* signs; the
 *     smart-account contract recovers the same address and accepts.
 *
 * Domain values come from the contract's EIP-5267 `eip712Domain()` view
 * call, NOT from constants — that way the signer is robust to contracts
 * that pin different `name` / `version` strings on different chains.
 */
import { IDENTITY_REGISTRY_ABI } from './abi.js';
import {
  getNetworkInfo,
  type Network,
  type Signer,
  type Address,
  type Hex,
} from '../wallet/index.js';
import { peerImport } from '../wallet/peerimport.js';

/** EIP-712 typed-data primary type for setAgentWallet authorization. */
export const SET_AGENT_WALLET_PRIMARY_TYPE = 'SetAgentWallet';

/** EIP-712 typed-data struct for setAgentWallet authorization. */
export const SET_AGENT_WALLET_TYPES = {
  SetAgentWallet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export interface ContractEip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/**
 * Read the IdentityRegistry's EIP-712 domain via its `eip712Domain()` view
 * function (EIP-5267). Returns `null` if the call fails — older contracts
 * may not expose this.
 */
export async function readContractEip712Domain(
  network: Network,
  registryAddress?: Address,
): Promise<ContractEip712Domain | null> {
  const info = getNetworkInfo(network);
  const verifying = (registryAddress ?? info.identityRegistry) as Address;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viem: any = await peerImport('viem');
  const pc = viem.createPublicClient({ transport: viem.http(info.rpcUrl) });
  try {
    const result = (await pc.readContract({
      address: verifying,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'eip712Domain',
      args: [],
    })) as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];
    return {
      name: result[1],
      version: result[2],
      chainId: Number(result[3]),
      verifyingContract: result[4],
    };
  } catch {
    return null;
  }
}

export interface SignSetAgentWalletOptions {
  /**
   * Signer for the *new wallet* — i.e. the address being bound. For CDP
   * smart accounts, this is the owner EOA via the smart account's ERC-1271
   * `isValidSignature`. For viem private-key signers, it's the EOA itself.
   */
  signer: Signer;
  network?: Network;
  agentId: number;
  /**
   * Address being bound. Defaults to `signer.smartAccount ?? signer.address` —
   * smart-account-first since that's the common case for CDP setups.
   */
  newWallet?: Address;
  /** Validity deadline (UNIX seconds). Defaults to 30 minutes from now. */
  deadlineSeconds?: bigint;
  /** Override the EIP-712 domain (skip the runtime read). */
  domain?: ContractEip712Domain;
}

export interface SignSetAgentWalletResult {
  signature: Hex;
  newWallet: Address;
  deadline: bigint;
  domain: ContractEip712Domain;
}

/**
 * Produce the EIP-712 signature `setAgentWallet` consumes.
 *
 * Defaults: deadline = now + 1800s, newWallet = signer's smart-account address
 * if present else the EOA address. Both are overridable.
 */
export async function signSetAgentWalletAuthorization(
  opts: SignSetAgentWalletOptions,
): Promise<SignSetAgentWalletResult> {
  const network = opts.network ?? opts.signer.network;
  const newWallet = (opts.newWallet ?? opts.signer.smartAccount ?? opts.signer.address) as Address;
  const deadline = opts.deadlineSeconds ?? BigInt(Math.floor(Date.now() / 1000) + 1800);

  // Read domain from chain — falls back to a sensible default if unreachable.
  const fromChain = opts.domain ?? (await readContractEip712Domain(network));
  const info = getNetworkInfo(network);
  const domain: ContractEip712Domain = fromChain ?? {
    name: 'ERC8004IdentityRegistry',
    version: '1',
    chainId: info.chainId,
    verifyingContract: info.identityRegistry,
  };

  const signature = await opts.signer.signTypedData({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: SET_AGENT_WALLET_TYPES as unknown as Record<
      string,
      Array<{ name: string; type: string }>
    >,
    primaryType: SET_AGENT_WALLET_PRIMARY_TYPE,
    message: {
      agentId: BigInt(opts.agentId),
      newWallet,
      deadline,
    },
  });

  return { signature, newWallet, deadline, domain };
}
