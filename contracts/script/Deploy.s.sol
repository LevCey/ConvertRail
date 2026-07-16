// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ConversionRegistry} from "../src/ConversionRegistry.sol";
import {CampaignEscrow, IERC20} from "../src/CampaignEscrow.sol";

/// Deploys the three contracts and wires the registry's settlement
/// authority to the escrow. USDC address comes from the environment.
contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");

        vm.startBroadcast();
        AgentRegistry agents = new AgentRegistry();
        ConversionRegistry registry = new ConversionRegistry(agents);
        CampaignEscrow escrow = new CampaignEscrow(agents, registry, IERC20(usdc));
        registry.setSettlementAuthority(address(escrow));
        vm.stopBroadcast();

        console.log("AGENT_REGISTRY_ADDRESS=%s", address(agents));
        console.log("CONVERSION_REGISTRY_ADDRESS=%s", address(registry));
        console.log("CAMPAIGN_ESCROW_ADDRESS=%s", address(escrow));
    }
}
