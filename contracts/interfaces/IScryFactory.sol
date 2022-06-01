// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

/// @author Scry Finance Team
/// @title IScryFactory
/// @notice Interface for interacting with the ScryFactory Contract
interface IScryFactory {

    /**
     * @dev gets the current scry router
     *
     * @return the current scry router
    */
    function getScryRouter() external returns (address payable);
}
