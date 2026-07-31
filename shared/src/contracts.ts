import { parseAbi } from "viem";

export const agentRegistryAbi = parseAbi([
  "function register(address agent, uint8 role) external",
  "function roleOf(address agent) external view returns (uint8)",
  "event AgentRegistered(address indexed agent, uint8 role)",
]);

export const conversionRegistryAbi = parseAbi([
  "struct Claim { bytes32 campaignId; address publisher; bytes32 nullifier; bytes32 evidenceHash; uint64 submittedAtBlock; uint64 verdictAtBlock; uint8 status; uint8 reason; }",
  "function submitClaim(bytes32 campaignId, bytes32 nullifier, bytes32 evidenceHash) external returns (uint256)",
  "function postVerdict(uint256 claimId, bool approved, uint8 reason) external",
  "function getClaim(uint256 claimId) external view returns (Claim memory)",
  "function claimCount() external view returns (uint256)",
  "function nullifierUsed(bytes32 campaignId, bytes32 nullifier) external view returns (bool)",
  "event ClaimSubmitted(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher, bytes32 nullifier, bytes32 evidenceHash)",
  "event ClaimVerified(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher)",
  "event ClaimRejected(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher, uint8 reason)",
  "event ClaimSettled(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher)",
  "event ClaimDisputed(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher)",
]);

export const campaignEscrowAbi = parseAbi([
  "struct Campaign { address advertiser; address operationalWallet; uint96 pricePerConversion; uint96 budget; uint96 recognizedTotal; uint96 reimbursedTotal; uint32 disputeWindowBlocks; bytes32 policyHash; }",
  "struct PublisherAllocation { uint96 cap; uint96 recognized; bool enrolled; }",
  "function createCampaign(bytes32 campaignId, address operationalWallet, uint96 pricePerConversion, uint96 budget, uint32 disputeWindowBlocks, bytes32 policyHash, address[] publishers, uint96[] caps) external payable",
  "function object(uint256 claimId) external",
  "function autoSettle(uint256 claimId) external",
  "function reallocate(bytes32 campaignId, address fromPublisher, address toPublisher, uint96 amount, bytes32 reasonCode) external",
  "function trueUp(bytes32 campaignId) external returns (uint96)",
  "function getCampaign(bytes32 campaignId) external view returns (Campaign memory)",
  "function getAllocation(bytes32 campaignId, address publisher) external view returns (PublisherAllocation memory)",
  "function payoutRecognized(uint256 claimId) external view returns (bool)",
  "event CampaignCreated(bytes32 indexed campaignId, address indexed advertiser, address operationalWallet, uint96 pricePerConversion, uint96 budget, uint32 disputeWindowBlocks, bytes32 policyHash)",
  "event PublisherEnrolled(bytes32 indexed campaignId, address indexed publisher, uint96 cap, uint256 gasProvision)",
  "event PayoutRecognized(bytes32 indexed campaignId, uint256 indexed claimId, address indexed publisher, uint96 amount)",
  "event ClaimObjected(bytes32 indexed campaignId, uint256 indexed claimId, address indexed publisher)",
  "event BudgetReallocated(bytes32 indexed campaignId, address indexed fromPublisher, address indexed toPublisher, uint96 amount, bytes32 reasonCode, uint96 newFromCap, uint96 newToCap)",
  "event TruedUp(bytes32 indexed campaignId, address indexed operationalWallet, uint96 amount)",
]);

export const CLAIM_STATUS = {
  NONE: 0,
  PENDING: 1,
  VERIFIED: 2,
  REJECTED: 3,
  SETTLED: 4,
  DISPUTED: 5,
} as const;

// Mirrors RejectReason in ConversionRegistry.sol. Append-only: existing codes
// keep their values so verdicts from earlier deployments stay readable.
export const REJECT_REASON = {
  NONE: 0,
  EVIDENCE_MISMATCH: 1,
  TIMING_ANOMALY: 2,
  RATE_ANOMALY: 3,
  MALFORMED_EVIDENCE: 4,
  LINKED_PUBLISHER: 5,
} as const;

export const ROLE = {
  NONE: 0,
  ADVERTISER: 1,
  PUBLISHER: 2,
  VERIFIER: 3,
} as const;

export type RejectReasonName = keyof typeof REJECT_REASON;
