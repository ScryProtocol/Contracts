// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IX402StateChannel {
    struct ChannelState {
        bytes32 channelId;
        uint64 stateNonce;
        uint256 balA;
        uint256 balB;
        bytes32 locksRoot;
        uint64 stateExpiry;
        bytes32 contextHash;
    }

    struct ChannelParams {
        address participantA;
        address participantB;
        address asset;
        uint64 challengePeriodSec;
        uint64 channelExpiry;
        uint256 totalBalance;
        bool isClosing;
        uint64 closeDeadline;
        uint64 latestNonce;
        uint8 hubFlags; // 0=none, 1=A is hub, 2=B is hub, 3=both
    }

    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed participantA,
        address indexed participantB,
        address asset,
        uint64 challengePeriodSec,
        uint64 channelExpiry
    );

    event Deposited(
        bytes32 indexed channelId,
        address indexed sender,
        uint256 amount,
        uint256 newTotalBalance
    );

    event CloseStarted(
        bytes32 indexed channelId,
        uint64 indexed stateNonce,
        uint64 closeDeadline,
        bytes32 stateHash
    );

    event Challenged(
        bytes32 indexed channelId,
        uint64 indexed stateNonce,
        bytes32 stateHash
    );

    event ChannelClosed(
        bytes32 indexed channelId,
        uint64 indexed finalNonce,
        uint256 payoutA,
        uint256 payoutB
    );

    function openChannel(
        address participantB,
        address asset,
        uint256 amount,
        uint64 challengePeriodSec,
        uint64 channelExpiry,
        bytes32 salt,
        uint8 hubFlags
    ) external payable returns (bytes32 channelId);

    function deposit(bytes32 channelId, uint256 amount) external payable;

    function cooperativeClose(
        ChannelState calldata st,
        bytes calldata sigA,
        bytes calldata sigB
    ) external;

    function startClose(
        ChannelState calldata st,
        bytes calldata sigFromCounterparty
    ) external;

    function challenge(
        ChannelState calldata newer,
        bytes calldata sigFromCounterparty
    ) external;

    function finalizeClose(bytes32 channelId) external;

    event Rebalanced(
        bytes32 indexed fromChannelId,
        bytes32 indexed toChannelId,
        uint256 amount,
        uint256 fromNewTotal,
        uint256 toNewTotal
    );

    function rebalance(
        ChannelState calldata state,
        bytes32 toChannelId,
        uint256 amount,
        bytes calldata sigCounterparty
    ) external;

    function getChannel(bytes32 channelId)
        external
        view
        returns (ChannelParams memory params);

    function getChannelCount() external view returns (uint256);

    function getChannelIds(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory ids);

    function getChannelsByParticipant(address participant)
        external
        view
        returns (bytes32[] memory);

    function hashState(ChannelState calldata st) external view returns (bytes32);

    struct ChannelBalance {
        uint256 totalBalance;
        uint256 balA;
        uint256 balB;
        uint64 latestNonce;
        bool isClosing;
    }

    function balance(bytes32 channelId)
        external
        view
        returns (ChannelBalance memory bal);
}
