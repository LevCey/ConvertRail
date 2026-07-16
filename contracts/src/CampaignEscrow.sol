// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {AgentRegistry, Role} from "./AgentRegistry.sol";
import {ClaimStatus, ConversionRegistry, Claim} from "./ConversionRegistry.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

struct Campaign {
    address advertiser;
    address operationalWallet;
    uint96 pricePerConversion; // USDC, 6 decimals
    uint96 budget;
    uint96 recognizedTotal;
    uint96 reimbursedTotal;
    uint32 disputeWindowBlocks;
    bytes32 policyHash; // hash of the published verification policy config
}

struct PublisherAllocation {
    uint96 cap;
    uint96 recognized;
    bool enrolled;
}

/// @notice Holds the campaign budget commitment and rules. A claim the
/// verifier approved auto-settles after the dispute window unless the
/// advertiser objected — silence is acceptance, so the referee constrains
/// the advertiser too, not only publishers. Payouts recognized here are
/// reimbursed to the advertiser's operational wallet via trueUp(), which
/// reconciles the off-chain per-conversion payment stream against this
/// contract's accounting.
contract CampaignEscrow {
    AgentRegistry public immutable agents;
    ConversionRegistry public immutable registry;
    IERC20 public immutable usdc;

    mapping(bytes32 campaignId => Campaign) private _campaigns;
    mapping(bytes32 campaignId => mapping(address publisher => PublisherAllocation)) private _allocations;
    mapping(uint256 claimId => bool) public payoutRecognized;

    event CampaignCreated(
        bytes32 indexed campaignId,
        address indexed advertiser,
        address operationalWallet,
        uint96 pricePerConversion,
        uint96 budget,
        uint32 disputeWindowBlocks,
        bytes32 policyHash
    );
    event PublisherEnrolled(bytes32 indexed campaignId, address indexed publisher, uint96 cap, uint256 gasProvision);
    event PayoutRecognized(
        bytes32 indexed campaignId, uint256 indexed claimId, address indexed publisher, uint96 amount
    );
    event ClaimObjected(bytes32 indexed campaignId, uint256 indexed claimId, address indexed publisher);
    event BudgetReallocated(
        bytes32 indexed campaignId,
        address indexed fromPublisher,
        address indexed toPublisher,
        uint96 amount,
        bytes32 reasonCode,
        uint96 newFromCap,
        uint96 newToCap
    );
    event TruedUp(bytes32 indexed campaignId, address indexed operationalWallet, uint96 amount);

    error NotAdvertiser();
    error NotCampaignAdvertiser(bytes32 campaignId);
    error CampaignExists(bytes32 campaignId);
    error UnknownCampaign(bytes32 campaignId);
    error ZeroAddress();
    error ZeroPrice();
    error LengthMismatch();
    error NoPublishers();
    error PublisherNotEnrolled(bytes32 campaignId, address publisher);
    error PublisherRoleMissing(address publisher);
    error ClaimNotVerified(uint256 claimId);
    error DisputeWindowOpen(uint256 claimId, uint256 openUntilBlock);
    error DisputeWindowClosed(uint256 claimId, uint256 closedAtBlock);
    error AlreadyRecognized(uint256 claimId);
    error CapExceeded(bytes32 campaignId, address publisher, uint96 cap, uint96 attempted);
    error BudgetExceeded(bytes32 campaignId, uint96 budget, uint96 attempted);
    error InsufficientCapHeadroom(bytes32 campaignId, address publisher, uint96 headroom, uint96 requested);
    error TransferFailed();
    error GasProvisionFailed(address publisher);
    error NothingToReimburse(bytes32 campaignId);

    constructor(AgentRegistry agents_, ConversionRegistry registry_, IERC20 usdc_) {
        agents = agents_;
        registry = registry_;
        usdc = usdc_;
    }

    /// @notice Funds the escrow and publishes the campaign rules on-chain.
    /// msg.value (native USDC on Arc) is split across publishers as their
    /// gas provision — the advertiser funds the ecosystem it hires.
    function createCampaign(
        bytes32 campaignId,
        address operationalWallet,
        uint96 pricePerConversion,
        uint96 budget,
        uint32 disputeWindowBlocks,
        bytes32 policyHash,
        address[] calldata publishers,
        uint96[] calldata caps
    ) external payable {
        if (agents.roleOf(msg.sender) != Role.ADVERTISER) revert NotAdvertiser();
        if (_campaigns[campaignId].advertiser != address(0)) revert CampaignExists(campaignId);
        if (operationalWallet == address(0)) revert ZeroAddress();
        if (pricePerConversion == 0) revert ZeroPrice();
        if (publishers.length == 0) revert NoPublishers();
        if (publishers.length != caps.length) revert LengthMismatch();

        _campaigns[campaignId] = Campaign({
            advertiser: msg.sender,
            operationalWallet: operationalWallet,
            pricePerConversion: pricePerConversion,
            budget: budget,
            recognizedTotal: 0,
            reimbursedTotal: 0,
            disputeWindowBlocks: disputeWindowBlocks,
            policyHash: policyHash
        });
        emit CampaignCreated(
            campaignId, msg.sender, operationalWallet, pricePerConversion, budget, disputeWindowBlocks, policyHash
        );

        uint256 gasPerPublisher = msg.value / publishers.length;
        for (uint256 i = 0; i < publishers.length; i++) {
            address publisher = publishers[i];
            if (agents.roleOf(publisher) != Role.PUBLISHER) revert PublisherRoleMissing(publisher);
            _allocations[campaignId][publisher] = PublisherAllocation({cap: caps[i], recognized: 0, enrolled: true});
            if (gasPerPublisher > 0) {
                (bool ok,) = publisher.call{value: gasPerPublisher}("");
                if (!ok) revert GasProvisionFailed(publisher);
            }
            emit PublisherEnrolled(campaignId, publisher, caps[i], gasPerPublisher);
        }

        if (!usdc.transferFrom(msg.sender, address(this), budget)) revert TransferFailed();
    }

    /// @notice Advertiser objection within the dispute window. Blocks
    /// settlement of this claim only; the claim and its evidence stay
    /// on-chain permanently.
    function object(uint256 claimId) external {
        Claim memory claim = registry.getClaim(claimId);
        Campaign storage campaign = _requireCampaign(claim.campaignId);
        if (msg.sender != campaign.advertiser) revert NotCampaignAdvertiser(claim.campaignId);
        if (claim.status != ClaimStatus.VERIFIED) revert ClaimNotVerified(claimId);
        uint256 windowEnd = uint256(claim.verdictAtBlock) + campaign.disputeWindowBlocks;
        if (block.number > windowEnd) revert DisputeWindowClosed(claimId, windowEnd);

        registry.markDisputed(claimId);
        emit ClaimObjected(claim.campaignId, claimId, claim.publisher);
    }

    /// @notice Silence is acceptance: once the dispute window has passed
    /// with no objection, anyone may settle the claim. Recognition is where
    /// the cap and budget invariants are enforced.
    function autoSettle(uint256 claimId) external {
        Claim memory claim = registry.getClaim(claimId);
        Campaign storage campaign = _requireCampaign(claim.campaignId);
        if (claim.status != ClaimStatus.VERIFIED) revert ClaimNotVerified(claimId);
        uint256 windowEnd = uint256(claim.verdictAtBlock) + campaign.disputeWindowBlocks;
        if (block.number <= windowEnd) revert DisputeWindowOpen(claimId, windowEnd);
        if (payoutRecognized[claimId]) revert AlreadyRecognized(claimId);

        PublisherAllocation storage alloc = _allocations[claim.campaignId][claim.publisher];
        if (!alloc.enrolled) revert PublisherNotEnrolled(claim.campaignId, claim.publisher);

        uint96 price = campaign.pricePerConversion;
        uint96 newRecognized = alloc.recognized + price;
        if (newRecognized > alloc.cap) {
            revert CapExceeded(claim.campaignId, claim.publisher, alloc.cap, newRecognized);
        }
        uint96 newTotal = campaign.recognizedTotal + price;
        if (newTotal > campaign.budget) revert BudgetExceeded(claim.campaignId, campaign.budget, newTotal);

        alloc.recognized = newRecognized;
        campaign.recognizedTotal = newTotal;
        payoutRecognized[claimId] = true;

        registry.markSettled(claimId);
        emit PayoutRecognized(claim.campaignId, claimId, claim.publisher, price);
    }

    /// @notice Shifts unspent cap headroom between publishers. Only the
    /// campaign's advertiser (agent) may call; the reason code lands
    /// on-chain so the reallocation decision is auditable.
    function reallocate(bytes32 campaignId, address fromPublisher, address toPublisher, uint96 amount, bytes32 reasonCode)
        external
    {
        Campaign storage campaign = _requireCampaign(campaignId);
        if (msg.sender != campaign.advertiser) revert NotCampaignAdvertiser(campaignId);

        PublisherAllocation storage from = _allocations[campaignId][fromPublisher];
        PublisherAllocation storage to = _allocations[campaignId][toPublisher];
        if (!from.enrolled) revert PublisherNotEnrolled(campaignId, fromPublisher);
        if (!to.enrolled) revert PublisherNotEnrolled(campaignId, toPublisher);

        uint96 headroom = from.cap - from.recognized;
        if (amount > headroom) {
            revert InsufficientCapHeadroom(campaignId, fromPublisher, headroom, amount);
        }
        from.cap -= amount;
        to.cap += amount;

        emit BudgetReallocated(campaignId, fromPublisher, toPublisher, amount, reasonCode, from.cap, to.cap);
    }

    /// @notice Reimburses the operational wallet for recognized-but-not-yet-
    /// reimbursed payouts. This is the on-chain true-up of the off-chain
    /// per-conversion payment stream (D-locked settlement model).
    function trueUp(bytes32 campaignId) external returns (uint96 amount) {
        Campaign storage campaign = _requireCampaign(campaignId);
        amount = campaign.recognizedTotal - campaign.reimbursedTotal;
        if (amount == 0) revert NothingToReimburse(campaignId);
        campaign.reimbursedTotal = campaign.recognizedTotal;
        if (!usdc.transfer(campaign.operationalWallet, amount)) revert TransferFailed();
        emit TruedUp(campaignId, campaign.operationalWallet, amount);
    }

    function getCampaign(bytes32 campaignId) external view returns (Campaign memory) {
        Campaign memory campaign = _campaigns[campaignId];
        if (campaign.advertiser == address(0)) revert UnknownCampaign(campaignId);
        return campaign;
    }

    function getAllocation(bytes32 campaignId, address publisher)
        external
        view
        returns (PublisherAllocation memory)
    {
        return _allocations[campaignId][publisher];
    }

    function _requireCampaign(bytes32 campaignId) private view returns (Campaign storage campaign) {
        campaign = _campaigns[campaignId];
        if (campaign.advertiser == address(0)) revert UnknownCampaign(campaignId);
    }
}
