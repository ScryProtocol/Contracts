// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./interfaces/IX402StateChannel.sol";
import "./interfaces/IERC20.sol";

contract X402StateChannel is IX402StateChannel {
    // --- EIP-712 domain separator (C3) ---
    bytes32 public DOMAIN_SEPARATOR;
    bytes32 public constant STATE_TYPEHASH = keccak256(
        "ChannelState(bytes32 channelId,uint64 stateNonce,uint256 balA,uint256 balB,bytes32 locksRoot,uint64 stateExpiry,bytes32 contextHash)"
    );

    struct Channel {
        address participantA;
        address participantB;
        address asset;
        uint64 challengePeriodSec;
        uint64 channelExpiry;
        uint256 totalBalance;
        bool isClosing;
        uint64 closeDeadline;
        uint64 latestNonce;
        uint256 closeBalA;
        uint256 closeBalB;
        uint8 hubFlags; // 0=none, 1=A is hub, 2=B is hub, 3=both
        // Funded balance tracking — cumulative funds attributed to each side
        // from openChannel, deposit, and rebalance.  Separate from close
        // dispute state (closeBalA/closeBalB) which comes from signed states.
        uint256 fundedBalA;
        uint256 fundedBalB;
    }

    mapping(bytes32 => Channel) private _channels;
    mapping(bytes32 => bool) private _usedChannelIds;
    bytes32[] private _channelIds;
    mapping(address => bytes32[]) private _channelsByParticipant;
    mapping(bytes32 => uint256) private _channelIndexPlusOne;
    mapping(address => mapping(bytes32 => uint256)) private _channelsByParticipantIndexPlusOne;
    mapping(address => uint256) private _pendingEthPayout;
    mapping(address => mapping(address => uint256)) private _pendingErc20Payout;

    event PayoutDeferred(address indexed asset, address indexed to, uint256 amount);
    event PayoutWithdrawn(address indexed asset, address indexed to, uint256 amount);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("X402StateChannel")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    function openChannel(
        address participantB,
        address asset,
        uint256 amount,
        uint64 challengePeriodSec,
        uint64 channelExpiry,
        bytes32 salt,
        uint8 hubFlags
    ) external payable override returns (bytes32 channelId) {
        require(participantB != address(0), "SCP: bad participantB");
        require(challengePeriodSec > 0, "SCP: bad challenge");
        require(channelExpiry > block.timestamp, "SCP: bad expiry");
        require(amount > 0, "SCP: zero amount"); // H11
        require(hubFlags <= 3, "SCP: bad hubFlags");

        channelId = keccak256(
            abi.encode(block.chainid, address(this), msg.sender, participantB, asset, salt)
        );
        require(_channels[channelId].participantA == address(0), "SCP: exists");
        require(!_usedChannelIds[channelId], "SCP: id used");

        _channels[channelId] = Channel({
            participantA: msg.sender,
            participantB: participantB,
            asset: asset,
            challengePeriodSec: challengePeriodSec,
            channelExpiry: channelExpiry,
            totalBalance: 0,
            isClosing: false,
            closeDeadline: 0,
            latestNonce: 0,
            closeBalA: 0,
            closeBalB: 0,
            hubFlags: hubFlags,
            fundedBalA: 0,
            fundedBalB: 0
        });
        _usedChannelIds[channelId] = true;

        _channelIds.push(channelId);
        _channelIndexPlusOne[channelId] = _channelIds.length;
        _channelsByParticipant[msg.sender].push(channelId);
        _channelsByParticipantIndexPlusOne[msg.sender][channelId] = _channelsByParticipant[msg.sender].length;
        if (participantB != msg.sender) {
            _channelsByParticipant[participantB].push(channelId);
            _channelsByParticipantIndexPlusOne[participantB][channelId] = _channelsByParticipant[participantB].length;
        }

        _collectAsset(asset, msg.sender, amount);
        _channels[channelId].totalBalance = amount;
        _channels[channelId].fundedBalA = amount; // opener (A) funds everything

        emit ChannelOpened(
            channelId,
            msg.sender,
            participantB,
            asset,
            challengePeriodSec,
            channelExpiry
        );
    }

    function deposit(bytes32 channelId, uint256 amount) external payable override {
        Channel storage ch = _channels[channelId];
        require(ch.participantA != address(0), "SCP: not found");
        require(!ch.isClosing, "SCP: closing");
        require(block.timestamp < ch.channelExpiry, "SCP: expired");
        require(
            msg.sender == ch.participantA || msg.sender == ch.participantB,
            "SCP: not participant"
        );
        require(amount > 0, "SCP: zero amount");

        _collectAsset(ch.asset, msg.sender, amount);
        // C2: Solidity 0.8.x has built-in overflow protection
        ch.totalBalance = ch.totalBalance + amount;
        if (msg.sender == ch.participantA) {
            ch.fundedBalA = ch.fundedBalA + amount;
        } else {
            ch.fundedBalB = ch.fundedBalB + amount;
        }

        emit Deposited(channelId, msg.sender, amount, ch.totalBalance);
    }

    function cooperativeClose(
        ChannelState calldata st,
        bytes calldata sigA,
        bytes calldata sigB
    ) external override {
        Channel storage ch = _channels[st.channelId];
        require(ch.participantA != address(0), "SCP: not found");
        require(!ch.isClosing, "SCP: already closing"); // H7: block during dispute
        require(!_isStateExpired(st), "SCP: state expired");
        _validateState(ch, st, false);

        bytes32 digest = _hashTypedData(st);
        require(_recover(digest, sigA) == ch.participantA, "SCP: bad sigA");
        require(_recover(digest, sigB) == ch.participantB, "SCP: bad sigB");

        _finalizeWithState(ch, st);
        emit ChannelClosed(st.channelId, st.stateNonce, st.balA, st.balB);
    }

    function startClose(
        ChannelState calldata st,
        bytes calldata sigFromCounterparty
    ) external override {
        Channel storage ch = _channels[st.channelId];
        require(ch.participantA != address(0), "SCP: not found");
        require(!ch.isClosing, "SCP: already closing");
        require(!_isStateExpired(st), "SCP: state expired");
        require(
            msg.sender == ch.participantA || msg.sender == ch.participantB,
            "SCP: not participant"
        );
        _validateState(ch, st, true);

        bytes32 digest = _hashTypedData(st);
        if (msg.sender == ch.participantA) {
            require(
                _recover(digest, sigFromCounterparty) == ch.participantB,
                "SCP: bad counter sig"
            );
        } else {
            require(
                _recover(digest, sigFromCounterparty) == ch.participantA,
                "SCP: bad counter sig"
            );
        }

        ch.isClosing = true;
        ch.closeDeadline = uint64(block.timestamp + ch.challengePeriodSec);
        ch.latestNonce = st.stateNonce;
        ch.closeBalA = st.balA;
        ch.closeBalB = st.balB;

        emit CloseStarted(st.channelId, st.stateNonce, ch.closeDeadline, hashState(st));
    }

    function challenge(
        ChannelState calldata newer,
        bytes calldata sigFromCounterparty
    ) external override {
        Channel storage ch = _channels[newer.channelId];
        require(ch.participantA != address(0), "SCP: not found");
        require(ch.isClosing, "SCP: not closing");
        require(block.timestamp <= ch.closeDeadline, "SCP: deadline passed");
        require(!_isStateExpired(newer), "SCP: state expired");
        require(
            msg.sender == ch.participantA || msg.sender == ch.participantB,
            "SCP: not participant"
        );
        require(newer.stateNonce > ch.latestNonce, "SCP: stale nonce");
        _validateState(ch, newer, false);

        bytes32 digest = _hashTypedData(newer);
        if (msg.sender == ch.participantA) {
            require(
                _recover(digest, sigFromCounterparty) == ch.participantB,
                "SCP: bad counter sig"
            );
        } else {
            require(
                _recover(digest, sigFromCounterparty) == ch.participantA,
                "SCP: bad counter sig"
            );
        }

        ch.latestNonce = newer.stateNonce;
        ch.closeBalA = newer.balA;
        ch.closeBalB = newer.balB;

        emit Challenged(newer.channelId, newer.stateNonce, hashState(newer));
    }

    function rebalance(
        ChannelState calldata state,
        bytes32 toChannelId,
        uint256 amount,
        bytes calldata sigCounterparty
    ) external override {
        Channel storage from = _channels[state.channelId];
        Channel storage to = _channels[toChannelId];
        require(from.participantA != address(0), "SCP: from not found");
        require(to.participantA != address(0), "SCP: to not found");
        require(!from.isClosing, "SCP: from closing");
        require(!to.isClosing, "SCP: to closing");
        require(block.timestamp < to.channelExpiry, "SCP: to expired");
        require(from.asset == to.asset, "SCP: asset mismatch");

        // Caller must be hub in from-channel and participant in to-channel
        require(_isHub(from, msg.sender), "SCP: not hub in from");
        require(
            msg.sender == to.participantA || msg.sender == to.participantB,
            "SCP: not to participant"
        );

        // Validate the state
        require(state.stateNonce > from.latestNonce, "SCP: stale nonce");
        require(!_isStateExpired(state), "SCP: state expired");
        require(state.balA + state.balB == from.totalBalance, "SCP: bad balances");

        // Verify counterparty signed this state
        bytes32 digest = _hashTypedData(state);
        if (msg.sender == from.participantA) {
            require(_recover(digest, sigCounterparty) == from.participantB, "SCP: bad counter sig");
        } else {
            require(_recover(digest, sigCounterparty) == from.participantA, "SCP: bad counter sig");
        }

        // Amount must come from hub's side of the balance
        require(amount > 0, "SCP: zero rebalance");
        uint256 hubBal = (msg.sender == from.participantA) ? state.balA : state.balB;
        require(amount <= hubBal, "SCP: amount exceeds hub balance");

        // Apply: shrink from, grow to
        from.totalBalance = from.totalBalance - amount;
        from.latestNonce = state.stateNonce;
        // Record the post-rebalance balance split from the signed state.
        // We set BOTH fundedBal fields (not just the hub's side) because the
        // signed state is the authoritative balance split, and we need
        // fundedBalA + fundedBalB == new totalBalance.
        //
        // The old code did a saturating subtraction on only the hub's
        // fundedBal, which breaks when the hub earned funds off-chain:
        // fundedBal tracks deposits, not earnings, so subtracting earned
        // amounts underflows to 0 and the invariant breaks.
        if (msg.sender == from.participantA) {
            from.closeBalA = state.balA - amount;
            from.closeBalB = state.balB;
            from.fundedBalA = state.balA - amount;
            from.fundedBalB = state.balB;
        } else {
            from.closeBalA = state.balA;
            from.closeBalB = state.balB - amount;
            from.fundedBalA = state.balA;
            from.fundedBalB = state.balB - amount;
        }

        to.totalBalance = to.totalBalance + amount;
        // C-1 fix: track which side of the destination channel receives
        // the rebalanced funds.  Uses fundedBal (not closeBal, which
        // belongs to the dispute flow).
        if (msg.sender == to.participantA) {
            to.fundedBalA = to.fundedBalA + amount;
        } else {
            to.fundedBalB = to.fundedBalB + amount;
        }

        emit Rebalanced(
            state.channelId,
            toChannelId,
            amount,
            from.totalBalance,
            to.totalBalance
        );
        emit Deposited(toChannelId, msg.sender, amount, to.totalBalance);
    }

    function finalizeClose(bytes32 channelId) external override {
        Channel storage ch = _channels[channelId];
        require(ch.participantA != address(0), "SCP: not found");
        require(ch.isClosing, "SCP: not closing");
        require(block.timestamp > ch.closeDeadline, "SCP: challenge open");

        uint64 finalNonce = ch.latestNonce;
        uint256 payoutA = ch.closeBalA;
        uint256 payoutB = ch.closeBalB;

        address asset = ch.asset;
        address participantA = ch.participantA;
        address participantB = ch.participantB;

        _removeActiveChannel(channelId, participantA, participantB);
        delete _channels[channelId];

        _payoutAsset(asset, participantA, payoutA);
        _payoutAsset(asset, participantB, payoutB);

        emit ChannelClosed(channelId, finalNonce, payoutA, payoutB);
    }

    // --- Views ---

    function getChannel(bytes32 channelId)
        external
        view
        override
        returns (ChannelParams memory params)
    {
        Channel storage ch = _channels[channelId];
        params = ChannelParams({
            participantA: ch.participantA,
            participantB: ch.participantB,
            asset: ch.asset,
            challengePeriodSec: ch.challengePeriodSec,
            channelExpiry: ch.channelExpiry,
            totalBalance: ch.totalBalance,
            isClosing: ch.isClosing,
            closeDeadline: ch.closeDeadline,
            latestNonce: ch.latestNonce,
            hubFlags: ch.hubFlags
        });
    }

    function getChannelCount() external view override returns (uint256) {
        return _channelIds.length;
    }

    function getChannelIds(uint256 offset, uint256 limit)
        external
        view
        override
        returns (bytes32[] memory ids)
    {
        uint256 len = _channelIds.length;
        if (offset >= len) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > len) end = len;
        ids = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = _channelIds[i];
        }
    }

    function getChannelsByParticipant(address participant)
        external
        view
        override
        returns (bytes32[] memory)
    {
        return _channelsByParticipant[participant];
    }

    function balance(bytes32 channelId)
        external
        view
        override
        returns (ChannelBalance memory bal)
    {
        Channel storage ch = _channels[channelId];
        bal.totalBalance = ch.totalBalance;
        bal.latestNonce = ch.latestNonce;
        bal.isClosing = ch.isClosing;
        if (ch.isClosing) {
            // Dispute payout state — from signed states via startClose/challenge
            bal.balA = ch.closeBalA;
            bal.balB = ch.closeBalB;
        } else {
            // Live channel — funded balance tracking (open + deposit + rebalance)
            bal.balA = ch.fundedBalA;
            bal.balB = ch.fundedBalB;
        }
    }

    function pendingPayout(address asset, address account) external view returns (uint256) {
        if (asset == address(0)) {
            return _pendingEthPayout[account];
        }
        return _pendingErc20Payout[asset][account];
    }

    function withdrawPayout(address asset) external {
        uint256 amount;
        if (asset == address(0)) {
            amount = _pendingEthPayout[msg.sender];
            require(amount > 0, "SCP: no payout");
            _pendingEthPayout[msg.sender] = 0;
            (bool ok, ) = msg.sender.call{value: amount}("");
            require(ok, "SCP: eth withdraw");
        } else {
            amount = _pendingErc20Payout[asset][msg.sender];
            require(amount > 0, "SCP: no payout");
            _pendingErc20Payout[asset][msg.sender] = 0;
            require(_safeTransfer(asset, msg.sender, amount), "SCP: erc20 withdraw");
        }
        emit PayoutWithdrawn(asset, msg.sender, amount);
    }

    // C3: EIP-712 typed data hash
    function hashState(ChannelState calldata st) public view override returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01",
            DOMAIN_SEPARATOR,
            keccak256(abi.encode(
                STATE_TYPEHASH,
                st.channelId,
                st.stateNonce,
                st.balA,
                st.balB,
                st.locksRoot,
                st.stateExpiry,
                st.contextHash
            ))
        ));
    }

    // --- Internals ---

    function _isHub(Channel storage ch, address addr) internal view returns (bool) {
        if ((ch.hubFlags & 1) != 0 && addr == ch.participantA) return true;
        if ((ch.hubFlags & 2) != 0 && addr == ch.participantB) return true;
        return false;
    }

    function _hashTypedData(ChannelState calldata st) internal view returns (bytes32) {
        return hashState(st);
    }

    function _validateState(
        Channel storage ch,
        ChannelState calldata st,
        bool allowSameNonce
    ) internal view {
        require(st.balA + st.balB == ch.totalBalance, "SCP: bad balances");
        if (allowSameNonce) {
            require(st.stateNonce >= ch.latestNonce, "SCP: stale nonce");
        } else {
            require(st.stateNonce > ch.latestNonce, "SCP: stale nonce");
        }
    }

    function _isStateExpired(ChannelState calldata st) internal view returns (bool) {
        if (st.stateExpiry == 0) {
            return false;
        }
        return block.timestamp > st.stateExpiry;
    }

    // Inline ECDSA recovery — replaces OpenZeppelin dependency
    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "SCP: bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        // EIP-2: reject s in upper half to prevent malleability
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "SCP: sig malleability");
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "SCP: bad v");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "SCP: zero signer");
        return signer;
    }

    function _collectAsset(
        address asset,
        address from,
        uint256 amount
    ) internal {
        if (asset == address(0)) {
            require(msg.value == amount, "SCP: bad msg.value");
        } else {
            require(msg.value == 0, "SCP: no eth");
            require(_safeTransferFrom(asset, from, address(this), amount), "SCP: transferFrom");
        }
    }

    function _payoutAsset(
        address asset,
        address to,
        uint256 amount
    ) internal {
        if (amount == 0) {
            return;
        }

        if (asset == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) {
                _pendingEthPayout[to] = _pendingEthPayout[to] + amount;
                emit PayoutDeferred(asset, to, amount);
            }
        } else {
            if (!_safeTransfer(asset, to, amount)) {
                _pendingErc20Payout[asset][to] = _pendingErc20Payout[asset][to] + amount;
                emit PayoutDeferred(asset, to, amount);
            }
        }
    }

    function _finalizeWithState(Channel storage ch, ChannelState calldata st) internal {
        address asset = ch.asset;
        address participantA = ch.participantA;
        address participantB = ch.participantB;

        _removeActiveChannel(st.channelId, participantA, participantB);
        delete _channels[st.channelId];

        _payoutAsset(asset, participantA, st.balA);
        _payoutAsset(asset, participantB, st.balB);
    }

    function _safeTransfer(address asset, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = asset.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _safeTransferFrom(
        address asset,
        address from,
        address to,
        uint256 amount
    ) internal returns (bool) {
        (bool ok, bytes memory data) = asset.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _removeActiveChannel(
        bytes32 channelId,
        address participantA,
        address participantB
    ) internal {
        _removeGlobalChannelId(channelId);
        _removeParticipantChannel(participantA, channelId);
        if (participantB != participantA) {
            _removeParticipantChannel(participantB, channelId);
        }
    }

    function _removeGlobalChannelId(bytes32 channelId) internal {
        uint256 idxPlusOne = _channelIndexPlusOne[channelId];
        if (idxPlusOne == 0) return;
        uint256 idx = idxPlusOne - 1;
        uint256 last = _channelIds.length - 1;
        if (idx != last) {
            bytes32 moved = _channelIds[last];
            _channelIds[idx] = moved;
            _channelIndexPlusOne[moved] = idx + 1;
        }
        _channelIds.pop();
        delete _channelIndexPlusOne[channelId];
    }

    function _removeParticipantChannel(address participant, bytes32 channelId) internal {
        uint256 idxPlusOne = _channelsByParticipantIndexPlusOne[participant][channelId];
        if (idxPlusOne == 0) return;
        bytes32[] storage ids = _channelsByParticipant[participant];
        uint256 idx = idxPlusOne - 1;
        uint256 last = ids.length - 1;
        if (idx != last) {
            bytes32 moved = ids[last];
            ids[idx] = moved;
            _channelsByParticipantIndexPlusOne[participant][moved] = idx + 1;
        }
        ids.pop();
        delete _channelsByParticipantIndexPlusOne[participant][channelId];
    }
}
