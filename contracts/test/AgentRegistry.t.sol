// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry, Role} from "../src/AgentRegistry.sol";

contract AgentRegistryTest is Test {
    AgentRegistry internal registry;

    address internal advertiser = makeAddr("advertiser");
    address internal publisher = makeAddr("publisher");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        registry = new AgentRegistry();
    }

    function test_registerAndLookup() public {
        registry.register(advertiser, Role.ADVERTISER);
        registry.register(publisher, Role.PUBLISHER);
        assertEq(uint8(registry.roleOf(advertiser)), uint8(Role.ADVERTISER));
        assertEq(uint8(registry.roleOf(publisher)), uint8(Role.PUBLISHER));
        assertEq(uint8(registry.roleOf(stranger)), uint8(Role.NONE));
    }

    function test_onlyAdminRegisters() public {
        vm.prank(stranger);
        vm.expectRevert(AgentRegistry.NotAdmin.selector);
        registry.register(advertiser, Role.ADVERTISER);
    }

    function test_rejectsZeroAddressAndNoneRole() public {
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.register(address(0), Role.PUBLISHER);
        vm.expectRevert(AgentRegistry.InvalidRole.selector);
        registry.register(advertiser, Role.NONE);
    }

    function test_rejectsDoubleRegistration() public {
        registry.register(advertiser, Role.ADVERTISER);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AlreadyRegistered.selector, advertiser));
        registry.register(advertiser, Role.PUBLISHER);
    }
}
