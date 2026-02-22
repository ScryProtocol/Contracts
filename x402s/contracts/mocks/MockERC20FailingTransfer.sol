// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockERC20FailingTransfer {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public blockedRecipient;
    bool public failBlockedRecipient;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    ) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function setFailure(address recipient, bool shouldFail) external {
        blockedRecipient = recipient;
        failBlockedRecipient = shouldFail;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failBlockedRecipient && to == blockedRecipient) {
            return false;
        }
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        uint256 current = allowance[from][msg.sender];
        require(current >= amount, "MockERC20FailingTransfer: allowance");
        allowance[from][msg.sender] = current - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(
        address from,
        address to,
        uint256 amount
    ) internal {
        require(to != address(0), "MockERC20FailingTransfer: zero to");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "MockERC20FailingTransfer: balance");
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
