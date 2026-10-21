// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

/// @notice Plain ERC20 with configurable decimals and open minting.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Mimics Orbio $CREDIT: 6 decimals; `activate` irreversibly burns the caller's tokens
///         (the real token credits an off-chain API balance).
contract MockCredit is MockERC20 {
    mapping(address => uint256) public apiBalance;

    constructor() MockERC20("Orbio Credit", "CREDIT", 6) {}

    function activate(uint256 amount) external {
        _burn(msg.sender, amount);
        apiBalance[msg.sender] += amount;
    }
}

/// @notice Token that takes a 1% fee on every transfer (to check that `_pullExact` rejects it).
contract FeeOnTransferToken is MockERC20 {
    constructor() MockERC20("Fee Token", "FEE", 6) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @notice Oracle whose prices can be changed by tests.
contract MockOracle is IPriceOracle {
    mapping(address => uint256) public prices;

    function setPrice(address asset, uint256 priceWad) external {
        prices[asset] = priceWad;
    }

    function getPrice(address asset) external view returns (uint256 p) {
        p = prices[asset];
        require(p != 0, "no price");
    }
}
