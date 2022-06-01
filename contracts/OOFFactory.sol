// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;
pragma abicoder v2;

import "./lib/CloneLibrary.sol";

/// @author Scry Finance Team
/// @title ScryFactory
contract OOFFactory {
    using CloneLibrary for address;

    event NewOOF(address oof);
    event FactoryOwnerChanged(address newowner);
    event NewScryRouter(address newScryRouter);
    event NewOOFImplementation(address newOOFImplementation);

    address payable public factoryOwner;
    address public oofImplementation;
    address payable public ScryRouter;

    constructor(
        address _oofImplementation,
        address payable _ScryRouter
    )
    {
        require(_oofImplementation != address(0), "No zero address for _oofImplementation");
        require(_ScryRouter != address(0), "No zero address for ScryRouter");

        factoryOwner = msg.sender;
        oofImplementation = _oofImplementation;
        ScryRouter = _ScryRouter;

        emit FactoryOwnerChanged(factoryOwner);
        emit NewOOFImplementation(oofImplementation);
        emit NewScryRouter(ScryRouter);
    }

    function oofMint(
        address[] memory signers_,
        uint256 signerThreshold_,
        address payable payoutAddress_,
        uint256 subscriptionPassPrice_
    )
    external
    returns(address oof)
    {
        oof = oofImplementation.createClone();

        emit NewOOF(oof);

        IOOF(oof).initialize(
            signers_,
            signerThreshold_,
            payoutAddress_,
            subscriptionPassPrice_,
            address(this)
        );
    }

    /**
     * @dev gets the address of the current factory owner
     *
     * @return the address of the Scry router
    */
    function getScryRouter() external view returns (address payable) {
        return ScryRouter;
    }

    /**
     * @dev lets the owner change the current Scry implementation
     *
     * @param oofImplementation_ the address of the new implementation
    */
    function newOOFImplementation(address oofImplementation_) external {
        require(msg.sender == factoryOwner, "Only factory owner");
        require(oofImplementation_ != address(0), "No zero address for oofImplementation_");

        oofImplementation = oofImplementation_;
        emit NewOOFImplementation(oofImplementation);
    }

    /**
     * @dev lets the owner change the current Scry router
     *
     * @param ScryRouter_ the address of the new router
    */
    function newScryRouter(address payable ScryRouter_) external {
        require(msg.sender == factoryOwner, "Only factory owner");
        require(ScryRouter_ != address(0), "No zero address for ScryRouter_");

        ScryRouter = ScryRouter_;
        emit NewScryRouter(ScryRouter);
    }

    /**
     * @dev lets the owner change the ownership to another address
     *
     * @param newOwner the address of the new owner
    */
    function newFactoryOwner(address payable newOwner) external {
        require(msg.sender == factoryOwner, "Only factory owner");
        require(newOwner != address(0), "No zero address for newOwner");

        factoryOwner = newOwner;
        emit FactoryOwnerChanged(factoryOwner);
    }

    /**
     * receive function to receive funds
    */
    receive() external payable {}
}

interface IOOF {
    function initialize(
        address[] memory signers_,
        uint256 signerThreshold_,
        address payable payoutAddress_,
        uint256 subscriptionPassPrice_,
        address factoryContract_
    ) external;
}

