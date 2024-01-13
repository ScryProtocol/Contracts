// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface Morpheus {
    function getFeed(
        uint256 feedID
    )
        external
        view
        returns (
            uint256 value,
            uint256 decimals,
            uint256 timestamp,
            string memory valStr
        );

    function requestFeeds(
        string[] calldata APIendpoint,
        string[] calldata APIendpointPath,
        uint256[] calldata decimals,
        uint256[] calldata bounties
    ) external payable returns (uint256[] memory feeds);
}

contract DeathRollopen {
    //POC Do Not Use
    struct Game {
        address player1;
        address player2;
        address winner;
        string commit1;
        string commit2;
        uint player1bet;
        uint player2bet;
        uint player1roll;
        uint player2roll;
        uint256 betAmount;
        uint256 vrfFeedId;
    }
    event GameCreated(uint256 indexed gameId, address player1, address player2);
    event PlayerJoined(uint256 indexed gameId, address player, string commit);
    event WinnerDetermined(
        uint256 indexed gameId,
        uint player1roll,
        uint player2roll,
        address winner,
        uint256 amount
    );
    mapping(address => uint) public pay;

    mapping(uint256 => Game) public games;
    Morpheus public morpheus;
    address public collect = 0x9D31e30003f253563Ff108BC60B16Fdf2c93abb5;
    uint public oracleFee = 500000000000000;

    constructor() {
        morpheus = Morpheus(0x0000000000071821e8033345A7Be174647bE0706);
    }

    function createGame(uint256 gameId, uint betAm, address p1) public {
        require(games[gameId].player1 == address(0), "Game ID already exists");
        games[gameId] = Game(
            msg.sender,
            p1,
            address(0),
            "",
            "",
            0,
            0,
            0,
            0,
            0,
            0
        );
        emit GameCreated(gameId, msg.sender, address(0));
        games[gameId].betAmount = betAm;
    }

    function joinGame(uint256 gameId, string memory _commit) public payable {
        if (gameId <= 4) {
            require(
                games[gameId].player1 != address(0),
                "Game ID does not exist"
            );
        }
        Game storage game = games[gameId];

        require(
            game.betAmount == 0 || msg.value == game.betAmount + oracleFee,
            "Incorrect bet amount"
        );
        if (game.player1 == address(0)) {
            game.player1 = msg.sender;
        }
        if (msg.sender == game.player1) {
            game.commit1 = _commit;
            require(game.player1bet == 0, "Already bet");
            game.player1bet = msg.value - oracleFee;
        } else {
            require(
                game.player2 == address(0) || game.player2 == msg.sender,
                "Game already full"
            );
            game.player2 = msg.sender;
            game.commit2 = _commit;
            require(game.player2bet == 0, "Already bet");
            game.player2bet = msg.value - oracleFee;
        }

        game.betAmount = msg.value - oracleFee;

        if (game.player1bet > 0 && game.player2bet > 0) {
            requestVRF(gameId);
            game.winner = address(0);
        }

        emit PlayerJoined(gameId, msg.sender, _commit);
    }

    function withdrawBet(uint256 gameId) public {
        require(games[gameId].player1 != address(0), "Game ID does not exist");
        Game storage game = games[gameId];

        require(
            msg.sender == game.player1 || msg.sender == game.player2,
            "Not a player in this game"
        );

        uint refundAmount = 0;

        if (msg.sender == game.player1) {
            require(game.player1bet > 0, "You haven't bet yet");
            require(game.player2bet == 0, "The other player has already bet");
            refundAmount = game.player1bet;
            game.player1bet = 0; // Set to 0 before transfer
            if (gameId <= 4) {
                game.player1 = address(0);
            }
        } else {
            require(game.player2bet > 0, "You haven't bet yet");
            require(game.player1bet == 0, "The other player has already bet");
            refundAmount = game.player2bet;
            game.player2bet = 0; // Set to 0 before transfer
            if (gameId <= 4) {
                game.player2 = address(0);
            }
        }

        pay[msg.sender] += (refundAmount);
    }

    function requestVRF(uint256 gameId) internal {
        string[] memory apiEndpoint = new string[](1);
        apiEndpoint[0] = "vrf";

        string[] memory apiEndpointPath = new string[](1);
        apiEndpointPath[0] = "";

        uint256[] memory decimals = new uint256[](1);
        decimals[0] = 0;

        uint256[] memory bounties = new uint256[](1);
        bounties[0] = 1000000000000000;

        uint256[] memory feeds = morpheus.requestFeeds{value: 1000000000000000}(
            apiEndpoint,
            apiEndpointPath,
            decimals,
            bounties
        );
        games[gameId].vrfFeedId = feeds[0];
    }

    function determineWinner(uint256 gameId) public {
        require(
            games[gameId].player1 != address(0) &&
                games[gameId].player2 != address(0),
            "Game not yet full"
        );
        Game storage game = games[gameId];
        require(game.winner == address(0));
        game.winner = address(1);

        (uint256 vrfValue, , , ) = morpheus.getFeed(game.vrfFeedId);
        require(vrfValue != 0, "Oracle");
        uint256 roll1 = (uint256(
            keccak256(abi.encodePacked(game.player1, vrfValue, game.commit1))
        ) % 100) + 1;
        uint256 roll2 = (uint256(
            keccak256(abi.encodePacked(game.player2, vrfValue, game.commit2))
        ) % 100) + 1;
        if (roll1 > roll2) {
            pay[game.player1] += ((game.betAmount * 2 * 99) / 100);
            pay[collect] += ((game.betAmount * 2 * 1) / 100);
            game.winner = game.player1;
        } else if (roll2 > roll1) {
            game.winner = game.player2;
            pay[game.player2] += ((game.betAmount * 2 * 99) / 100);
            pay[collect] += ((game.betAmount * 2 * 1) / 100);
        } else {
            // It's a tie, refund the players
            pay[game.player1] += (game.betAmount);
            pay[game.player2] += (game.betAmount);
        }
        emit WinnerDetermined(
            gameId,
            roll1,
            roll2,
            game.winner,
            game.betAmount * 2
        );
        game.player1roll = roll1;
        game.player2roll = roll2;
        game.player1bet = 0;
        game.player2bet = 0;
        if (gameId > 4) {
            game.betAmount = 0;
        }
        if (gameId <= 4) {
            game.player1 = address(0);
            game.player2 = address(0);
            game.player1roll = 0;
            game.player2roll = 0;
        }
    }

    function withdraw() public {
        uint am = pay[msg.sender];
        pay[msg.sender] = 0;
        payable(msg.sender).transfer(am);
    }

    function swapcollector(address newcollector, uint oFee) public {
        require(msg.sender == collect);
        if (collect != address(0)) {
            collect = newcollector;
        }
        if (oFee != 0) {
            oracleFee = oFee;
        }
    }
}
