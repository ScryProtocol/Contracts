// SPDX-License-Identifier: SCRY
pragma solidity 0.8.6;

interface scryMetamorph {
    function requestCallback(
        uint _val,
        uint decimals,
        string memory _valStr,
        bytes memory _valBytes,
        uint timestamp,
        uint requestID
    ) external;
}

interface Morpheus {
    function requestFeeds(
        string[] calldata APIendpoint,
        string[] calldata APIendpointPath,
        uint256[] calldata decimals,
        uint256[] calldata bounties
    ) external payable returns (uint256[] memory feeds);

    function supportFeeds(
        uint256[] calldata feedIds,
        uint256[] calldata values
    ) external payable;

    function getFeed(
        uint256 feedIDs
    ) external view returns (uint256, uint256, uint256, string memory);
}

contract MetaMorph {
    event dataCallbackRequested(uint requestID, uint bounty);

    struct requeststruct {
        uint[] ids;
        address[] morpheus;
        address target;
        uint bounty;
        uint threshold;
        uint quorum;
        string endpoint;
        string path;
        uint decimals;
    }
    struct FeedData {
        uint256 price;
        uint256 timestamp;
        uint256 decimals;
        string str;
    }
    mapping(uint => requeststruct) public request;
    uint public requests;

    function getFeeds(
        address[] memory morpheus,
        uint256[] memory IDs,
        uint256 threshold
    )
        external
        view
        returns (
            uint256 value,
            uint256 decimals,
            string memory valStr,
            bytes memory valBytes,
            uint timestamp
        )
    {
        uint256 returnPrices;
        uint256 returnTimestamps;
        string memory returnStr;
        uint256[] memory total = new uint256[](morpheus.length);
        string[] memory strVal = new string[](morpheus.length);
        require(morpheus.length == IDs.length, "Mismatch oracles and IDs");
        uint q;
        for (uint256 i = 0; i < IDs.length; i++) {
            (returnPrices, returnTimestamps, decimals, returnStr) = Morpheus(
                morpheus[i]
            ).getFeed(IDs[i]);
            if (
                block.timestamp - threshold < returnTimestamps || threshold == 0
            ) {
                total[i] = returnPrices;
                strVal[i] = returnStr;
                timestamp += returnTimestamps;
                q++;
            }
        }
        uint256[] memory sorted = new uint256[](morpheus.length);
        sorted = sort(total);
        // uneven so we can take the middle
        if (sorted.length % 2 == 1) {
            uint sizer = (sorted.length + 1) / 2;
            value = sorted[sizer - 1];
            // take average of the 2 most inner numbers
        } else {
            uint size1 = (sorted.length) / 2;
            value = (sorted[size1 - 1] + sorted[size1]) / 2;
        }
        (valStr, ) = mostUsedString(strVal);
        valBytes = bytes(valStr);
        timestamp = timestamp / q;
    }

    function getFeed(
        address morpheus,
        uint256 IDs
    )
        external
        view
        returns (
            uint256 value,
            uint256 decimals,
            string memory valStr,
            bytes memory valBytes,
            uint timestamp
        )
    {
        (value, timestamp, decimals, valStr) = Morpheus(morpheus).getFeed(IDs);
        valBytes = bytes(valStr);
    }

    function getFeedsRaw(
        address[] memory morpheus,
        uint256[] memory IDs
    )
        external
        view
        returns (
            uint256[] memory value,
            uint256[] memory decimals,
            string[] memory valStr,
            bytes[] memory valBytes,
            uint256[] memory valTimestamps
        )
    {
        FeedData memory FeedInfo;
        uint256[] memory total = new uint256[](morpheus.length);
        uint256[] memory dec = new uint256[](morpheus.length);
        string[] memory strVal = new string[](morpheus.length);
        bytes[] memory bytesVal = new bytes[](morpheus.length);
        uint256[] memory tstamp = new uint256[](morpheus.length);
        for (uint256 i = 0; i < IDs.length; i++) {
            (
                FeedInfo.price,
                FeedInfo.timestamp,
                FeedInfo.decimals,
                FeedInfo.str
            ) = Morpheus(morpheus[i]).getFeed(IDs[i]);
            total[i] = FeedInfo.price;
            dec[i] = FeedInfo.decimals;
            strVal[i] = FeedInfo.str;
            bytesVal[i] = bytes(FeedInfo.str);
            tstamp[i] = FeedInfo.timestamp;
        }
        return (total, dec, strVal, bytesVal, tstamp);
    }

    function getFeedsQuorum(
        address[] memory morpheus,
        uint256[] memory IDs,
        uint256 threshold,
        uint256 quorum
    )
        external
        view
        returns (
            uint256 value,
            uint decimals,
            string memory valStr,
            bytes memory valBytes,
            uint timestamp
        )
    {
        require(morpheus.length == IDs.length, "Mismatch oracles");
        uint q;
        uint256[] memory total = new uint256[](morpheus.length);
        string[] memory strVal = new string[](morpheus.length);
        uint256 totalTimestamps = 0;
        for (uint256 i = 0; i < IDs.length; i++) {
            FeedData memory feed = getFeedData(morpheus[i], IDs[i]);
            if (
                block.timestamp - threshold < feed.timestamp || threshold == 0
            ) {
                total[i] = feed.price;
                strVal[i] = feed.str;
                q++;
                totalTimestamps += feed.timestamp;
                decimals = feed.decimals;
            }
        }
        require(quorum <= q, "Quorum not met");
        value = getMedianValue(total);
        (valStr, q) = mostUsedString(strVal);
        valBytes = bytes(valStr);
        timestamp = totalTimestamps / q;
    }

    function getFeedData(
        address oracle,
        uint256 ID
    ) internal view returns (FeedData memory feed) {
        (feed.price, feed.timestamp, feed.decimals, feed.str) = Morpheus(oracle)
            .getFeed(ID);
    }

    function getMedianValue(
        uint256[] memory values
    ) internal pure returns (uint256) {
        uint256[] memory sorted = sort(values);
        if (sorted.length % 2 == 1) {
            return sorted[(sorted.length + 1) / 2 - 1];
        } else {
            uint size1 = sorted.length / 2;
            return (sorted[size1 - 1] + sorted[size1]) / 2;
        }
    }

    function requestFeed(
        address[] memory morpheus,
        string memory APIendpoint,
        string memory APIendpointPath,
        uint256 decimals,
        uint256[] memory bounties
    ) external payable returns (uint256[] memory) {
        uint256[] memory ids = new uint256[](morpheus.length);
        uint256[] memory IDS = new uint256[](morpheus.length);
        string[] memory APIendpnt = new string[](1);
        string[] memory APIendpth = new string[](1);
        uint256[] memory dec = new uint256[](1);
        uint256[] memory bount = new uint256[](1);
        uint totals;
        for (uint256 i = 0; i < morpheus.length; i++) {
            APIendpnt[0] = APIendpoint;
            APIendpth[0] = APIendpointPath;
            dec[0] = decimals;
            bount[0] = bounties[i];
            ids = Morpheus(morpheus[i]).requestFeeds{value: bount[0]}(
                APIendpnt,
                APIendpth,
                dec,
                bount
            );
            IDS[i] = ids[0];
            totals += bounties[i];
        }
        require(totals <= msg.value, "Bounty not paid by msg.value");
        return (IDS);
    }

    function requestFeed(
        address[] memory morpheus,
        string memory APIendpoint,
        string memory APIendpointPath,
        uint256 decimals
    ) external payable returns (uint256[] memory) {
        uint256[] memory bount = new uint256[](morpheus.length);
        for (uint256 i = 0; i < morpheus.length; i++) {
            bount[i] = msg.value / morpheus.length;
        }
        uint[] memory IDs = this.requestFeed{value: msg.value}(
            morpheus,
            APIendpoint,
            APIendpointPath,
            decimals,
            bount
        );
        return (IDs);
    }

    function requestFeedPortal(
        address[] memory morpheus,
        string memory APIendpoint,
        string memory APIendpointPath,
        uint256 decimals,
        uint256 threshold,
        uint256 quorum
    ) external payable returns (uint256 requestPortalID) {
        uint256[] memory bount = new uint256[](morpheus.length);
        for (uint256 i = 0; i < morpheus.length; i++) {
            bount[i] = msg.value / morpheus.length;
        }
        uint[] memory IDs = this.requestFeed{value: msg.value}(
            morpheus,
            APIendpoint,
            APIendpointPath,
            decimals,
            bount
        );
        uint i = requests;
        requests++;
        request[i].morpheus = morpheus;
        request[i].ids = IDs;
        request[i].threshold = threshold;
        request[i].quorum = quorum;
        request[i].decimals = decimals;
        request[i].endpoint = APIendpoint;
        request[i].path = APIendpointPath;
        return (i);
    }

    function createCustomPortal(
        address[] memory morpheus,
        uint256[] memory IDs,
        uint256 decimals,
        uint256 threshold,
        uint256 quorum
    ) external payable returns (uint256 requestPortalID) {
        uint i = requests;
        requests++;
        request[i].morpheus = morpheus;
        request[i].ids = IDs;
        request[i].threshold = threshold;
        request[i].quorum = quorum;
        request[i].decimals = decimals;
        request[i].endpoint = "Custom Portal";
        request[i].path = "";
        return (i);
    }

    function getFeedPortalSimple(
        uint256 ID
    ) external view returns (uint256 value) {
        (value, , , , ) = this.getFeedsQuorum(
            request[ID].morpheus,
            request[ID].ids,
            request[ID].threshold,
            request[ID].quorum
        );
        value = value / 10 ** request[ID].decimals;
    }

    function getFeedPortal(
        uint256 ID
    )
        external
        view
        returns (
            uint256 value,
            uint decimals,
            string memory valStr,
            bytes memory valBytes,
            uint timestamp
        )
    {
        (value, decimals, valStr, valBytes, timestamp) = this.getFeedsQuorum(
            request[ID].morpheus,
            request[ID].ids,
            request[ID].threshold,
            request[ID].quorum
        );
        decimals = request[ID].decimals;
    }

    function updatePortal(uint ID) external payable {
        uint[] memory bounties = new uint[](request[ID].morpheus.length);
        for (uint i; i < request[ID].morpheus.length; i++) {
            bounties[i] = msg.value / request[ID].morpheus.length;
        }
        this.updateFeeds{value: msg.value}(
            request[ID].morpheus,
            request[ID].ids,
            bounties
        );
    }

    function requestFeedCallback(
        address[] memory morpheus,
        string memory APIendpoint,
        string memory APIendpointPath,
        uint256 decimals,
        uint256[] memory bounties,
        uint threshold,
        uint quorum,
        address receiveAddrs,
        uint256 bountyGuardian
    ) external payable returns (uint256[] memory, uint requestID) {
        uint[] memory IDs = new uint256[](morpheus.length);
        uint totals;
        for (uint256 i = 0; i < morpheus.length; i++) {
            totals += bounties[i];
        }
        totals += bountyGuardian;
        require(totals <= msg.value, "Bounty not paid by msg.value");
        IDs = this.requestFeed{value: msg.value}(
            morpheus,
            APIendpoint,
            APIendpointPath,
            decimals,
            bounties
        );
        uint i = requests;
        requests++;
        request[i].morpheus = morpheus;
        request[i].ids = IDs;
        request[i].target = receiveAddrs;
        request[i].threshold = threshold;
        request[i].quorum = quorum;
        request[i].bounty = bountyGuardian;
        request[i].decimals = decimals;
        request[i].endpoint = APIendpoint;
        request[i].path = APIendpointPath;
        emit dataCallbackRequested(i, bountyGuardian);
        return (IDs, i);
    }

    function fillRequest(uint256 ID) external {
        uint val;
        string memory valStr;
        bytes memory valBytes;
        uint timestamp;
        require(request[ID].bounty != 0, "Bounty not paid");
        (val, , valStr, valBytes, timestamp) = this.getFeedsQuorum(
            request[ID].morpheus,
            request[ID].ids,
            request[ID].threshold,
            request[ID].quorum
        );
        scryMetamorph(request[ID].target).requestCallback(
            val,
            request[ID].decimals,
            valStr,
            valBytes,
            timestamp,
            ID
        );
        uint reward = request[ID].bounty;
        request[ID].bounty = 0;
        payable(msg.sender).transfer(reward);
    }

    function refillRequest(uint256 ID, uint guardianBounty) external payable {
        request[ID].bounty += guardianBounty;
        uint available = (msg.value - guardianBounty) /
            request[ID].morpheus.length;
        uint[] memory bounties = new uint256[](request[ID].morpheus.length);
        for (uint i; i < request[ID].morpheus.length; i++) {
            bounties[i] = available;
        }
        this.updateFeeds{value: msg.value - guardianBounty}(
            request[ID].morpheus,
            request[ID].ids,
            bounties
        );
        emit dataCallbackRequested(ID, guardianBounty);
    }

    function updateFeeds(
        address[] memory morpheus,
        uint256[] memory IDs,
        uint256[] memory bounties
    ) external payable {
        require(
            morpheus.length == IDs.length && IDs.length == bounties.length,
            "Length mismatch"
        );
        uint totals;
        for (uint256 i = 0; i < morpheus.length; i++) {
            uint256[] memory id = new uint256[](1);
            id[0] = IDs[i];
            uint256[] memory bounty = new uint256[](1);
            bounty[0] = bounties[i];
            totals += bounties[i];
            Morpheus(morpheus[i]).supportFeeds{value: bounty[0]}(id, bounty);
        }
        require(totals <= msg.value, "Bounty not paid by msg.value");
    }

    function stringToBytes(
        string memory input
    ) public pure returns (bytes memory) {
        bytes memory stringBytes = bytes(input);
        uint offset = 0;

        // Check for '0x' or '0X' prefix and adjust the offset
        if (
            stringBytes.length >= 2 &&
            (stringBytes[0] == "0") &&
            (stringBytes[1] == "x" || stringBytes[1] == "X")
        ) {
            offset = 2;
        }

        // The length of the result should be half the length of the input string minus the offset
        bytes memory result = new bytes((stringBytes.length - offset) / 2);

        for (uint i = offset; i < stringBytes.length; i += 2) {
            result[(i - offset) / 2] = bytes1(
                (_hexCharToByte(stringBytes[i]) << 4) |
                    _hexCharToByte(stringBytes[i + 1])
            );
        }
        return result;
    }

    function _hexCharToByte(bytes1 char) internal pure returns (bytes1) {
        if (uint8(char) >= 48 && uint8(char) <= 57) {
            return bytes1(uint8(char) - 48);
        } else if (uint8(char) >= 65 && uint8(char) <= 70) {
            return bytes1(uint8(char) - 55); // A = 65 in ASCII (65-10)
        } else if (uint8(char) >= 97 && uint8(char) <= 102) {
            return bytes1(uint8(char) - 87); // a = 97 in ASCII (97-10-32)
        } else {
            revert("Invalid hexadecimal character.");
        }
    }

    function compareStrings(
        string memory str1,
        string memory str2
    ) public pure returns (bool) {
        if (
            keccak256(abi.encodePacked((str1))) ==
            keccak256(abi.encodePacked((str2)))
        ) return true;
        else return false;
    }

    function mostUsedString(
        string[] memory arr
    ) public pure returns (string memory, uint quorum) {
        uint maxCount = 0;
        string memory maxOccured;
        uint n = arr.length;
        for (uint i = 0; i < n; i++) {
            string memory str = arr[i];
            uint count = 1;
            for (uint j = i + 1; j < n; j++) {
                if (compareStrings(arr[i], arr[j])) {
                    count++;
                }
            }
            if (count > maxCount) {
                maxCount = count;
                maxOccured = str;
            }
        }
        return (maxOccured, maxCount);
    }

    function quickSort(uint[] memory arr, uint left, uint right) private pure {
        uint i = left;
        uint j = right;
        if (i == j) return;
        uint pivot = arr[uint(left + (right - left) / 2)];
        while (i <= j) {
            while (arr[uint(i)] < pivot) i++;
            while (j != 0 && pivot < arr[uint(j)]) j--;
            if (i <= j) {
                (arr[uint(i)], arr[uint(j)]) = (arr[uint(j)], arr[uint(i)]);
                i++;
                if (j != 0) {
                    j--;
                }
            }
        }
        if (left < j) quickSort(arr, left, j);
        if (i < right) quickSort(arr, i, right);
    }

    function sort(uint[] memory data) private pure returns (uint[] memory) {
        quickSort(data, 0, data.length - 1);
        return data;
    }
}
