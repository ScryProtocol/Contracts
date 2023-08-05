// SPDX-License-Identifier: SCRY
pragma solidity 0.8.6;
pragma abicoder v2;

interface scryMetamorph {
    function requestCallback(
        uint _val,
        string memory _valStr,
        bytes memory _valBytes,
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

    function getFeeds(
        address[] memory morpheus,
        uint256[] memory IDs,
        uint256 threshold
    )
        external
        view
        returns (uint256 value, string memory valStr, bytes memory valBytes)
    {
        uint256 returnPrices;
        uint256 returnTimestamps;
        uint256 returnDecimals;
        string memory returnStr;
        uint256[] memory total = new uint256[](morpheus.length);
        string[] memory strVal = new string[](morpheus.length);
        for (uint256 i = 0; i < IDs.length; i++) {
            (
                returnPrices,
                returnTimestamps,
                returnDecimals,
                returnStr
            ) = Morpheus(morpheus[i]).getFeed(IDs[i]);
            if (
                block.timestamp - threshold < returnTimestamps || threshold == 0
            ) {
                total[i] = returnPrices / 10 ** returnDecimals;
                strVal[i] = returnStr;
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
    }

    function getFeedsQuorum(
        address[] memory morpheus,
        uint256[] memory IDs,
        uint256 threshold,
        uint256 quorum
    )
        external
        view
        returns (uint256 value, string memory valStr, bytes memory valBytes)
    {
        uint256 returnPrices;
        uint256 returnTimestamps;
        uint256 returnDecimals;
        string memory returnStr;
        uint q;
        uint256[] memory total = new uint256[](morpheus.length);
        string[] memory strVal = new string[](morpheus.length);
        for (uint256 i = 0; i < IDs.length; i++) {
            (
                returnPrices,
                returnTimestamps,
                returnDecimals,
                returnStr
            ) = Morpheus(morpheus[i]).getFeed(IDs[i]);
            if (
                block.timestamp - threshold < returnTimestamps || threshold == 0
            ) {
                total[i] = returnPrices / 10 ** returnDecimals;
                strVal[i] = returnStr;
                q++;
            }
        }
        require(quorum <= q, "Quorum not met");
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
        (valStr, q) = mostUsedString(strVal);
        valBytes = bytes(valStr);
        require(quorum <= q, "Quorum not met");
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
        string[] memory APIendpnt = new string[](morpheus.length);
        string[] memory APIendpth = new string[](morpheus.length);
        uint256[] memory dec = new uint256[](morpheus.length);
        uint256[] memory bount = new uint256[](morpheus.length);
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

    struct requeststruct {
        uint[] ids;
        address[] morpheus;
        address target;
        uint bounty;
        uint threshold;
        uint quorum;
    }
    mapping(uint => requeststruct) public request;
    uint public requests;

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
        emit dataCallbackRequested(i, bountyGuardian);
        return (IDs, i);
    }

    function fillRequest(uint256 ID) external {
        uint val;
        string memory valStr;
        bytes memory valBytes;
        require(request[ID].bounty != 0, "Bounty not paid");
        (val, valStr, valBytes) = this.getFeedsQuorum(
            request[ID].morpheus,
            request[ID].ids,
            request[ID].threshold,
            request[ID].quorum
        );
        scryMetamorph(request[ID].target).requestCallback(
            val,
            valStr,
            valBytes,
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
        this.updateFeeds(request[ID].morpheus, request[ID].ids, bounties);
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
