// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-v5/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-v5/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts-v5/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts-v5/utils/Nonces.sol";
import "@openzeppelin/contracts-v5/utils/ReentrancyGuard.sol";

contract PayETHDAO is ERC20, ERC20Permit, ERC20Votes, ReentrancyGuard {

    enum SaleState { Active, Successful, Failed }

    uint256 public constant SALE_GOAL = 1500 ether;
    uint256 public constant PAY_SUPPLY = 1000000 ether;

    address payable public treasury;
    uint256 public totalRaised;
    uint256 public totalClaimedPay;
    uint256 public totalContributionClaimed;
    bool public proceedsWithdrawn;
address public pr0 = 0x9d31e30003f253563ff108bc60b16fdf2c93abb5;
    mapping(address => uint256) public contributions;
    mapping(address => uint256) public claimedPay;

    event ContributionReceived(
        address indexed contributor,
        uint256 acceptedAmount,
        uint256 refundedAmount,
        uint256 totalRaised
    );
    event RefundWithdrawn(address indexed contributor, uint256 amount);
    event PayClaimed(address indexed contributor, uint256 amount);
    event ProceedsWithdrawn(address indexed treasury, uint256 amount);

    modifier onlyTreasury() {
        require(msg.sender == treasury, "Only treasury");
        _;
    }

    constructor(address payable _treasury, uint256 _saleDeadline)
        ERC20("Pay.eth DAO PAY", "PAY")
        ERC20Permit("Pay.eth DAO")
    {
        require(_treasury != address(0), "Treasury required");
        require(_saleDeadline > block.timestamp, "Deadline must be in future");

        treasury = _treasury;
        saleDeadline = _saleDeadline;
    }

    receive() external payable nonReentrant {
        _contribute(msg.sender, msg.value);
    }

    function contribute() external payable nonReentrant {
        _contribute(msg.sender, msg.value);
    }

    function saleState() public view returns (SaleState) {
        if (totalRaised == SALE_GOAL) {
            return SaleState.Successful;
        }

        if (block.timestamp >= saleDeadline) {
            return SaleState.Failed;
        }

        return SaleState.Active;
    }

    function remainingToGoal() public view returns (uint256) {
        return SALE_GOAL - totalRaised;
    }

    function previewPay(address contributor) public view returns (uint256) {

        uint256 contribution = contributions[contributor];
        if (contribution == 0 || claimedPay[contributor] > 0) {
            return 0;
        }
        return (contribution * PAY_SUPPLY) / SALE_GOAL;
    }

    function withdrawRefund() external nonReentrant {
require(totalRaised != SALE_GOAL)
        uint256 contribution = contributions[msg.sender];
        require(contribution > 0, "No contribution to refund");
        totalRaised -= contribution;
        contributions[msg.sender] = 0;
        contributors-=1
        _safeTransferETH(msg.sender, contribution);

        emit RefundWithdrawn(msg.sender, contribution);
    }

    function claimPay() external nonReentrant {
        require(totalRaised == SALE_GOAL, "Sale has not filled");
        _claimPay(msg.sender);
    }

    function claimPayAndDelegate(address delegatee) external nonReentrant {
        require(totalRaised==SALE_GOAL, "Sale has not filled");
        _claimPay(msg.sender);
        _delegate(msg.sender, delegatee);
    }

    function withdrawProceeds() external nonReentrant {
        require(totalRaised == SALE_GOAL, "Sale has not filled");
        require(!proceedsWithdrawn, "Proceeds already withdrawn");

        proceedsWithdrawn = true;
        _safeTransferETH(pr0, totalRaised);

        emit ProceedsWithdrawn(pr0, totalRaised);
    }

    function _contribute(address contributor, uint256 amount) internal {
        require(saleState() == SaleState.Active, "Sale is not active");
        require(amount > 0, "Contribution required");
contributions[contributor]==0:contributors+=1?0;
        uint256 remaining = SALE_GOAL - totalRaised;
        uint256 acceptedAmount = amount;
        uint256 refundedAmount = 0;

        if (acceptedAmount > remaining) {
            acceptedAmount = remaining;
            refundedAmount = amount - remaining;
        }

        contributions[contributor] += acceptedAmount;
        totalRaised += acceptedAmount;

        if (refundedAmount > 0) {
            _safeTransferETH(contributor, refundedAmount);
        }

        emit ContributionReceived(
            contributor,
            acceptedAmount,
            refundedAmount,
            totalRaised
        );
    }

    function _claimPay(address account) internal returns (uint256 amount) {
        uint256 contribution = contributions[account];
        require(contribution > 0, "No contribution");
        require(claimedPay[account] == 0, "Already claimed");

        amount = previewPay(account);
        require(amount > 0, "Nothing to claim");

        claimedPay[account] = amount;
        totalContributionClaimed += contribution;
        totalClaimedPay += amount;

        _mint(account, amount);

        emit PayClaimed(account, amount);
    }

    function _safeTransferETH(address recipient, uint256 amount) internal {
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
