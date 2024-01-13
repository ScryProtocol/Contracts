// SPDX-License-Identifier: SCRY
pragma solidity 0.8.6;

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IERC20 {
    /**
     * @dev Emitted when `value` tokens are moved from one account (`from`) to
     * another (`to`).
     *
     * Note that `value` may be zero.
     */
    event Transfer(address indexed from, address indexed to, uint256 value);

    /**
     * @dev Emitted when the allowance of a `spender` for an `owner` is set by
     * a call to {approve}. `value` is the new allowance.
     */
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );

    function decimals() external view returns (uint8);

    /**
     * @dev Returns the amount of tokens in existence.
     */
    function totalSupply() external view returns (uint256);

    /**
     * @dev Returns the amount of tokens owned by `account`.
     */
    function balanceOf(address account) external view returns (uint256);

    /**
     * @dev Moves `amount` tokens from the caller's account to `to`.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transfer(address to, uint256 amount) external returns (bool);

    /**
     * @dev Returns the remaining number of tokens that `spender` will be
     * allowed to spend on behalf of `owner` through {transferFrom}. This is
     * zero by default.
     *
     * This value changes when {approve} or {transferFrom} are called.
     */
    function allowance(
        address owner,
        address spender
    ) external view returns (uint256);

    /**
     * @dev Sets `amount` as the allowance of `spender` over the caller's tokens.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * IMPORTANT: Beware that changing an allowance with this method brings the risk
     * that someone may use both the old and the new allowance by unfortunate
     * transaction ordering. One possible solution to mitigate this race
     * condition is to first reduce the spender's allowance to 0 and set the
     * desired value afterwards:
     * https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
     *
     * Emits an {Approval} event.
     */
    function approve(address spender, uint256 amount) external returns (bool);

    /**
     * @dev Moves `amount` tokens from `from` to `to` using the
     * allowance mechanism. `amount` is then deducted from the caller's
     * allowance.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

/**
 * @dev Implementation of the {IERC20} interface.
 *
 * This implementation is agnostic to the way tokens are created. This means
 * that a supply mechanism has to be added in a derived contract using {_mint}.
 * For a generic mechanism see {ERC20PresetMinterPauser}.
 *
 * TIP: For a detailed writeup see our guide
 * https://forum.openzeppelin.com/t/how-to-implement-erc20-supply-mechanisms/226[How
 * to implement supply mechanisms].
 *
 * The default value of {decimals} is 18. To change this, you should override
 * this function so it returns a different value.
 *
 * We have followed general OpenZeppelin Contracts guidelines: functions revert
 * instead returning `false` on failure. This behavior is nonetheless
 * conventional and does not conflict with the expectations of ERC20
 * applications.
 *
 * Additionally, an {Approval} event is emitted on calls to {transferFrom}.
 * This allows applications to reconstruct the allowance for all accounts just
 * by listening to said events. Other implementations of the EIP may not emit
 * these events, as it isn't required by the specification.
 *
 * Finally, the non-standard {decreaseAllowance} and {increaseAllowance}
 * functions have been added to mitigate the well-known issues around setting
 * allowances. See {IERC20-approve}.
 */
