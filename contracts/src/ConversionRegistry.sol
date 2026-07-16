// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {AgentRegistry, Role} from "./AgentRegistry.sol";

enum ClaimStatus {
    NONE,
    PENDING,
    VERIFIED,
    REJECTED,
    SETTLED,
    DISPUTED
}

enum RejectReason {
    NONE,
    EVIDENCE_MISMATCH,
    TIMING_ANOMALY,
    RATE_ANOMALY,
    MALFORMED_EVIDENCE
}

struct Claim {
    bytes32 campaignId;
    address publisher;
    bytes32 nullifier;
    bytes32 evidenceHash;
    uint64 submittedAtBlock;
    uint64 verdictAtBlock;
    ClaimStatus status;
    RejectReason reason;
}

/// @notice Claim lifecycle: PENDING -> VERIFIED -> SETTLED | DISPUTED, or
/// PENDING -> REJECTED. Duplicate nullifiers are refused by this contract
/// itself — no verifier or frontend trust involved. Settlement transitions
/// are reserved for the escrow (the settlement authority), which owns the
/// dispute-window and budget accounting.
contract ConversionRegistry {
    AgentRegistry public immutable agents;
    address public immutable admin;
    address public settlementAuthority;

    uint256 public claimCount;
    mapping(uint256 claimId => Claim) private _claims;
    mapping(bytes32 campaignId => mapping(bytes32 nullifier => bool)) public nullifierUsed;

    event ClaimSubmitted(
        uint256 indexed claimId,
        bytes32 indexed campaignId,
        address indexed publisher,
        bytes32 nullifier,
        bytes32 evidenceHash
    );
    event ClaimVerified(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher);
    event ClaimRejected(
        uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher, RejectReason reason
    );
    event ClaimSettled(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher);
    event ClaimDisputed(uint256 indexed claimId, bytes32 indexed campaignId, address indexed publisher);

    error NotAdmin();
    error NotPublisher();
    error NotVerifier();
    error NotSettlementAuthority();
    error AuthorityAlreadySet();
    error ZeroAddress();
    error DuplicateNullifier(bytes32 campaignId, bytes32 nullifier);
    error UnknownClaim(uint256 claimId);
    error NotPending(uint256 claimId);
    error NotVerified(uint256 claimId);
    error MissingRejectReason();
    error UnexpectedRejectReason();

    constructor(AgentRegistry agents_) {
        agents = agents_;
        admin = msg.sender;
    }

    /// @notice One-time wiring of the escrow contract. Only the escrow may
    /// move claims into SETTLED or DISPUTED.
    function setSettlementAuthority(address authority) external {
        if (msg.sender != admin) revert NotAdmin();
        if (authority == address(0)) revert ZeroAddress();
        if (settlementAuthority != address(0)) revert AuthorityAlreadySet();
        settlementAuthority = authority;
    }

    function submitClaim(bytes32 campaignId, bytes32 nullifier, bytes32 evidenceHash)
        external
        returns (uint256 claimId)
    {
        if (agents.roleOf(msg.sender) != Role.PUBLISHER) revert NotPublisher();
        if (nullifierUsed[campaignId][nullifier]) {
            revert DuplicateNullifier(campaignId, nullifier);
        }
        nullifierUsed[campaignId][nullifier] = true;

        claimId = ++claimCount;
        _claims[claimId] = Claim({
            campaignId: campaignId,
            publisher: msg.sender,
            nullifier: nullifier,
            evidenceHash: evidenceHash,
            submittedAtBlock: uint64(block.number),
            verdictAtBlock: 0,
            status: ClaimStatus.PENDING,
            reason: RejectReason.NONE
        });
        emit ClaimSubmitted(claimId, campaignId, msg.sender, nullifier, evidenceHash);
    }

    function postVerdict(uint256 claimId, bool approved, RejectReason reason) external {
        if (agents.roleOf(msg.sender) != Role.VERIFIER) revert NotVerifier();
        Claim storage claim = _claims[claimId];
        if (claim.status == ClaimStatus.NONE) revert UnknownClaim(claimId);
        if (claim.status != ClaimStatus.PENDING) revert NotPending(claimId);

        claim.verdictAtBlock = uint64(block.number);
        if (approved) {
            if (reason != RejectReason.NONE) revert UnexpectedRejectReason();
            claim.status = ClaimStatus.VERIFIED;
            emit ClaimVerified(claimId, claim.campaignId, claim.publisher);
        } else {
            if (reason == RejectReason.NONE) revert MissingRejectReason();
            claim.status = ClaimStatus.REJECTED;
            claim.reason = reason;
            emit ClaimRejected(claimId, claim.campaignId, claim.publisher, reason);
        }
    }

    function markSettled(uint256 claimId) external {
        Claim storage claim = _requireVerifiedByAuthority(claimId);
        claim.status = ClaimStatus.SETTLED;
        emit ClaimSettled(claimId, claim.campaignId, claim.publisher);
    }

    function markDisputed(uint256 claimId) external {
        Claim storage claim = _requireVerifiedByAuthority(claimId);
        claim.status = ClaimStatus.DISPUTED;
        emit ClaimDisputed(claimId, claim.campaignId, claim.publisher);
    }

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        if (_claims[claimId].status == ClaimStatus.NONE) revert UnknownClaim(claimId);
        return _claims[claimId];
    }

    function _requireVerifiedByAuthority(uint256 claimId) private view returns (Claim storage claim) {
        if (msg.sender != settlementAuthority || settlementAuthority == address(0)) {
            revert NotSettlementAuthority();
        }
        claim = _claims[claimId];
        if (claim.status == ClaimStatus.NONE) revert UnknownClaim(claimId);
        if (claim.status != ClaimStatus.VERIFIED) revert NotVerified(claimId);
    }
}
