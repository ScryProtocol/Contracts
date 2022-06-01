// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

/// @author Scry Finance Team
/// @title IScryRouter
/// @notice Interface for interacting with the Router Contract
interface IScryRouter {

    /**
     * @dev calls the deposit function
    */
    function deposit() external payable;
}
