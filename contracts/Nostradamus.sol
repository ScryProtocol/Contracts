// SPDX-License-Identifier: SCRY
pragma solidity 0.7.6;
pragma abicoder v2;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

contract Nostradamus {
    // using Openzeppelin contracts for SafeMath and Address
    using SafeMath for uint256;
    using Address for address;

    // the address of the collateral contract factory
    address public factoryContract;

    // address used for pay out
    address payable public payoutAddress;

    // number of signers
    uint256 public signerLength;

    // addresses of the signers
    address[] public signers;

    // threshold which has to be reached
    uint256 public signerThreshold = 1;

    // indicates if sender is a signer
    mapping(address => bool) private isSigner;

    // indicates support of feeds
    mapping(uint256 => uint256) public feedSupport;


    struct oracleStruct {
        string feedAPIendpoint;
        string feedAPIendpointPath;
        uint256 latestPrice;
        uint256 latestPriceUpdate;
        uint256 feedDecimals;
        string feedString;
    }

    oracleStruct[] private feedList;

    // indicates if oracle subscription is turned on. 0 indicates no pass
    uint256 public subscriptionPassPrice;

    mapping(address => uint256) private hasPass;

    struct proposalStruct {
        uint256 uintValue;
        address addressValue;
        address proposer;
        // 0 ... pricePass
        // 1 ... threshold
        // 2 ... add signer
        // 3 ... remove signer
        // 4 ... payoutAddress
        // 5 ...
        // 6 ...
        uint256 proposalType;
        uint256 proposalFeedId;
        uint256 proposalActive;
    }

    proposalStruct[] public proposalList;

    mapping(uint256 => mapping(address => bool)) private hasSignedProposal;

    event contractSetup(
        address[] signers,
        uint256 signerThreshold,
        address payout
    );
    event feedRequested(
        string endpoint,
        string endpointp,
        uint256,
        uint256,
        uint256 feedId
    );
    event feedSigned(
        uint256 feedId,
        uint256 value,
        uint256 timestamp,
        address signer
    );
    event feedSubmitted(uint256 feedId, uint256 value, uint256 timestamp,string);
    event routerFeeTaken(uint256 value, address sender);
    event feedSupported(uint256 feedId, uint256 supportvalue);
    event newProposal(
        uint256 proposalId,
        uint256 uintValue,
        address addressValue,
        uint256 oracleType,
        address proposer
    );
    event proposalSigned(uint256 proposalId, address signer);
    event newThreshold(uint256 value);
    event newSigner(address signer);
    event signerRemoved(address signer);
    event newPayoutAddress(address payout);
    event subscriptionPassPriceUpdated(uint256 newPass);

    // only Signer modifier
    modifier onlySigner() {
        _onlySigner();
        _;
    }

    // only Signer view
    function _onlySigner() private view {
        require(isSigner[msg.sender], "Only a signer can perform this action");
    }

    constructor() {}

    function initialize(
        address[] memory signers_,
        uint256 signerThreshold_,
        address payable payoutAddress_,
        uint256 subscriptionPassPrice_,
        address factoryContract_
    ) external {
        require(factoryContract == address(0), "already initialized");
        require(factoryContract_ != address(0), "factory can not be null");
        require(signerThreshold_ != 0, "Threshold cant be 0");
        require(
            signerThreshold_ <= signers_.length,
            "Threshold cant be more then signer count"
        );

        factoryContract = factoryContract_;
        signerThreshold = signerThreshold_;
        signers = signers_;

        for (uint256 i = 0; i < signers.length; i++) {
            require(signers[i] != address(0), "Not zero address");
            isSigner[signers[i]] = true;
        }

        signerLength = signers_.length;
        payoutAddress = payoutAddress_;
        subscriptionPassPrice = subscriptionPassPrice_;
        emit contractSetup(signers_, signerThreshold, payoutAddress);
    }

    //---------------------------helper functions---------------------------

    //---------------------------view functions ---------------------------

    /**
     * @dev getFeeds function lets anyone call the oracle to receive data (maybe pay an optional fee)
     *
     * @param feedIDs the array of feedIds
     */
    function getFeeds(
        uint256[] memory feedIDs
    )
        external
        view
        returns (
            uint256[] memory,
            uint256[] memory,
            uint256[] memory,
            string[] memory,
            string[] memory,
            string[] memory
        )
    {
        uint256 feedLen = feedIDs.length;
        uint256[] memory returnPrices = new uint256[](feedLen);
        uint256[] memory returnTimestamps = new uint256[](feedLen);
        uint256[] memory returnDecimals = new uint256[](feedLen);
        string[] memory returnEndpoint = new string[](feedLen);
        string[] memory returnPath = new string[](feedLen);
        string[] memory returnStr = new string[](feedLen);
        for (uint256 i = 0; i < feedIDs.length; i++) {
            (returnPrices[i], returnTimestamps[i], returnDecimals[i],) = getFeed(
                feedIDs[i]
            );
            returnEndpoint[i] = feedList[feedIDs[i]].feedAPIendpoint;
            returnPath[i] = feedList[feedIDs[i]].feedAPIendpointPath;
            returnStr[i] = feedList[feedIDs[i]].feedString;
        }

        return (
            returnPrices,
            returnTimestamps,
            returnDecimals,
            returnEndpoint,
            returnPath,returnStr
        );
    }

    /**
     * @dev getFeed function lets anyone call the oracle to receive data (maybe pay an optional fee)
     *
     * @param feedID the array of feedId
     */
    function getFeed(
        uint256 feedID
    ) public view returns (uint256, uint256, uint256,string memory){//m) {
        uint256 returnPrice;
        uint256 returnTimestamp;
        uint256 returnDecimals;

        returnPrice = feedList[feedID].latestPrice;
        returnTimestamp = feedList[feedID].latestPriceUpdate;
        returnDecimals = feedList[feedID].feedDecimals;
        
        return (returnPrice, returnTimestamp, returnDecimals, feedList[feedID].feedString);
    }

    function getFeedLength() external view returns (uint256) {
        return feedList.length;
    }

    //---------------------------oracle management functions ---------------------------

    // function to withdraw funds
    function withdrawFunds() external {
        if (payoutAddress == address(0)) {
            payable(factoryContract).transfer(address(this).balance / 100);
            payable(signers[0]).transfer(address(this).balance);
        } else {
            payable(factoryContract).transfer(address(this).balance / 100);
            payoutAddress.transfer(address(this).balance);
        }
    }

    function requestFeeds(
        string[] memory APIendpoint,
        string[] memory APIendpointPath,
        uint256[] memory decimals,
        uint256[] memory bounties
    ) external payable returns (uint256[] memory feeds) {
        require(
            APIendpoint.length == APIendpointPath.length,
            "Length mismatch"
        );
        uint256 total;
        uint256[] memory fds = new uint256[](APIendpointPath.length);
        for (uint256 i = 0; i < APIendpoint.length; i++) {
            feedList.push(
                oracleStruct({
                    feedAPIendpoint: APIendpoint[i],
                    feedAPIendpointPath: APIendpointPath[i],
                    latestPrice: 0,
                    latestPriceUpdate: 0,
                    feedDecimals: decimals[i],
                    feedString:''
                })
            );
            total += bounties[i];
            feedSupport[feedList.length - 1] = feedSupport[feedList.length - 1]
                .add(bounties[i]);
            fds[i] = feedList.length - 1;
            if (hasPass[msg.sender] >= block.timestamp) {
                total = 0;
            }
            require(total <= msg.value);
            emit feedRequested(
                APIendpoint[i],
                APIendpointPath[i],
                bounties[i],
                decimals[i],
                feedList.length - 1
            );
        }
        return (fds);
    }

    /**
     * @dev submitFeed function lets a signer submit as many feeds as they want to
     *
     * @param values the array of values
     * @param feedIDs the array of feedIds
     */
    function submitFeed(
        uint256[] memory feedIDs,
        uint256[] memory values,
        string[] memory vals
    ) external onlySigner {
        require(
            values.length == feedIDs.length,
            "Value length and feedID length do not match"
        );
        // process feeds
        for (uint256 i = 0; i < values.length; i++) {
            emit feedSigned(feedIDs[i], values[i], block.timestamp, msg.sender);
            feedList[feedIDs[i]].latestPriceUpdate = block.timestamp;
            feedList[feedIDs[i]].latestPrice = values[i];
            feedList[feedIDs[i]].feedString = vals[i];
            emit feedSubmitted(feedIDs[i], values[i], block.timestamp,vals[i]);
            feedSupport[feedIDs[i]] = 0;
        }
        payable(factoryContract).transfer(address(this).balance / 100);
        msg.sender.transfer(address(this).balance);
    }

    function signProposal(uint256 proposalId) external onlySigner {
        require(
            proposalList[proposalId].proposalActive != 0,
            "Proposal not active"
        );

        hasSignedProposal[proposalId][msg.sender] = true;
        emit proposalSigned(proposalId, msg.sender);

        uint256 signedProposalLen;

        for (uint256 i = 0; i < signers.length; i++) {
            if (hasSignedProposal[proposalId][signers[i]]) {
                signedProposalLen++;
            }
        }

        // execute proposal
        if (signedProposalLen >= signerThreshold) {
            if (proposalList[proposalId].proposalType == 0) {
                updatePricePass(proposalList[proposalId].uintValue);
            } else if (proposalList[proposalId].proposalType == 1) {
                //  updateThreshold(proposalList[proposalId].uintValue);
            } else if (proposalList[proposalId].proposalType == 2) {
                addSigners(proposalList[proposalId].addressValue);
            } else if (proposalList[proposalId].proposalType == 3) {
                removeSigner(proposalList[proposalId].addressValue);
            } else if (proposalList[proposalId].proposalType == 4) {
                updatePayoutAddress(proposalList[proposalId].addressValue);
            }

            // lock proposal
            proposalList[proposalId].proposalActive = 0;
        }
    }

    function createProposal(
        uint256 uintValue,
        address addressValue,
        uint256 proposalType,
        uint256 feedId
    ) external onlySigner {
        uint256 proposalArrayLen = proposalList.length;

        // fee or threshold
        if (proposalType == 0 || proposalType == 1 || proposalType == 7) {
            proposalList.push(
                proposalStruct({
                    uintValue: uintValue,
                    addressValue: address(0),
                    proposer: msg.sender,
                    proposalType: proposalType,
                    proposalFeedId: 0,
                    proposalActive: 1
                })
            );
        } else if (proposalType == 5 || proposalType == 6) {
            proposalList.push(
                proposalStruct({
                    uintValue: uintValue,
                    addressValue: address(0),
                    proposer: msg.sender,
                    proposalType: proposalType,
                    proposalFeedId: feedId,
                    proposalActive: 1
                })
            );
        } else {
            proposalList.push(
                proposalStruct({
                    uintValue: 0,
                    addressValue: addressValue,
                    proposer: msg.sender,
                    proposalType: proposalType,
                    proposalFeedId: 0,
                    proposalActive: 1
                })
            );
        }

        hasSignedProposal[proposalArrayLen][msg.sender] = true;

        emit newProposal(
            proposalArrayLen,
            uintValue,
            addressValue,
            proposalType,
            msg.sender
        );
        emit proposalSigned(proposalArrayLen, msg.sender);
    }

    function updatePricePass(uint256 newPricePass) private {
        subscriptionPassPrice = newPricePass;

        emit subscriptionPassPriceUpdated(newPricePass);
    }

    function updateThreshold(uint256 newThresholdValue) private {
        require(newThresholdValue != 0, "Threshold cant be 0");
        require(
            newThresholdValue <= signerLength,
            "Threshold cant be bigger then length of signers"
        );

        signerThreshold = newThresholdValue;
        emit newThreshold(newThresholdValue);
    }

    function addSigners(address newSignerValue) private {
        // check for duplicate signer
        for (uint256 i = 0; i < signers.length; i++) {
            if (signers[i] == newSignerValue) {
                revert("Signer already exists");
            }
        }

        signers.push(newSignerValue);
        signerLength++;
        isSigner[newSignerValue] = true;
        emit newSigner(newSignerValue);
    }

    function updatePayoutAddress(address newPayoutAddressValue) private {
        payoutAddress = payable(newPayoutAddressValue);
        emit newPayoutAddress(newPayoutAddressValue);
    }

    function removeSigner(address toRemove) internal {
        require(isSigner[toRemove], "Address to remove has to be a signer");
        require(
            signers.length - 1 >= signerThreshold,
            "Less signers than threshold"
        );

        for (uint256 i = 0; i < signers.length; i++) {
            if (signers[i] == toRemove) {
                delete signers[i];
                signerLength--;
                isSigner[toRemove] = false;
                emit signerRemoved(toRemove);
            }
        }
    }

    //---------------------------subscription functions---------------------------

    function buyPass(address buyer, uint256 duration) external payable {
        require(subscriptionPassPrice != 0, "Subscription Pass turned off");
        require(duration >= 3600, "Minimum subscription is 1h");
        require(
            msg.value >= (subscriptionPassPrice * duration) / 86400,
            "Not enough payment"
        );

        if (hasPass[buyer] <= block.timestamp) {
            hasPass[buyer] = block.timestamp.add(duration);
        } else {
            hasPass[buyer] = hasPass[buyer].add(duration);
        }
    }

    function supportFeeds(
        uint256[] memory feedIds,
        uint256[] memory values
    ) external payable {
        require(feedIds.length == values.length, "Length mismatch");
        uint256 total;
        for (uint256 i = 0; i < feedIds.length; i++) {
            feedSupport[feedIds[i]] = feedSupport[feedIds[i]].add(values[i]);
            total += values[i];
            emit feedSupported(feedIds[i], values[i]);
        }
        require(msg.value >= total, "Msg.value does not meet support values");
    }
}
