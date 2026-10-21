// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {IOrbioExchange} from "../interfaces/IOrbioExchange.sol";

/// @title CreditPriceOracle
/// @notice Build priority 2: the $CREDIT settlement price from the Orbio order book, with circuit
///         breakers. Every other asset is passed through to `baseOracle` (e.g. USDG fixed at $1).
///
///         The price is used ONLY to size liquidation seizures (health checks always value debt at
///         the $1 face value in CreditLendPool). For that use, a price that is too LOW is the
///         dangerous direction: liquidators stop being paid enough, liquidations stop and bad debt
///         builds up. So every fallback and clamp below moves the price UP toward $1, never down.
///
/// @dev    HOW A READING IS TAKEN (`update`, permissionless; the agent calls it from priority 3)
///         1. Ask the book what buying `referenceSize` CREDIT costs right now, INCLUDING Orbio's
///            buyer fee (the real all-in cost a liquidator pays). Price = cost / CREDIT, capped at $1.
///         2. Circuit breakers:
///            - Too soon:   readings must be at least `minInterval` apart (reverts).
///            - Incomplete: the quote didn't fill the whole size (thin book or the 64-order work
///                          limit). Rejected; nothing recorded.
///            - Divergent:  the reading is more than `maxDeviationBps` away from the PREVIOUS raw
///                          reading. Rejected, but remembered: an identical reading next time is
///                          accepted. A one-off spike (e.g. fake asks placed and cancelled in one
///                          transaction) is thrown away; a real move is confirmed one interval later.
///                          It compares reading-to-reading, not reading-to-our-average, so it can
///                          never lock the oracle onto a stale price.
///            - Speed limit: the recorded price may fall at most `maxDropBpsPerHour` per hour.
///                          Rises are not limited (up to $1). Faking a low price is free on this
///                          book; faking a high one costs real purchases.
///         3. Record the observation.
///
///         HOW THE PRICE IS READ (`getPrice`, view, stored state only)
///         - Time-weighted average of recorded observations over the last `twapWindow`.
///         - Stale: no recorded observation within `maxStaleness` -> $1 face value.
///         - After staleness (and at deployment) the history restarts from the $1 reference and
///           comes down under the speed limit. Warm-up from $1 to ~$0.55 takes ~30 hours at 2%/h.
///
///         Liquidations call `getPrice`, which never touches the live book, so nobody can move the
///         book and liquidate in the same transaction.
///
///         RESIDUAL RISK (documented in README): someone who wins EVERY reading slot with fake asks
///         can still drag the recorded price down by up to `maxDropBpsPerHour` per hour.
contract CreditPriceOracle is IPriceOracle {
    using Math for uint256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @notice $1, the ceiling of the $CREDIT price and the safe fallback.
    uint256 public constant FACE_VALUE = 1e18;

    /// @notice Orbio's per-quote work limit (OrbioExchange.MAX_FILLS).
    uint256 public constant MAX_FILLS = 64;

    /// @notice Size of the observation ring buffer.
    uint256 public constant CAPACITY = 16;

    IOrbioExchange public immutable exchange;
    address public immutable credit;
    IPriceOracle public immutable baseOracle;

    uint256 public immutable referenceSize;
    uint256 public immutable minInterval;
    uint256 public immutable twapWindow;
    uint256 public immutable maxStaleness;
    uint256 public immutable maxDeviationBps;
    uint256 public immutable maxDropBpsPerHour;

    struct Observation {
        uint64 timestamp;
        uint192 price; // WAD USD per whole CREDIT
    }

    /// @dev Ring buffer of recorded observations. `_newest` indexes the latest; `_count` how many are valid.
    Observation[CAPACITY] private _observations;
    uint256 private _newest;
    uint256 private _count;

    /// @notice Last complete reading, accepted or not (the divergence check compares against it).
    uint256 public lastRawPrice;
    uint256 public lastReadingTime;

    enum ReadingStatus {
        Accepted,
        Clamped, // accepted, but held up by the speed limit
        RejectedIncomplete,
        RejectedDivergent
    }

    event ReadingTaken(ReadingStatus indexed status, uint256 rawPrice, uint256 recordedPrice);
    event HistoryRestarted(uint256 timestamp);

    error ZeroAddress();
    error InvalidParameter();
    error TooSoon(uint256 nextAllowed);

    constructor(
        IOrbioExchange exchange_,
        IPriceOracle baseOracle_,
        uint256 referenceSize_,
        uint256 minInterval_,
        uint256 twapWindow_,
        uint256 maxStaleness_,
        uint256 maxDeviationBps_,
        uint256 maxDropBpsPerHour_
    ) {
        if (address(exchange_) == address(0) || address(baseOracle_) == address(0)) revert ZeroAddress();
        if (referenceSize_ == 0 || minInterval_ == 0) revert InvalidParameter();
        // The buffer must hold a full averaging window plus the observation that straddles its start.
        if (twapWindow_ < minInterval_ || twapWindow_ / minInterval_ + 1 > CAPACITY) revert InvalidParameter();
        if (maxStaleness_ < twapWindow_) revert InvalidParameter();
        if (maxDeviationBps_ == 0 || maxDeviationBps_ >= BPS) revert InvalidParameter();
        if (maxDropBpsPerHour_ == 0 || maxDropBpsPerHour_ >= BPS) revert InvalidParameter();

        exchange = exchange_;
        credit = exchange_.credit();
        baseOracle = baseOracle_;
        referenceSize = referenceSize_;
        minInterval = minInterval_;
        twapWindow = twapWindow_;
        maxStaleness = maxStaleness_;
        maxDeviationBps = maxDeviationBps_;
        maxDropBpsPerHour = maxDropBpsPerHour_;
    }

    // ---------------------------------------------------------------------------------------------
    // Reading
    // ---------------------------------------------------------------------------------------------

    /// @notice Takes one reading of the order book. Anyone may call it, at most once per `minInterval`.
    function update() external returns (ReadingStatus status, uint256 recordedPrice) {
        if (lastReadingTime != 0 && block.timestamp < lastReadingTime + minInterval) {
            revert TooSoon(lastReadingTime + minInterval);
        }
        lastReadingTime = block.timestamp;

        IOrbioExchange.Quote memory q = exchange.getQuoteForCredit(referenceSize, MAX_FILLS);
        if (q.reason != IOrbioExchange.StopReason.TargetReached || q.creditOut < referenceSize) {
            emit ReadingTaken(ReadingStatus.RejectedIncomplete, 0, 0);
            return (ReadingStatus.RejectedIncomplete, 0);
        }

        // All-in cost per CREDIT (USDG and CREDIT both have 6 decimals; USDG taken as $1).
        // Rounded up: the safe direction.
        uint256 raw = (q.usdgSpent + q.feeAtoms).mulDiv(WAD, q.creditOut, Math.Rounding.Ceil);
        if (raw > FACE_VALUE) raw = FACE_VALUE;
        if (raw == 0) raw = 1;

        uint256 previousRaw = lastRawPrice;
        lastRawPrice = raw;
        if (previousRaw != 0 && _diffBps(raw, previousRaw) > maxDeviationBps) {
            emit ReadingTaken(ReadingStatus.RejectedDivergent, raw, 0);
            return (ReadingStatus.RejectedDivergent, 0);
        }

        // Speed limit relative to the latest recorded price, or to $1 if the history is stale/empty.
        uint256 refPrice;
        uint256 elapsed;
        if (_isFresh()) {
            Observation memory last = _observations[_newest];
            refPrice = last.price;
            elapsed = block.timestamp - last.timestamp;
        } else {
            if (_count != 0) {
                _count = 0;
                emit HistoryRestarted(block.timestamp);
            }
            refPrice = FACE_VALUE;
            elapsed = 1 hours;
        }
        if (elapsed > 1 hours) elapsed = 1 hours;
        uint256 floor = refPrice.mulDiv(BPS * 1 hours - maxDropBpsPerHour * elapsed, BPS * 1 hours, Math.Rounding.Ceil);

        status = ReadingStatus.Accepted;
        recordedPrice = raw;
        if (recordedPrice < floor) {
            recordedPrice = floor;
            status = ReadingStatus.Clamped;
        }

        _record(recordedPrice);
        emit ReadingTaken(status, raw, recordedPrice);
    }

    // ---------------------------------------------------------------------------------------------
    // Pricing
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IPriceOracle
    /// @dev $CREDIT never reverts: stale or empty history returns the $1 face value. Other assets
    ///      are delegated to `baseOracle` and revert if it does.
    function getPrice(address asset) external view returns (uint256) {
        if (asset != credit) return baseOracle.getPrice(asset);
        if (!_isFresh()) return FACE_VALUE;
        uint256 twap = _twap();
        return twap > FACE_VALUE ? FACE_VALUE : twap;
    }

    /// @notice True when the $CREDIT price comes from recent order-book readings rather than the fallback.
    function isFresh() external view returns (bool) {
        return _isFresh();
    }

    /// @notice Latest recorded observation (timestamp 0 if none).
    function latestObservation() external view returns (uint256 timestamp, uint256 price) {
        if (_count == 0) return (0, 0);
        Observation memory o = _observations[_newest];
        return (o.timestamp, o.price);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _isFresh() internal view returns (bool) {
        return _count != 0 && block.timestamp - _observations[_newest].timestamp <= maxStaleness;
    }

    function _record(uint256 price) internal {
        _newest = _count == 0 ? 0 : (_newest + 1) % CAPACITY;
        _observations[_newest] = Observation({timestamp: uint64(block.timestamp), price: uint192(price)});
        if (_count < CAPACITY) ++_count;
    }

    /// @dev Each observation holds until the next one; the newest holds until now. Rounded up.
    function _twap() internal view returns (uint256) {
        uint256 windowStart = block.timestamp > twapWindow ? block.timestamp - twapWindow : 0;
        uint256 end = block.timestamp;
        uint256 weighted;
        uint256 covered;
        uint256 idx = _newest;
        for (uint256 i; i < _count; ++i) {
            Observation memory o = _observations[idx];
            uint256 start = o.timestamp > windowStart ? o.timestamp : windowStart;
            if (end > start) {
                weighted += uint256(o.price) * (end - start);
                covered += end - start;
            }
            if (o.timestamp <= windowStart) break;
            end = o.timestamp;
            idx = idx == 0 ? CAPACITY - 1 : idx - 1;
        }
        if (covered == 0) return _observations[_newest].price; // reading taken in this very block
        return weighted.ceilDiv(covered);
    }

    function _diffBps(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 diff = a > b ? a - b : b - a;
        return diff.mulDiv(BPS, b);
    }
}
