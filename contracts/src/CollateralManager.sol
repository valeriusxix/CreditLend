// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICollateralManager} from "./interfaces/ICollateralManager.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {LiquidationLogic} from "./libraries/LiquidationLogic.sol";

/// @title CollateralManager
/// @notice Per-asset collateral risk parameters and price routing for CreditLend (AGENT.md §4.1).
/// @dev Holds no funds. The owner is expected to be a TimelockController, so every parameter change
///      is visible to users before it takes effect. The agent has NO role here.
contract CollateralManager is ICollateralManager, Ownable2Step {
    using Math for uint256;

    uint256 internal constant BPS = 10_000;

    /// @notice $1 face value of one $CREDIT, the ceiling of the debt settlement price.
    uint256 public constant DEBT_FACE_VALUE = 1e18;

    /// @notice Bounded so account valuation (a loop over listed assets) stays cheap.
    uint256 public constant MAX_ASSETS = 8;

    uint16 public constant MAX_LIQ_THRESHOLD_BPS = 9_500;
    uint16 public constant MIN_LIQ_BONUS_BPS = 100;
    uint16 public constant MAX_LIQ_BONUS_BPS = 2_000;

    /// @inheritdoc ICollateralManager
    address public immutable debtAsset;

    IPriceOracle public oracle;

    mapping(address asset => AssetConfig) private _configs;
    address[] private _listedAssets;

    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event AssetListed(address indexed asset, AssetConfig config);
    event AssetConfigUpdated(address indexed asset, AssetConfig config);

    error ZeroAddress();
    error DebtAssetNotAllowedAsCollateral();
    error AlreadyListed();
    error NotListed();
    error TooManyAssets();
    error InvalidConfig();
    error InvalidPrice(address asset);

    constructor(address owner_, address debtAsset_, IPriceOracle oracle_) Ownable(owner_) {
        if (debtAsset_ == address(0) || address(oracle_) == address(0)) revert ZeroAddress();
        debtAsset = debtAsset_;
        oracle = oracle_;
        emit OracleUpdated(address(0), address(oracle_));
    }

    // ---------------------------------------------------------------------------------------------
    // Admin (timelocked owner)
    // ---------------------------------------------------------------------------------------------

    /// @notice Adds a new collateral asset. Assets can be disabled later but never removed.
    function listAsset(
        address asset,
        bool depositsEnabled,
        uint16 ltvBps,
        uint16 liqThresholdBps,
        uint16 liqBonusBps,
        uint256 supplyCap
    ) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        // Borrowing $CREDIT against $CREDIT would only enable recursive leverage on the same asset.
        if (asset == debtAsset) revert DebtAssetNotAllowedAsCollateral();
        if (_configs[asset].listed) revert AlreadyListed();
        if (_listedAssets.length >= MAX_ASSETS) revert TooManyAssets();

        uint8 decimals = IERC20Metadata(asset).decimals();
        if (decimals > 36) revert InvalidConfig();

        AssetConfig memory cfg = AssetConfig({
            listed: true,
            depositsEnabled: depositsEnabled,
            decimals: decimals,
            ltvBps: ltvBps,
            liqThresholdBps: liqThresholdBps,
            liqBonusBps: liqBonusBps,
            supplyCap: supplyCap
        });
        _validate(cfg);
        _requirePrice(asset);

        _configs[asset] = cfg;
        _listedAssets.push(asset);
        emit AssetListed(asset, cfg);
    }

    /// @notice Updates risk parameters of a listed asset.
    /// @dev Lowering `liqThresholdBps` can make existing positions liquidatable; the timelock delay
    ///      gives borrowers time to react. To wind down an asset: disable deposits and set LTV to 0.
    function updateAssetConfig(
        address asset,
        bool depositsEnabled,
        uint16 ltvBps,
        uint16 liqThresholdBps,
        uint16 liqBonusBps,
        uint256 supplyCap
    ) external onlyOwner {
        AssetConfig storage cfg = _configs[asset];
        if (!cfg.listed) revert NotListed();

        AssetConfig memory updated = AssetConfig({
            listed: true,
            depositsEnabled: depositsEnabled,
            decimals: cfg.decimals,
            ltvBps: ltvBps,
            liqThresholdBps: liqThresholdBps,
            liqBonusBps: liqBonusBps,
            supplyCap: supplyCap
        });
        _validate(updated);

        _configs[asset] = updated;
        emit AssetConfigUpdated(asset, updated);
    }

    /// @notice Swaps the price source (e.g. FixedPriceOracle -> priority-2 multi-source oracle).
    /// @dev The new oracle must price the debt asset and every listed collateral before it is accepted.
    function setOracle(IPriceOracle newOracle) external onlyOwner {
        if (address(newOracle) == address(0)) revert ZeroAddress();
        IPriceOracle old = oracle;
        oracle = newOracle;
        _requirePrice(debtAsset);
        for (uint256 i; i < _listedAssets.length; ++i) {
            _requirePrice(_listedAssets[i]);
        }
        emit OracleUpdated(address(old), address(newOracle));
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ICollateralManager
    function getAssetConfig(address asset) external view returns (AssetConfig memory) {
        return _configs[asset];
    }

    /// @inheritdoc ICollateralManager
    function getListedAssets() external view returns (address[] memory) {
        return _listedAssets;
    }

    /// @inheritdoc ICollateralManager
    function getPrice(address asset) public view returns (uint256 price) {
        price = oracle.getPrice(asset);
        if (price == 0) revert InvalidPrice(asset);
    }

    /// @inheritdoc ICollateralManager
    /// @dev Health checks always value debt at the $1 face value (see CreditLendPool). This lower,
    ///      market-based price is only used to size liquidation seizures, so a liquidator who buys
    ///      discounted $CREDIT on the order book is not paid a windfall out of the borrower's
    ///      collateral. Clamped to the $1 face value so a manipulated high price can't over-seize.
    function getDebtSettlementPrice() external view returns (uint256 price) {
        price = getPrice(debtAsset);
        if (price > DEBT_FACE_VALUE) price = DEBT_FACE_VALUE;
    }

    /// @inheritdoc ICollateralManager
    function collateralValue(address asset, uint256 amount)
        external
        view
        returns (uint256 value, uint256 borrowPower, uint256 liqValue)
    {
        AssetConfig memory cfg = _configs[asset];
        if (!cfg.listed) revert NotListed();
        if (amount == 0) return (0, 0, 0);
        value = LiquidationLogic.toValue(amount, getPrice(asset), cfg.decimals, Math.Rounding.Floor);
        borrowPower = value.mulDiv(cfg.ltvBps, BPS);
        liqValue = value.mulDiv(cfg.liqThresholdBps, BPS);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    /// @dev Invariants enforced on every config:
    ///      - LTV < liquidation threshold: a fresh max borrow is never immediately liquidatable.
    ///      - LT * (1 + bonus) <= 100%: at HF = 1 the collateral still covers repaid debt plus bonus,
    ///        so liquidations don't create bad debt.
    function _validate(AssetConfig memory cfg) private pure {
        if (cfg.liqThresholdBps == 0 || cfg.liqThresholdBps > MAX_LIQ_THRESHOLD_BPS) revert InvalidConfig();
        if (cfg.ltvBps >= cfg.liqThresholdBps) revert InvalidConfig();
        if (cfg.liqBonusBps < MIN_LIQ_BONUS_BPS || cfg.liqBonusBps > MAX_LIQ_BONUS_BPS) revert InvalidConfig();
        if (uint256(cfg.liqThresholdBps) * (BPS + cfg.liqBonusBps) > BPS * BPS) revert InvalidConfig();
    }

    function _requirePrice(address asset) private view {
        getPrice(asset);
    }
}
