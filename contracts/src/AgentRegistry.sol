// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

enum Role {
    NONE,
    ADVERTISER,
    PUBLISHER,
    VERIFIER
}

/// @notice Minimal role registry for the demo actors. Registration is
/// deployer-gated; the other contracts authorize role-gated calls against it.
contract AgentRegistry {
    address public immutable admin;

    mapping(address agent => Role) private _roles;

    event AgentRegistered(address indexed agent, Role role);

    error NotAdmin();
    error ZeroAddress();
    error InvalidRole();
    error AlreadyRegistered(address agent);

    constructor() {
        admin = msg.sender;
    }

    function register(address agent, Role role) external {
        if (msg.sender != admin) revert NotAdmin();
        if (agent == address(0)) revert ZeroAddress();
        if (role == Role.NONE) revert InvalidRole();
        if (_roles[agent] != Role.NONE) revert AlreadyRegistered(agent);
        _roles[agent] = role;
        emit AgentRegistered(agent, role);
    }

    function roleOf(address agent) external view returns (Role) {
        return _roles[agent];
    }
}
