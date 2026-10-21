// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ICollateralManager} from "./interfaces/ICollateralManager.sol";
import {IInterestRateModel} from "./interfaces/IInterestRateModel.sol";
import {LiquidationLogic} from "./libraries/LiquidationLogic.sol";

/// @title CreditLendPool
/// @notice Fully collateralized $CREDIT lending market on Robinhood Chain (AGENT.md §4.1).
///
///         Lenders deposit $CREDIT and receive cCREDIT (ERC-4626 shares) whose value grows as
///         borrowers pay interest. Borrowers post collateral (USDG in v1) and borrow $CREDIT.
///
/// @dev    CORE DESIGN DECISIONS
///
///         1. Borrowed $CREDIT is CONSUMED (decision A). Once it leaves the pool it may be activated
///            (burned into API balance), sold or transferred, and the pool does not try to tell which.
///            Lenders are protected only by collateral: every borrow must be overcollateralized and
///            anyone may liquidate a position whose health factor drops below 1. Liquidators repay
///            with fungible $CREDIT from the market, never "the same tokens".
///
///         2. Debt is ALWAYS valued at the $1 face value for health checks (decision 2). That is the
///            conservative ceiling for $CREDIT, and it needs no oracle on the debt side. A market-based
///            settlement price (clamped to <= $1) is used only to size liquidation seizures.
///
///         3. Interest accrues in $CREDIT (decision 3) through a global borrow index and is shared
///            between lenders (via the share price) and protocol reserves (reserve factor).
///
///         4. Single custody: this contract holds ALL funds. CollateralManager (config/valuation),
///            InterestRateModel (rate curve) and LiquidationLogic (math) hold none.
///
///         5. Internal accounting: `cash` and `totalCollateral` are tracked internally, never read from
///            balanceOf, so donations can't move the share price or valuations. That also defeats the
///            ERC-4626 inflation attack, together with a 6-decimal virtual share offset.
///
///         6. Pausing only blocks actions that ADD risk (lender deposits, borrows, collateral deposits).
///            Repay, liquidate, lender withdrawals and collateral withdrawals can never be paused.
contract CreditLendPool is ERC4626, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @notice USD value of one $CREDIT used for every health / borrow-power check.
    uint256 public constant DEBT_FACE_VALUE = 1e18;

    /// @notice Defensive ceiling on the per-second rate the pool will accrue (~1000% APR),
    ///         independent of the configured model.
    uint256 public constant MAX_BORROW_RATE_PER_SECOND = uint256(10e18) / 365 days;

    uint256 public constant MAX_RESERVE_FACTOR_BPS = 5_000;
    uint256 public constant MAX_UTILIZATION_CAP_BPS = 9_900;

    // ---------------------------------------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------------------------------------

    /// @notice The $CREDIT token (the lent and borrowed asset).
    IERC20 public immutable credit;
    uint8 public immutable creditDecimals;

    ICollateralManager public immutable collateralManager;

    // ---------------------------------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------------------------------

    IInterestRateModel public interestRateModel;

    /// @notice May pause risk-increasing actions. Cannot unpause, move funds or change parameters.
    address public guardian;

    /// @notice Share of accrued interest kept as protocol reserves (first-loss bad-debt buffer).
    uint256 public reserveFactorBps;

    /// @notice New borrows are rejected if they would push utilization above this.
    ///         Keeps a liquidity buffer for lender withdrawals (thin $CREDIT liquidity, AGENT.md §8).
    uint256 public maxUtilizationBps;

    /// @notice Minimum debt a borrow may leave. Also the dust level at which a liquidation may close
    ///         a position in full.
    uint256 public minDebt;

    bool public depositsPaused;
    bool public borrowsPaused;
    bool public collateralDepositsPaused;

    // ---------------------------------------------------------------------------------------------
    // Market state (all amounts in $CREDIT base units unless noted)
    // ---------------------------------------------------------------------------------------------

    /// @notice $CREDIT held by the pool according to internal accounting.
    uint256 public cash;
    /// @notice Outstanding debt of all borrowers, including accrued interest.
    uint256 public totalBorrows;
    /// @notice Part of pool assets owned by the protocol rather than lenders.
    uint256 public totalReserves;
    /// @notice Cumulative borrow interest index, WAD-scaled, starting at 1e18.
    uint256 public borrowIndex;
    uint256 public lastAccrualTimestamp;

    struct BorrowSnapshot {
        uint256 principal; // debt at the time of the last update
        uint256 index; // borrowIndex at the time of the last update
    }

    mapping(address borrower => BorrowSnapshot) private _borrows;

    /// @notice Collateral balances held for each borrower (token base units).
    mapping(address borrower => mapping(address asset => uint256)) public collateralOf;
    mapping(address asset => uint256) public totalCollateral;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event InterestAccrued(uint256 interest, uint256 borrowIndex, uint256 totalBorrows, uint256 totalReserves);
    event CollateralDeposited(address indexed payer, address indexed onBehalfOf, address indexed asset, uint256 amount);
    event CollateralWithdrawn(address indexed borrower, address indexed to, address indexed asset, uint256 amount);
    event Borrowed(address indexed borrower, uint256 amount, uint256 newDebt);
    event Repaid(address indexed payer, address indexed borrower, uint256 amount, uint256 remainingDebt);
    event Liquidated(
        address indexed liquidator,
        address indexed borrower,
        address indexed collateralAsset,
        uint256 debtRepaid,
        uint256 collateralSeized,
        uint256 healthFactorBefore
    );
    event BadDebtRealized(address indexed borrower, uint256 amount, uint256 coveredByReserves, uint256 lenderLoss);
    event ReservesReduced(address indexed to, uint256 amount);
    event InterestRateModelUpdated(address indexed oldModel, address indexed newModel);
    event ReserveFactorUpdated(uint256 reserveFactorBps);
    event MaxUtilizationUpdated(uint256 maxUtilizationBps);
    event MinDebtUpdated(uint256 minDebt);
    event GuardianUpdated(address indexed guardian);
    event PauseStateUpdated(bool depositsPaused, bool borrowsPaused, bool collateralDepositsPaused);
    event Skimmed(address indexed token, address indexed to, uint256 amount);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error ActionPaused();
    error NotGuardianOrOwner();
    error InvalidParameter();
    error InsufficientLiquidity();
    error InsufficientCollateral();
    error InsufficientCollateralBalance();
    error UtilizationCapExceeded();
    error DebtBelowMinimum();
    error NoDebt();
    error PositionHealthy();
    error AssetNotAccepted();
    error SupplyCapExceeded();
    error LiquidationTooSmall();
    error SlippageExceeded();
    error UnexpectedTransferAmount();
    error ZeroShares();

    // ---------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------

    constructor(
        IERC20Metadata credit_,
        ICollateralManager collateralManager_,
        IInterestRateModel interestRateModel_,
        address owner_,
        address guardian_,
        uint256 reserveFactorBps_,
        uint256 maxUtilizationBps_,
        uint256 minDebt_
    ) ERC20("CreditLend CREDIT", "cCREDIT") ERC4626(credit_) Ownable(owner_) {
        if (
            address(credit_) == address(0) || address(collateralManager_) == address(0)
                || address(interestRateModel_) == address(0)
        ) revert ZeroAddress();
        if (collateralManager_.debtAsset() != address(credit_)) revert InvalidParameter();
        if (reserveFactorBps_ > MAX_RESERVE_FACTOR_BPS) revert InvalidParameter();
        if (maxUtilizationBps_ == 0 || maxUtilizationBps_ > MAX_UTILIZATION_CAP_BPS) revert InvalidParameter();

        credit = credit_;
        creditDecimals = credit_.decimals();
        collateralManager = collateralManager_;
        interestRateModel = interestRateModel_;
        guardian = guardian_;
        reserveFactorBps = reserveFactorBps_;
        maxUtilizationBps = maxUtilizationBps_;
        minDebt = minDebt_;

        borrowIndex = WAD;
        lastAccrualTimestamp = block.timestamp;
    }

    // ---------------------------------------------------------------------------------------------
    // Interest accrual
    // ---------------------------------------------------------------------------------------------

    /// @notice Brings the market up to date. Called automatically by every state-changing action.
    function accrueInterest() public {
        if (block.timestamp == lastAccrualTimestamp) return;
        (uint256 newBorrows, uint256 newReserves, uint256 newIndex, uint256 interest) = _pendingAccrual();
        totalBorrows = newBorrows;
        totalReserves = newReserves;
        borrowIndex = newIndex;
        lastAccrualTimestamp = block.timestamp;
        if (interest > 0) emit InterestAccrued(interest, newIndex, newBorrows, newReserves);
    }

    /// @dev Simple (linear) interest over the elapsed interval, compounded at each accrual. Shared by
    ///      `accrueInterest` and the view functions so previews exactly match execution.
    function _pendingAccrual()
        internal
        view
        returns (uint256 newBorrows, uint256 newReserves, uint256 newIndex, uint256 interest)
    {
        uint256 elapsed = block.timestamp - lastAccrualTimestamp;
        if (elapsed == 0 || totalBorrows == 0) return (totalBorrows, totalReserves, borrowIndex, 0);

        uint256 rate = interestRateModel.borrowRatePerSecond(cash, totalBorrows, totalReserves);
        if (rate > MAX_BORROW_RATE_PER_SECOND) rate = MAX_BORROW_RATE_PER_SECOND;

        uint256 factor = rate * elapsed; // WAD
        interest = totalBorrows.mulDiv(factor, WAD);
        newBorrows = totalBorrows + interest;
        newReserves = totalReserves + interest.mulDiv(reserveFactorBps, BPS);
        newIndex = borrowIndex + borrowIndex.mulDiv(factor, WAD);
    }

    // ---------------------------------------------------------------------------------------------
    // Lender side (ERC-4626)
    // ---------------------------------------------------------------------------------------------

    /// @notice $CREDIT owed to lenders: cash + outstanding borrows - protocol reserves, accrued to now.
    function totalAssets() public view override returns (uint256) {
        (uint256 borrows, uint256 reserves,,) = _pendingAccrual();
        return _lenderAssets(cash, borrows, reserves);
    }

    function maxDeposit(address) public view override returns (uint256) {
        return depositsPaused ? 0 : type(uint256).max;
    }

    function maxMint(address) public view override returns (uint256) {
        return depositsPaused ? 0 : type(uint256).max;
    }

    /// @notice Withdrawals are limited by the $CREDIT actually sitting in the pool.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        uint256 owned = _convertToAssets(balanceOf(owner_), Math.Rounding.Floor);
        return owned < cash ? owned : cash;
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        uint256 shares = balanceOf(owner_);
        uint256 liquidShares = _convertToShares(cash, Math.Rounding.Floor);
        return shares < liquidShares ? shares : liquidShares;
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        accrueInterest();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        accrueInterest();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256)
    {
        accrueInterest();
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_) public override nonReentrant returns (uint256) {
        accrueInterest();
        return super.redeem(shares, receiver, owner_);
    }

    /// @dev Shares are worth 1e6 times less than a $CREDIT base unit (12 decimals total), which makes
    ///      first-depositor share inflation uneconomic.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (assets == 0 || shares == 0) revert ZeroShares();
        _pullExact(credit, caller, assets);
        cash += assets;
        _mint(receiver, shares);
        emit Deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        if (assets == 0) revert ZeroAmount();
        if (assets > cash) revert InsufficientLiquidity();
        if (caller != owner_) _spendAllowance(owner_, caller, shares);
        _burn(owner_, shares);
        cash -= assets;
        credit.safeTransfer(receiver, assets);
        emit Withdraw(caller, receiver, owner_, assets, shares);
    }

    // ---------------------------------------------------------------------------------------------
    // Collateral
    // ---------------------------------------------------------------------------------------------

    /// @notice Deposits collateral for `onBehalfOf`. Anyone may top up anyone's collateral.
    function depositCollateral(address asset, uint256 amount, address onBehalfOf) external nonReentrant {
        if (collateralDepositsPaused) revert ActionPaused();
        if (amount == 0) revert ZeroAmount();
        if (onBehalfOf == address(0)) revert ZeroAddress();

        ICollateralManager.AssetConfig memory cfg = collateralManager.getAssetConfig(asset);
        if (!cfg.listed || !cfg.depositsEnabled) revert AssetNotAccepted();
        if (totalCollateral[asset] + amount > cfg.supplyCap) revert SupplyCapExceeded();

        collateralOf[onBehalfOf][asset] += amount;
        totalCollateral[asset] += amount;
        _pullExact(IERC20(asset), msg.sender, amount);

        emit CollateralDeposited(msg.sender, onBehalfOf, asset, amount);
    }

    /// @notice Withdraws collateral. While in debt, the remaining borrow power (LTV-weighted, stricter
    ///         than the liquidation threshold) must still cover the debt.
    /// @param amount Token amount, or type(uint256).max for the full balance.
    function withdrawCollateral(address asset, uint256 amount, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        accrueInterest();

        uint256 balance = collateralOf[msg.sender][asset];
        if (amount == type(uint256).max) amount = balance;
        if (amount == 0) revert ZeroAmount();
        if (amount > balance) revert InsufficientCollateralBalance();

        collateralOf[msg.sender][asset] = balance - amount;
        totalCollateral[asset] -= amount;

        uint256 debt = _debtOf(msg.sender, borrowIndex);
        if (debt > 0) {
            (uint256 borrowPower,) = _collateralValues(msg.sender);
            if (borrowPower < _debtValue(debt)) revert InsufficientCollateral();
        }

        IERC20(asset).safeTransfer(to, amount);
        emit CollateralWithdrawn(msg.sender, to, asset, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Borrow / repay
    // ---------------------------------------------------------------------------------------------

    /// @notice Borrows $CREDIT to msg.sender. From this moment the tokens are treated as consumed.
    function borrow(uint256 amount) external nonReentrant {
        if (borrowsPaused) revert ActionPaused();
        if (amount == 0) revert ZeroAmount();
        accrueInterest();

        if (amount > cash) revert InsufficientLiquidity();

        uint256 newDebt = _debtOf(msg.sender, borrowIndex) + amount;
        if (newDebt < minDebt) revert DebtBelowMinimum();

        // A borrow moves cash into borrows, so lender assets stay the same.
        uint256 newTotalBorrows = totalBorrows + amount;
        uint256 lenderAssets = _lenderAssets(cash, totalBorrows, totalReserves);
        if (newTotalBorrows * BPS > lenderAssets * maxUtilizationBps) revert UtilizationCapExceeded();

        _borrows[msg.sender] = BorrowSnapshot({principal: newDebt, index: borrowIndex});
        totalBorrows = newTotalBorrows;
        cash -= amount;

        (uint256 borrowPower,) = _collateralValues(msg.sender);
        if (borrowPower < _debtValue(newDebt)) revert InsufficientCollateral();

        credit.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount, newDebt);
    }

    /// @notice Repays debt of `onBehalfOf` with $CREDIT from msg.sender. Never pausable.
    /// @param amount $CREDIT amount, or type(uint256).max for the full debt.
    /// @return repaid Amount actually repaid (capped at the outstanding debt).
    function repay(uint256 amount, address onBehalfOf) external nonReentrant returns (uint256 repaid) {
        if (amount == 0) revert ZeroAmount();
        accrueInterest();

        uint256 debt = _debtOf(onBehalfOf, borrowIndex);
        if (debt == 0) revert NoDebt();
        repaid = amount > debt ? debt : amount;

        _reduceDebt(onBehalfOf, debt, repaid);
        cash += repaid;
        _pullExact(credit, msg.sender, repaid);

        emit Repaid(msg.sender, onBehalfOf, repaid, debt - repaid);
    }

    // ---------------------------------------------------------------------------------------------
    // Liquidation (LiquidationEngine logic; permissionless, never pausable)
    // ---------------------------------------------------------------------------------------------

    /// @notice Repays part or all of an unhealthy borrower's debt and seizes collateral plus bonus.
    /// @param borrower         Position to liquidate (health factor must be < 1).
    /// @param collateralAsset  Collateral to receive.
    /// @param repayAmount      Max $CREDIT to repay; capped by the close factor and available collateral.
    /// @param minSeized        Slippage guard: revert if less collateral than this would be received.
    /// @return repaid  $CREDIT actually pulled from the liquidator.
    /// @return seized  Collateral sent to the liquidator.
    function liquidate(address borrower, address collateralAsset, uint256 repayAmount, uint256 minSeized)
        external
        nonReentrant
        returns (uint256 repaid, uint256 seized)
    {
        if (repayAmount == 0) revert ZeroAmount();
        accrueInterest();

        uint256 debt = _debtOf(borrower, borrowIndex);
        if (debt == 0) revert NoDebt();

        (, uint256 liqValue) = _collateralValues(borrower);
        uint256 hf = LiquidationLogic.healthFactor(liqValue, _debtValue(debt));
        if (hf >= WAD) revert PositionHealthy();

        uint256 available = collateralOf[borrower][collateralAsset];
        if (available == 0) revert InsufficientCollateralBalance();

        uint256 maxRepay = LiquidationLogic.maxRepayable(debt, hf, minDebt);
        ICollateralManager.AssetConfig memory cfg = collateralManager.getAssetConfig(collateralAsset);

        (repaid, seized) = LiquidationLogic.computeSeize(
            LiquidationLogic.SeizeParams({
                repayAmount: repayAmount < maxRepay ? repayAmount : maxRepay,
                debtPrice: collateralManager.getDebtSettlementPrice(),
                debtDecimals: creditDecimals,
                collateralPrice: collateralManager.getPrice(collateralAsset),
                collateralDecimals: cfg.decimals,
                bonusBps: cfg.liqBonusBps,
                availableCollateral: available
            })
        );
        if (repaid == 0 || seized == 0) revert LiquidationTooSmall();
        if (seized < minSeized) revert SlippageExceeded();

        // Effects
        _reduceDebt(borrower, debt, repaid);
        cash += repaid;
        collateralOf[borrower][collateralAsset] = available - seized;
        totalCollateral[collateralAsset] -= seized;

        // A position with debt but no collateral can never be repaid by liquidation: write it off.
        uint256 remaining = debt - repaid;
        if (remaining > 0 && !_hasCollateral(borrower)) _realizeBadDebt(borrower, remaining);

        // Interactions
        _pullExact(credit, msg.sender, repaid);
        IERC20(collateralAsset).safeTransfer(msg.sender, seized);

        emit Liquidated(msg.sender, borrower, collateralAsset, repaid, seized, hf);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Current debt of `borrower`, including interest accrued up to this block.
    function debtOf(address borrower) public view returns (uint256) {
        (,, uint256 index,) = _pendingAccrual();
        return _debtOf(borrower, index);
    }

    /// @notice Full risk snapshot of an account (values in WAD USD).
    function getAccountData(address borrower)
        external
        view
        returns (uint256 borrowPower, uint256 liqValue, uint256 debt, uint256 debtValue, uint256 healthFactor)
    {
        (borrowPower, liqValue) = _collateralValues(borrower);
        debt = debtOf(borrower);
        debtValue = _debtValue(debt);
        healthFactor = LiquidationLogic.healthFactor(liqValue, debtValue);
    }

    /// @notice Current utilization (WAD).
    function utilization() external view returns (uint256) {
        (uint256 borrows, uint256 reserves,,) = _pendingAccrual();
        return interestRateModel.utilization(cash, borrows, reserves);
    }

    /// @notice Current annual borrow rate (WAD).
    function borrowRatePerYear() public view returns (uint256) {
        (uint256 borrows, uint256 reserves,,) = _pendingAccrual();
        return interestRateModel.borrowRatePerYear(cash, borrows, reserves);
    }

    /// @notice Current annual rate earned by lenders (WAD): borrowRate * utilization * (1 - reserveFactor).
    function supplyRatePerYear() external view returns (uint256) {
        (uint256 borrows, uint256 reserves,,) = _pendingAccrual();
        uint256 lenderAssets = _lenderAssets(cash, borrows, reserves);
        if (lenderAssets == 0) return 0;
        uint256 rate = interestRateModel.borrowRatePerYear(cash, borrows, reserves);
        return rate.mulDiv(borrows, lenderAssets).mulDiv(BPS - reserveFactorBps, BPS);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin (owner = TimelockController; guardian = emergency pause only)
    // ---------------------------------------------------------------------------------------------

    /// @notice Swaps the rate model. Accrues first so the old rate applies up to this block.
    function setInterestRateModel(IInterestRateModel newModel) external onlyOwner {
        if (address(newModel) == address(0)) revert ZeroAddress();
        accrueInterest();
        newModel.borrowRatePerSecond(cash, totalBorrows, totalReserves); // sanity: must not revert
        emit InterestRateModelUpdated(address(interestRateModel), address(newModel));
        interestRateModel = newModel;
    }

    function setReserveFactor(uint256 newReserveFactorBps) external onlyOwner {
        if (newReserveFactorBps > MAX_RESERVE_FACTOR_BPS) revert InvalidParameter();
        accrueInterest();
        reserveFactorBps = newReserveFactorBps;
        emit ReserveFactorUpdated(newReserveFactorBps);
    }

    function setMaxUtilization(uint256 newMaxUtilizationBps) external onlyOwner {
        if (newMaxUtilizationBps == 0 || newMaxUtilizationBps > MAX_UTILIZATION_CAP_BPS) revert InvalidParameter();
        maxUtilizationBps = newMaxUtilizationBps;
        emit MaxUtilizationUpdated(newMaxUtilizationBps);
    }

    function setMinDebt(uint256 newMinDebt) external onlyOwner {
        minDebt = newMinDebt;
        emit MinDebtUpdated(newMinDebt);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    /// @notice Guardian or owner may PAUSE any risk-increasing action. Passing false leaves a flag as is.
    function pause(bool deposits_, bool borrows_, bool collateralDeposits_) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner();
        if (deposits_) depositsPaused = true;
        if (borrows_) borrowsPaused = true;
        if (collateralDeposits_) collateralDepositsPaused = true;
        emit PauseStateUpdated(depositsPaused, borrowsPaused, collateralDepositsPaused);
    }

    /// @notice Only the (timelocked) owner can unpause. Passing true clears a flag.
    function unpause(bool deposits_, bool borrows_, bool collateralDeposits_) external onlyOwner {
        if (deposits_) depositsPaused = false;
        if (borrows_) borrowsPaused = false;
        if (collateralDeposits_) collateralDepositsPaused = false;
        emit PauseStateUpdated(depositsPaused, borrowsPaused, collateralDepositsPaused);
    }

    /// @notice Withdraws protocol reserves. Can only use idle cash, never lender-owned assets.
    function reduceReserves(uint256 amount, address to) external nonReentrant onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        accrueInterest();
        if (amount == 0 || amount > totalReserves) revert InvalidParameter();
        if (amount > cash) revert InsufficientLiquidity();
        totalReserves -= amount;
        cash -= amount;
        credit.safeTransfer(to, amount);
        emit ReservesReduced(to, amount);
    }

    /// @notice Recovers tokens sent to the pool by mistake. It can only ever remove the EXCESS over
    ///         internal accounting, so tracked $CREDIT and collateral can't be touched.
    function skim(address token, address to) external nonReentrant onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 tracked = token == address(credit) ? cash : totalCollateral[token];
        if (balance <= tracked) revert ZeroAmount();
        uint256 excess = balance - tracked;
        IERC20(token).safeTransfer(to, excess);
        emit Skimmed(token, to, excess);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------------------------

    function _lenderAssets(uint256 cash_, uint256 borrows, uint256 reserves) internal pure returns (uint256) {
        uint256 gross = cash_ + borrows;
        return gross > reserves ? gross - reserves : 0;
    }

    /// @dev Rounds UP, in the protocol's favor.
    function _debtOf(address borrower, uint256 index) internal view returns (uint256) {
        BorrowSnapshot memory snap = _borrows[borrower];
        if (snap.principal == 0) return 0;
        return snap.principal.mulDiv(index, snap.index, Math.Rounding.Ceil);
    }

    /// @dev Debt is always valued at $1 face value (decision 2).
    function _debtValue(uint256 debt) internal view returns (uint256) {
        return LiquidationLogic.toValue(debt, DEBT_FACE_VALUE, creditDecimals, Math.Rounding.Ceil);
    }

    /// @dev Updates a borrower's snapshot after `amount` of their `debt` is paid off.
    function _reduceDebt(address borrower, uint256 debt, uint256 amount) internal {
        uint256 remaining = debt - amount;
        _borrows[borrower] = BorrowSnapshot({principal: remaining, index: remaining == 0 ? 0 : borrowIndex});
        // Per-account debt rounds up, so the sum can exceed totalBorrows by a few wei; saturate.
        totalBorrows = totalBorrows > amount ? totalBorrows - amount : 0;
    }

    /// @dev Writes off unrecoverable debt. Reserves absorb the loss first; any remainder lowers the
    ///      cCREDIT share price (socialized across lenders).
    function _realizeBadDebt(address borrower, uint256 amount) internal {
        delete _borrows[borrower];
        totalBorrows = totalBorrows > amount ? totalBorrows - amount : 0;
        uint256 covered = amount < totalReserves ? amount : totalReserves;
        totalReserves -= covered;
        emit BadDebtRealized(borrower, amount, covered, amount - covered);
    }

    /// @return borrowPower LTV-weighted collateral value (WAD USD).
    /// @return liqValue    Liquidation-threshold-weighted collateral value (WAD USD).
    /// @dev Only queries prices for assets the borrower actually holds. An asset whose price can't
    ///      be read counts as $0 instead of reverting, so one broken feed (or a sliver of such an
    ///      asset deposited on someone's behalf) can never freeze an account: borrowing and
    ///      withdrawing are judged on the collateral that CAN be priced, and liquidators can still
    ///      seize any priceable collateral. Counting it as $0 is the lender-safe direction.
    function _collateralValues(address borrower) internal view returns (uint256 borrowPower, uint256 liqValue) {
        address[] memory assets = collateralManager.getListedAssets();
        for (uint256 i; i < assets.length; ++i) {
            uint256 balance = collateralOf[borrower][assets[i]];
            if (balance == 0) continue;
            (, , uint256 bp, uint256 lv) = collateralManager.tryCollateralValue(assets[i], balance);
            borrowPower += bp;
            liqValue += lv;
        }
    }

    function _hasCollateral(address borrower) internal view returns (bool) {
        address[] memory assets = collateralManager.getListedAssets();
        for (uint256 i; i < assets.length; ++i) {
            if (collateralOf[borrower][assets[i]] > 0) return true;
        }
        return false;
    }

    /// @dev Pulls exactly `amount`, rejecting fee-on-transfer or otherwise non-standard behavior
    ///      (relevant because both $CREDIT and USDG are upgradeable proxies).
    function _pullExact(IERC20 token, address from, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - before != amount) revert UnexpectedTransferAmount();
    }
}
