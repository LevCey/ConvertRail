// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry, Role} from "../src/AgentRegistry.sol";
import {ClaimStatus, ConversionRegistry, RejectReason} from "../src/ConversionRegistry.sol";
import {Campaign, CampaignEscrow, IERC20, PublisherAllocation} from "../src/CampaignEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract CampaignEscrowTest is Test {
    AgentRegistry internal agents;
    ConversionRegistry internal registry;
    CampaignEscrow internal escrow;
    MockUSDC internal usdc;

    address internal advertiser = makeAddr("advertiser");
    address internal operational = makeAddr("operational");
    address internal publisherA = makeAddr("publisherA");
    address internal publisherB = makeAddr("publisherB");
    address internal verifier = makeAddr("verifier");
    address internal anyone = makeAddr("anyone");

    bytes32 internal constant CAMPAIGN = keccak256("campaign-1");
    bytes32 internal constant POLICY = keccak256("policy-config-v1");
    uint96 internal constant PRICE = 500_000; // $0.50
    uint96 internal constant BUDGET = 10_000_000; // $10
    uint96 internal constant CAP = 5_000_000; // $5 per publisher
    uint32 internal constant WINDOW = 10; // blocks

    function setUp() public {
        agents = new AgentRegistry();
        registry = new ConversionRegistry(agents);
        usdc = new MockUSDC();
        escrow = new CampaignEscrow(agents, registry, IERC20(address(usdc)));
        registry.setSettlementAuthority(address(escrow));

        agents.register(advertiser, Role.ADVERTISER);
        agents.register(publisherA, Role.PUBLISHER);
        agents.register(publisherB, Role.PUBLISHER);
        agents.register(verifier, Role.VERIFIER);

        usdc.mint(advertiser, BUDGET);
        vm.prank(advertiser);
        usdc.approve(address(escrow), type(uint256).max);
        vm.deal(advertiser, 1 ether);
    }

    function _createCampaign() internal {
        address[] memory publishers = new address[](2);
        publishers[0] = publisherA;
        publishers[1] = publisherB;
        uint96[] memory caps = new uint96[](2);
        caps[0] = CAP;
        caps[1] = CAP;
        vm.prank(advertiser);
        escrow.createCampaign{value: 0.02 ether}(
            CAMPAIGN, operational, PRICE, BUDGET, WINDOW, POLICY, publishers, caps
        );
    }

    function _verifiedClaim(address publisher, string memory salt) internal returns (uint256 claimId) {
        vm.prank(publisher);
        claimId = registry.submitClaim(CAMPAIGN, keccak256(abi.encodePacked("n-", salt)), keccak256(abi.encodePacked("e-", salt)));
        vm.prank(verifier);
        registry.postVerdict(claimId, true, RejectReason.NONE);
    }

    function _pastWindow(uint256 claimId) internal {
        uint256 verdictBlock = registry.getClaim(claimId).verdictAtBlock;
        vm.roll(verdictBlock + WINDOW + 1);
    }

    function test_createCampaignFundsEscrowAndProvisionsGas() public {
        _createCampaign();
        assertEq(usdc.balanceOf(address(escrow)), BUDGET);
        assertEq(publisherA.balance, 0.01 ether);
        assertEq(publisherB.balance, 0.01 ether);
        Campaign memory campaign = escrow.getCampaign(CAMPAIGN);
        assertEq(campaign.advertiser, advertiser);
        assertEq(campaign.policyHash, POLICY);
    }

    function test_onlyAdvertiserRoleCreates() public {
        address[] memory publishers = new address[](1);
        publishers[0] = publisherA;
        uint96[] memory caps = new uint96[](1);
        caps[0] = CAP;
        vm.prank(anyone);
        vm.expectRevert(CampaignEscrow.NotAdvertiser.selector);
        escrow.createCampaign(CAMPAIGN, operational, PRICE, BUDGET, WINDOW, POLICY, publishers, caps);
    }

    function test_autoSettleAfterWindow() public {
        _createCampaign();
        uint256 claimId = _verifiedClaim(publisherA, "1");
        _pastWindow(claimId);

        vm.prank(anyone); // silence = acceptance; settlement is permissionless
        escrow.autoSettle(claimId);

        assertEq(uint8(registry.getClaim(claimId).status), uint8(ClaimStatus.SETTLED));
        assertEq(escrow.getCampaign(CAMPAIGN).recognizedTotal, PRICE);
        assertEq(escrow.getAllocation(CAMPAIGN, publisherA).recognized, PRICE);
        assertTrue(escrow.payoutRecognized(claimId));
    }

    function test_autoSettleBlockedInsideWindow() public {
        _createCampaign();
        uint256 claimId = _verifiedClaim(publisherA, "1");
        uint256 windowEnd = registry.getClaim(claimId).verdictAtBlock + WINDOW;
        vm.expectRevert(abi.encodeWithSelector(CampaignEscrow.DisputeWindowOpen.selector, claimId, windowEnd));
        escrow.autoSettle(claimId);
    }

    function test_objectionInsideWindowBlocksSettlement() public {
        _createCampaign();
        uint256 claimId = _verifiedClaim(publisherA, "1");

        vm.prank(advertiser);
        escrow.object(claimId);
        assertEq(uint8(registry.getClaim(claimId).status), uint8(ClaimStatus.DISPUTED));

        _pastWindow(claimId);
        vm.expectRevert(abi.encodeWithSelector(CampaignEscrow.ClaimNotVerified.selector, claimId));
        escrow.autoSettle(claimId);
        assertEq(escrow.getCampaign(CAMPAIGN).recognizedTotal, 0);
    }

    function test_objectionAfterWindowReverts() public {
        _createCampaign();
        uint256 claimId = _verifiedClaim(publisherA, "1");
        uint256 windowEnd = registry.getClaim(claimId).verdictAtBlock + WINDOW;
        _pastWindow(claimId);
        vm.prank(advertiser);
        vm.expectRevert(abi.encodeWithSelector(CampaignEscrow.DisputeWindowClosed.selector, claimId, windowEnd));
        escrow.object(claimId);
    }

    function test_onlyCampaignAdvertiserObjects() public {
        _createCampaign();
        uint256 claimId = _verifiedClaim(publisherA, "1");
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(CampaignEscrow.NotCampaignAdvertiser.selector, CAMPAIGN));
        escrow.object(claimId);
    }

    /// I-3: per-publisher cap enforced at recognition time.
    function test_capExceededReverts() public {
        _createCampaign();
        vm.prank(advertiser);
        escrow.reallocate(CAMPAIGN, publisherA, publisherB, CAP - PRICE, bytes32("SETUP"));
        // publisherA cap is now exactly one conversion (PRICE).
        uint256 first = _verifiedClaim(publisherA, "1");
        _pastWindow(first);
        escrow.autoSettle(first);

        uint256 second = _verifiedClaim(publisherA, "2");
        _pastWindow(second);
        vm.expectRevert(
            abi.encodeWithSelector(CampaignEscrow.CapExceeded.selector, CAMPAIGN, publisherA, PRICE, 2 * PRICE)
        );
        escrow.autoSettle(second);
    }

    /// I-3: total budget enforced at recognition time.
    function test_budgetExceededReverts() public {
        // Campaign whose caps sum beyond the budget: budget is the binding limit.
        address[] memory publishers = new address[](2);
        publishers[0] = publisherA;
        publishers[1] = publisherB;
        uint96[] memory caps = new uint96[](2);
        caps[0] = PRICE; // one conversion each
        caps[1] = PRICE;
        bytes32 smallCampaign = keccak256("small");
        usdc.mint(advertiser, PRICE); // budget covers exactly one conversion
        vm.prank(advertiser);
        escrow.createCampaign(smallCampaign, operational, PRICE, PRICE, WINDOW, POLICY, publishers, caps);

        vm.prank(publisherA);
        uint256 first = registry.submitClaim(smallCampaign, keccak256("n-a"), keccak256("e-a"));
        vm.prank(verifier);
        registry.postVerdict(first, true, RejectReason.NONE);
        vm.prank(publisherB);
        uint256 second = registry.submitClaim(smallCampaign, keccak256("n-b"), keccak256("e-b"));
        vm.prank(verifier);
        registry.postVerdict(second, true, RejectReason.NONE);

        _pastWindow(second);
        escrow.autoSettle(first);
        vm.expectRevert(
            abi.encodeWithSelector(CampaignEscrow.BudgetExceeded.selector, smallCampaign, PRICE, 2 * PRICE)
        );
        escrow.autoSettle(second);
    }

    function test_noDoubleRecognition() public {
        _createCampaign();
        uint256 claimId = _verifiedClaim(publisherA, "1");
        _pastWindow(claimId);
        escrow.autoSettle(claimId);
        // Registry already left VERIFIED, so the guard fires there first.
        vm.expectRevert(abi.encodeWithSelector(CampaignEscrow.ClaimNotVerified.selector, claimId));
        escrow.autoSettle(claimId);
    }

    function test_reallocateAuthorizationAndHeadroom() public {
        _createCampaign();
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(CampaignEscrow.NotCampaignAdvertiser.selector, CAMPAIGN));
        escrow.reallocate(CAMPAIGN, publisherA, publisherB, PRICE, bytes32("X"));

        // Recognize one conversion for A, then try to move more than A's headroom.
        uint256 claimId = _verifiedClaim(publisherA, "1");
        _pastWindow(claimId);
        escrow.autoSettle(claimId);

        uint96 headroom = CAP - PRICE;
        vm.prank(advertiser);
        vm.expectRevert(
            abi.encodeWithSelector(
                CampaignEscrow.InsufficientCapHeadroom.selector, CAMPAIGN, publisherA, headroom, headroom + 1
            )
        );
        escrow.reallocate(CAMPAIGN, publisherA, publisherB, headroom + 1, bytes32("TOO_MUCH"));

        vm.prank(advertiser);
        escrow.reallocate(CAMPAIGN, publisherA, publisherB, headroom, bytes32("QUALITY_DIVERGENCE"));
        assertEq(escrow.getAllocation(CAMPAIGN, publisherA).cap, PRICE);
        assertEq(escrow.getAllocation(CAMPAIGN, publisherB).cap, CAP + headroom);
    }

    function test_trueUpReimbursesOperationalWallet() public {
        _createCampaign();
        uint256 first = _verifiedClaim(publisherA, "1");
        uint256 second = _verifiedClaim(publisherB, "2");
        _pastWindow(second);
        escrow.autoSettle(first);
        escrow.autoSettle(second);

        uint96 amount = escrow.trueUp(CAMPAIGN);
        assertEq(amount, 2 * PRICE);
        assertEq(usdc.balanceOf(operational), 2 * PRICE);
        assertEq(escrow.getCampaign(CAMPAIGN).reimbursedTotal, 2 * PRICE);

        vm.expectRevert(abi.encodeWithSelector(CampaignEscrow.NothingToReimburse.selector, CAMPAIGN));
        escrow.trueUp(CAMPAIGN);
    }

    /// I-1 (refusal path end-to-end): a rejected claim can never reach
    /// recognized payouts by any call sequence.
    function test_rejectedClaimNeverRecognized() public {
        _createCampaign();
        vm.prank(publisherA);
        uint256 claimId = registry.submitClaim(CAMPAIGN, keccak256("n-fraud"), keccak256("e-fraud"));
        vm.prank(verifier);
        registry.postVerdict(claimId, false, RejectReason.EVIDENCE_MISMATCH);

        vm.roll(block.number + WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(CampaignEscrow.ClaimNotVerified.selector, claimId));
        escrow.autoSettle(claimId);
        assertEq(escrow.getCampaign(CAMPAIGN).recognizedTotal, 0);
        assertFalse(escrow.payoutRecognized(claimId));
    }
}