contract ERC20 is IERC20 {
    mapping(address => uint256) private _balances;

    mapping(address => mapping(address => uint256)) private _allowances;

    uint256 private _totalSupply;

    string private _name;
    string private _symbol;

    /**
     * @dev Sets the values for {name} and {symbol}.
     *
     * All two of these values are immutable: they can only be set once during
     * construction.
     */
    constructor(string memory name_, string memory symbol_) {
        _name = name_;
        _symbol = symbol_;
    }

    /**
     * @dev Returns the number of decimals used to get its user representation.
     * For example, if `decimals` equals `2`, a balance of `505` tokens should
     * be displayed to a user as `5.05` (`505 / 10 ** 2`).
     *
     * Tokens usually opt for a value of 18, imitating the relationship between
     * Ether and Wei. This is the default value returned by this function, unless
     * it's overridden.
     *
     * NOTE: This information is only used for _display_ purposes: it in
     * no way affects any of the arithmetic of the contract, including
     * {IERC20-balanceOf} and {IERC20-transfer}.
     */
    function decimals() public view virtual override returns (uint8) {
        return 18;
    }

    /**
     * @dev See {IERC20-totalSupply}.
     */
    function totalSupply() public view virtual override returns (uint256) {
        return _totalSupply;
    }

    /**
     * @dev See {IERC20-balanceOf}.
     */
    function balanceOf(
        address account
    ) public view virtual override returns (uint256) {
        return _balances[account];
    }

    /**
     * @dev See {IERC20-transfer}.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `amount`.
     */
    function transfer(
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        address owner = msg.sender;
        _transfer(owner, to, amount);
        return true;
    }

    /**
     * @dev See {IERC20-allowance}.
     */
    function allowance(
        address owner,
        address spender
    ) public view virtual override returns (uint256) {
        return _allowances[owner][spender];
    }

    /**
     * @dev See {IERC20-approve}.
     *
     * NOTE: If `amount` is the maximum `uint256`, the allowance is not updated on
     * `transferFrom`. This is semantically equivalent to an infinite approval.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     */
    function approve(
        address spender,
        uint256 amount
    ) public virtual override returns (bool) {
        address owner = msg.sender;
        _approve(owner, spender, amount);
        return true;
    }

    /**
     * @dev See {IERC20-transferFrom}.
     *
     * Emits an {Approval} event indicating the updated allowance. This is not
     * required by the EIP. See the note at the beginning of {ERC20}.
     *
     * NOTE: Does not update the allowance if the current allowance
     * is the maximum `uint256`.
     *
     * Requirements:
     *
     * - `from` and `to` cannot be the zero address.
     * - `from` must have a balance of at least `amount`.
     * - the caller must have allowance for ``from``'s tokens of at least
     * `amount`.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        address spender = msg.sender;
        _spendAllowance(from, spender, amount);
        _transfer(from, to, amount);
        return true;
    }

    /**
     * @dev Atomically increases the allowance granted to `spender` by the caller.
     *
     * This is an alternative to {approve} that can be used as a mitigation for
     * problems described in {IERC20-approve}.
     *
     * Emits an {Approval} event indicating the updated allowance.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     */
    function increaseAllowance(
        address spender,
        uint256 addedValue
    ) public virtual returns (bool) {
        address owner = msg.sender;
        _approve(owner, spender, allowance(owner, spender) + addedValue);
        return true;
    }

    /**
     * @dev Atomically decreases the allowance granted to `spender` by the caller.
     *
     * This is an alternative to {approve} that can be used as a mitigation for
     * problems described in {IERC20-approve}.
     *
     * Emits an {Approval} event indicating the updated allowance.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     * - `spender` must have allowance for the caller of at least
     * `subtractedValue`.
     */
    function decreaseAllowance(
        address spender,
        uint256 subtractedValue
    ) public virtual returns (bool) {
        address owner = msg.sender;
        uint256 currentAllowance = allowance(owner, spender);
        require(
            currentAllowance >= subtractedValue,
            "ERC20: decreased allowance below zero"
        );
        unchecked {
            _approve(owner, spender, currentAllowance - subtractedValue);
        }

        return true;
    }

    /**
     * @dev Moves `amount` of tokens from `from` to `to`.
     *
     * This internal function is equivalent to {transfer}, and can be used to
     * e.g. implement automatic token fees, slashing mechanisms, etc.
     *
     * Emits a {Transfer} event.
     *
     * Requirements:
     *
     * - `from` cannot be the zero address.
     * - `to` cannot be the zero address.
     * - `from` must have a balance of at least `amount`.
     */
    function _transfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");

        _beforeTokenTransfer(from, to, amount);

        uint256 fromBalance = _balances[from];
        require(
            fromBalance >= amount,
            "ERC20: transfer amount exceeds balance"
        );
        unchecked {
            _balances[from] = fromBalance - amount;
            // Overflow not possible: the sum of all balances is capped by totalSupply, and the sum is preserved by
            // decrementing then incrementing.
            _balances[to] += amount;
        }

        emit Transfer(from, to, amount);

        _afterTokenTransfer(from, to, amount);
    }

    /** @dev Creates `amount` tokens and assigns them to `account`, increasing
     * the total supply.
     *
     * Emits a {Transfer} event with `from` set to the zero address.
     *
     * Requirements:
     *
     * - `account` cannot be the zero address.
     */
    function _mint(address account, uint256 amount) internal virtual {
        require(account != address(0), "ERC20: mint to the zero address");

        _beforeTokenTransfer(address(0), account, amount);

        _totalSupply += amount;
        unchecked {
            // Overflow not possible: balance + amount is at most totalSupply + amount, which is checked above.
            _balances[account] += amount;
        }
        emit Transfer(address(0), account, amount);

        _afterTokenTransfer(address(0), account, amount);
    }

    /**
     * @dev Destroys `amount` tokens from `account`, reducing the
     * total supply.
     *
     * Emits a {Transfer} event with `to` set to the zero address.
     *
     * Requirements:
     *
     * - `account` cannot be the zero address.
     * - `account` must have at least `amount` tokens.
     */
    function _burn(address account, uint256 amount) internal virtual {
        require(account != address(0), "ERC20: burn from the zero address");

        _beforeTokenTransfer(account, address(0), amount);

        uint256 accountBalance = _balances[account];
        require(accountBalance >= amount, "ERC20: burn amount exceeds balance");
        unchecked {
            _balances[account] = accountBalance - amount;
            // Overflow not possible: amount <= accountBalance <= totalSupply.
            _totalSupply -= amount;
        }

        emit Transfer(account, address(0), amount);

        _afterTokenTransfer(account, address(0), amount);
    }

    /**
     * @dev Sets `amount` as the allowance of `spender` over the `owner` s tokens.
     *
     * This internal function is equivalent to `approve`, and can be used to
     * e.g. set automatic allowances for certain subsystems, etc.
     *
     * Emits an {Approval} event.
     *
     * Requirements:
     *
     * - `owner` cannot be the zero address.
     * - `spender` cannot be the zero address.
     */
    function _approve(
        address owner,
        address spender,
        uint256 amount
    ) internal virtual {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");

        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    /**
     * @dev Updates `owner` s allowance for `spender` based on spent `amount`.
     *
     * Does not update the allowance amount in case of infinite allowance.
     * Revert if not enough allowance is available.
     *
     * Might emit an {Approval} event.
     */
    function _spendAllowance(
        address owner,
        address spender,
        uint256 amount
    ) internal virtual {
        uint256 currentAllowance = allowance(owner, spender);
        if (currentAllowance != type(uint256).max) {
            require(
                currentAllowance >= amount,
                "ERC20: insufficient allowance"
            );
            unchecked {
                _approve(owner, spender, currentAllowance - amount);
            }
        }
    }

    /**
     * @dev Hook that is called before any transfer of tokens. This includes
     * minting and burning.
     *
     * Calling conditions:
     *
     * - when `from` and `to` are both non-zero, `amount` of ``from``'s tokens
     * will be transferred to `to`.
     * - when `from` is zero, `amount` tokens will be minted for `to`.
     * - when `to` is zero, `amount` of ``from``'s tokens will be burned.
     * - `from` and `to` are never both zero.
     *
     * To learn more about hooks, head to xref:ROOT:extending-contracts.adoc#using-hooks[Using Hooks].
     */
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual {}

    /**
     * @dev Hook that is called after any transfer of tokens. This includes
     * minting and burning.
     *
     * Calling conditions:
     *
     * - when `from` and `to` are both non-zero, `amount` of ``from``'s tokens
     * has been transferred to `to`.
     * - when `from` is zero, `amount` tokens have been minted for `to`.
     * - when `to` is zero, `amount` of ``from``'s tokens have been burned.
     * - `from` and `to` are never both zero.
     *
     * To learn more about hooks, head to xref:ROOT:extending-contracts.adoc#using-hooks[Using Hooks].
     */
    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual {}
}

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

