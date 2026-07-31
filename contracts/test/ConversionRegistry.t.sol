// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {AgentRegistry, Role} from "../src/AgentRegistry.sol";
import {
    Claim,
    ClaimStatus,
    ConversionRegistry,
    RejectReason
} from "../src/ConversionRegistry.sol";

contract ConversionRegistryTest is Test {
    AgentRegistry internal agents;
    ConversionRegistry internal registry;

    address internal publisher = makeAddr("publisher");
    address internal verifier = makeAddr("verifier");
    address internal escrow = makeAddr("escrow");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant CAMPAIGN = keccak256("campaign-1");
    bytes32 internal constant NULLIFIER = keccak256("nullifier-1");
    bytes32 internal constant EVIDENCE = keccak256("evidence-1");

    function setUp() public {
        agents = new AgentRegistry();
        registry = new ConversionRegistry(agents);
        agents.register(publisher, Role.PUBLISHER);
        agents.register(verifier, Role.VERIFIER);
        registry.setSettlementAuthority(escrow);
    }

    function _submit() internal returns (uint256) {
        vm.prank(publisher);
        return registry.submitClaim(CAMPAIGN, NULLIFIER, EVIDENCE);
    }

    function test_submitClaim() public {
        uint256 claimId = _submit();
        Claim memory claim = registry.getClaim(claimId);
        assertEq(claim.publisher, publisher);
        assertEq(claim.campaignId, CAMPAIGN);
        assertEq(claim.nullifier, NULLIFIER);
        assertEq(claim.evidenceHash, EVIDENCE);
        assertEq(uint8(claim.status), uint8(ClaimStatus.PENDING));
        assertTrue(registry.nullifierUsed(CAMPAIGN, NULLIFIER));
    }

    function test_onlyPublisherSubmits() public {
        vm.prank(stranger);
        vm.expectRevert(ConversionRegistry.NotPublisher.selector);
        registry.submitClaim(CAMPAIGN, NULLIFIER, EVIDENCE);
    }

    /// I-2: a nullifier can never be accepted twice within a campaign —
    /// enforced by this contract, no verifier involved.
    function test_duplicateNullifierReverts() public {
        _submit();
        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(ConversionRegistry.DuplicateNullifier.selector, CAMPAIGN, NULLIFIER)
        );
        registry.submitClaim(CAMPAIGN, NULLIFIER, EVIDENCE);
    }

    function test_sameNullifierDifferentCampaignAllowed() public {
        _submit();
        vm.prank(publisher);
        uint256 claimId = registry.submitClaim(keccak256("campaign-2"), NULLIFIER, EVIDENCE);
        assertEq(uint8(registry.getClaim(claimId).status), uint8(ClaimStatus.PENDING));
    }

    function test_verdictAuthorization() public {
        uint256 claimId = _submit();
        vm.prank(stranger);
        vm.expectRevert(ConversionRegistry.NotVerifier.selector);
        registry.postVerdict(claimId, true, RejectReason.NONE);
        vm.prank(publisher);
        vm.expectRevert(ConversionRegistry.NotVerifier.selector);
        registry.postVerdict(claimId, true, RejectReason.NONE);
    }

    function test_verifyClaim() public {
        uint256 claimId = _submit();
        vm.prank(verifier);
        registry.postVerdict(claimId, true, RejectReason.NONE);
        Claim memory claim = registry.getClaim(claimId);
        assertEq(uint8(claim.status), uint8(ClaimStatus.VERIFIED));
        assertEq(claim.verdictAtBlock, uint64(block.number));
    }

    function test_rejectClaimRequiresReason() public {
        uint256 claimId = _submit();
        vm.prank(verifier);
        vm.expectRevert(ConversionRegistry.MissingRejectReason.selector);
        registry.postVerdict(claimId, false, RejectReason.NONE);

        vm.prank(verifier);
        registry.postVerdict(claimId, false, RejectReason.EVIDENCE_MISMATCH);
        Claim memory claim = registry.getClaim(claimId);
        assertEq(uint8(claim.status), uint8(ClaimStatus.REJECTED));
        assertEq(uint8(claim.reason), uint8(RejectReason.EVIDENCE_MISMATCH));
    }

    function test_rejectReasonOrdinalsAreStable() public pure {
        // Verdicts are permanent public records, and a reason code is only
        // meaningful if its ordinal never moves. New reasons append; existing
        // ones keep their number so evidence written by an earlier deployment
        // still decodes correctly against this ABI.
        assertEq(uint8(RejectReason.NONE), 0);
        assertEq(uint8(RejectReason.EVIDENCE_MISMATCH), 1);
        assertEq(uint8(RejectReason.TIMING_ANOMALY), 2);
        assertEq(uint8(RejectReason.RATE_ANOMALY), 3);
        assertEq(uint8(RejectReason.MALFORMED_EVIDENCE), 4);
        assertEq(uint8(RejectReason.LINKED_PUBLISHER), 5);
    }

    function test_rejectClaimForLinkedPublisher() public {
        uint256 claimId = _submit();
        vm.prank(verifier);
        registry.postVerdict(claimId, false, RejectReason.LINKED_PUBLISHER);
        Claim memory claim = registry.getClaim(claimId);
        assertEq(uint8(claim.status), uint8(ClaimStatus.REJECTED));
        assertEq(uint8(claim.reason), uint8(RejectReason.LINKED_PUBLISHER));
    }

    function test_approvalRejectsSpuriousReason() public {
        uint256 claimId = _submit();
        vm.prank(verifier);
        vm.expectRevert(ConversionRegistry.UnexpectedRejectReason.selector);
        registry.postVerdict(claimId, true, RejectReason.TIMING_ANOMALY);
    }

    function test_noDoubleVerdict() public {
        uint256 claimId = _submit();
        vm.prank(verifier);
        registry.postVerdict(claimId, true, RejectReason.NONE);
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(ConversionRegistry.NotPending.selector, claimId));
        registry.postVerdict(claimId, false, RejectReason.TIMING_ANOMALY);
    }

    /// No path from REJECTED to any settleable state (R4.5 refusal path).
    function test_rejectedClaimCannotBeSettledOrDisputed() public {
        uint256 claimId = _submit();
        vm.prank(verifier);
        registry.postVerdict(claimId, false, RejectReason.TIMING_ANOMALY);

        vm.startPrank(escrow);
        vm.expectRevert(abi.encodeWithSelector(ConversionRegistry.NotVerified.selector, claimId));
        registry.markSettled(claimId);
        vm.expectRevert(abi.encodeWithSelector(ConversionRegistry.NotVerified.selector, claimId));
        registry.markDisputed(claimId);
        vm.stopPrank();
    }

    function test_settlementAuthorityGating() public {
        uint256 claimId = _submit();
        vm.prank(verifier);
        registry.postVerdict(claimId, true, RejectReason.NONE);

        vm.prank(stranger);
        vm.expectRevert(ConversionRegistry.NotSettlementAuthority.selector);
        registry.markSettled(claimId);

        vm.prank(escrow);
        registry.markSettled(claimId);
        assertEq(uint8(registry.getClaim(claimId).status), uint8(ClaimStatus.SETTLED));
    }

    function test_settlementAuthoritySetOnce() public {
        vm.expectRevert(ConversionRegistry.AuthorityAlreadySet.selector);
        registry.setSettlementAuthority(stranger);
    }

    /// R5.4: the fraud log is reconstructable from events alone.
    function test_fraudLogReconstructionFromEvents() public {
        vm.recordLogs();

        vm.prank(publisher);
        uint256 ok = registry.submitClaim(CAMPAIGN, keccak256("n-ok"), keccak256("e-ok"));
        vm.prank(publisher);
        uint256 bad = registry.submitClaim(CAMPAIGN, keccak256("n-bad"), keccak256("e-bad"));

        vm.prank(verifier);
        registry.postVerdict(ok, true, RejectReason.NONE);
        vm.prank(verifier);
        registry.postVerdict(bad, false, RejectReason.EVIDENCE_MISMATCH);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 rejectedSig = keccak256("ClaimRejected(uint256,bytes32,address,uint8)");
        uint256 rejectedSeen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == rejectedSig) {
                rejectedSeen++;
                assertEq(uint256(logs[i].topics[1]), bad);
                assertEq(logs[i].topics[2], CAMPAIGN);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), publisher);
                assertEq(abi.decode(logs[i].data, (uint8)), uint8(RejectReason.EVIDENCE_MISMATCH));
            }
        }
        assertEq(rejectedSeen, 1);
    }
}