contract HedgeInsure is ERC20 {
    address[] public morpheus;
    uint[] public IDs;
    address public collateralToken;
    uint public expiry;
    uint public claimValue;
    uint public priceDec;
    uint public currentPrice;
    uint public timestamp;
    mapping(address => uint) public collateral;
    string public name;
    string public symbol;
     string public Condition;
    event Initialized(
        string name,
        string symbol,
        address[] morpheus,
        address collateralToken,
        uint expiry,
        uint claimValue,
        string APIendpoint,
        string APIendpointPath,
        uint256 dec,
        uint[] bounties
    );

    event Minted(address indexed to, uint amount, address indexed from);

    event Delta(uint profit);

    event Unlocked(uint amount, address indexed from);

    event Redeemed(
        address indexed from,
        uint amount,
        uint optionamount,
        uint collateral
    );

    event PriceUpdated(uint value, uint timestamp);

    constructor() ERC20("", "") {}

    function init(
        string memory name_,
        string memory symbol_,
        address[] memory _morpheus,
        address _collateralToken,
        uint _expiry,
        uint _claimValue,
        string memory APIendpoint,
        string memory APIendpointPath,
        uint256 dec
    ) public payable {
        uint[] memory bounties = new uint[](morpheus.length + 1);
        require(collateralToken == address(0), "Already initd");
        name = name_;
        symbol = symbol_;
        morpheus = _morpheus;
        collateralToken = _collateralToken;
        expiry = block.timestamp + _expiry * 1 minutes; //days;
        claimValue = _claimValue;
        Condition = APIendpointPath;//'
        priceDec = dec;
        currentPrice = _claimValue;
        for (uint i; i < morpheus.length; i++) {
            bounties[i] = msg.value / morpheus.length;
        }
        IDs = requestFeed(
            morpheus,
            APIendpoint,
            APIendpointPath,
            dec,
            bounties
        );
        emit Initialized(
            name,
            symbol,
            morpheus,
            collateralToken,
            expiry,
            claimValue,
            APIendpoint,
            APIendpointPath,
            dec,
            bounties
        );
    }

    function mint(address to, uint amount) public {
        require(block.timestamp < expiry, "Option expired");
        IERC20(collateralToken).transferFrom(
            msg.sender,
            address(this),
            (amount * claimValue) / 10 ** priceDec
        );
        collateral[msg.sender] += (amount * claimValue) / 10 ** priceDec;
        _mint(to, amount);
        emit Minted(to, amount, msg.sender);
    }

    function getDelta() public view returns (uint profit) {
        if (claimValue > currentPrice) {
            uint payoff = (claimValue - currentPrice);
            profit = payoff;
        }
        return profit;
    }

    function unlock(uint amount) public {
        uint holderPayoff = amount;
        collateral[msg.sender] = collateral[msg.sender] - amount;
        _burn(msg.sender, amount / (claimValue / 10 ** priceDec));
        IERC20(collateralToken).transfer(msg.sender, holderPayoff);
        emit Unlocked(amount, msg.sender);
    }

    function redeem() public {
        require(timestamp >= expiry, "Option not yet expired");
        if (claimValue > currentPrice) {
            uint payoff = (claimValue - currentPrice);
            uint holderPayoff = ((payoff * balanceOf(msg.sender)) /
                10 ** priceDec);
            uint holderCollateral = (collateral[msg.sender] *
                (claimValue - getDelta())) / claimValue;
            collateral[msg.sender] = 0;
            emit Redeemed(
                msg.sender,
                balanceOf(msg.sender),
                holderCollateral,
                holderCollateral
            );

            _burn(msg.sender, balanceOf(msg.sender));
            IERC20(collateralToken).transfer(
                msg.sender,
                holderCollateral + holderPayoff
            );
        } else {
            uint holderCollateral = (collateral[msg.sender] * currentPrice) /
                claimValue;
            collateral[msg.sender] = 0;
            emit Redeemed(
                msg.sender,
                balanceOf(msg.sender),
                0,
                holderCollateral
            );
            IERC20(collateralToken).transfer(msg.sender, holderCollateral);
            _burn(msg.sender, balanceOf(msg.sender));
        }
    }

    function updatePrice() external returns (uint value) {
        require(timestamp < expiry, "Already settled");
        uint256 returnPrices;
        uint256 returnTimestamps;
        uint256 returnDecimals;
        string memory returnStr;
        uint q;
        uint256[] memory total = new uint256[](morpheus.length);
        for (uint256 i = 0; i < IDs.length; i++) {
            (
                returnPrices,
                returnTimestamps,
                returnDecimals,
                returnStr
            ) = Morpheus(morpheus[i]).getFeed(IDs[i]);
            if (block.timestamp < expiry || returnTimestamps > expiry) {
                total[i] = returnPrices;
                q++;
            }
        }
        require(morpheus.length / 2 + 1 <= q, "Quorum not met");
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
        require(morpheus.length / 2 + 1 <= q, "Quorum not met");
        timestamp = block.timestamp;
        
        emit PriceUpdated(value, timestamp);
        if (value>0){
        expiry=block.timestamp;
        currentPrice=currentPrice*(100-value)/100;
    }}

    function requestFeed(
        address[] memory morpheus,
        string memory APIendpoint,
        string memory APIendpointPath,
        uint256 decimals,
        uint256[] memory bounties
    ) internal returns (uint256[] memory) {
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

    function updateFeeds() external payable {
        require(morpheus.length == IDs.length, "Length mismatch");

        for (uint256 i = 0; i < morpheus.length; i++) {
            uint256[] memory id = new uint256[](1);
            id[0] = IDs[i];
            uint256[] memory bounty = new uint256[](1);
            bounty[0] = msg.value / morpheus.length;

            Morpheus(morpheus[i]).supportFeeds{value: bounty[0]}(id, bounty);
        }
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

    function decimals() public view virtual override returns (uint8) {
        return IERC20(collateralToken).decimals();
    }
}
pragma solidity ^0.8.0;

contract InsureHedgeFactory {
    address[] public deployedDeltas;
    struct DeltaParams {
        address[] morpheus;
        address collateralToken;
        uint expiry;
        uint claimValue;
        string APIendpoint;
        string APIendpointPath;
        uint256 dec;
    }
    mapping(address => DeltaParams) public DeltaInfo;
    uint public total;
    event deltaDeployed(
        address deltaaddrs,
        uint ID,
        string name,
        string symbol,
        address[] morpheus,
        address collateralToken,
        uint expiry,
        uint claimValue,
        string APIendpoint,
        string APIendpointPath,
        uint256 dec
    );

    function createDelta(
        string memory _name,
        string memory _symbol,
        address[] memory _morpheus,
        address _collateralToken,
        uint _expiry,
        uint _claimValue,
        string memory APIendpoint,
        string memory APIendpointPath,
        uint256 dec
    ) public payable {
        HedgeInsure delta = new HedgeInsure();
        delta.init{value: msg.value}(
            _name,
            _symbol,
            _morpheus,
            _collateralToken,
            _expiry,
            _claimValue,
            APIendpoint,
            APIendpointPath,
            dec
        );
        deployedDeltas.push(address(delta));
        DeltaParams memory params = DeltaParams({
            morpheus: _morpheus,
            collateralToken: _collateralToken,
            expiry: _expiry,
            claimValue: _claimValue,
            APIendpoint: APIendpoint,
            APIendpointPath: APIendpointPath,
            dec: dec
        });
        emit deltaDeployed(
            address(delta),
            total,
            _name,
            _symbol,
            _morpheus,
            _collateralToken,
            _expiry,
            _claimValue,
            APIendpoint,
            APIendpointPath,
            dec
        );
        DeltaInfo[address(delta)] = params;
        total++;
    }

    function getDeployedDeltas() public view returns (address[] memory) {
        return deployedDeltas;
    }
}
