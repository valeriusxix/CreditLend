// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./BaseTest.sol";
import {ChainlinkStablecoinOracle, IChainlinkAggregator} from "../src/oracle/ChainlinkStablecoinOracle.sol";
import {CreditPriceOracle} from "../src/oracle/CreditPriceOracle.sol";
import {MockOrbioExchange} from "./mocks/OracleMocks.sol";

contract MockAggregator is IChainlinkAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    bool public broken;

    constructor(uint8 d) {
        decimals = d;
    }

    function set(int256 a, uint256 t) external {
        (answer, updatedAt) = (a, t);
    }

    function breakIt() external {
        broken = true;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// AUDIT.md M-3: USDG priced from Chainlink (capped at $1, $1 when the feed can't be trusted).
contract ChainlinkStablecoinOracleTest is BaseTest {
    MockAggregator feed;
    ChainlinkStablecoinOracle usdgOracle;

    function setUp() public override {
        super.setUp();
        feed = new MockAggregator(8);
        feed.set(1e8, block.timestamp);
        usdgOracle = new ChainlinkStablecoinOracle(address(usdg), feed, 25 hours);
    }

    function test_freshDepeg_isUsed() public {
        feed.set(0.97e8, block.timestamp);
        assertEq(usdgOracle.getPrice(address(usdg)), 0.97e18);
    }

    function test_aboveOneDollar_isCapped() public {
        feed.set(1.02e8, block.timestamp);
        assertEq(usdgOracle.getPrice(address(usdg)), 1e18);
    }

    function test_untrustworthyFeed_fallsBackToOneDollar() public {
        feed.set(0.5e8, block.timestamp - 25 hours - 1); // stale
        assertEq(usdgOracle.getPrice(address(usdg)), 1e18, "stale");
        feed.set(0, block.timestamp);
        assertEq(usdgOracle.getPrice(address(usdg)), 1e18, "zero");
        feed.set(-1, block.timestamp);
        assertEq(usdgOracle.getPrice(address(usdg)), 1e18, "negative");
        feed.set(0.5e8, block.timestamp + 1);
        assertEq(usdgOracle.getPrice(address(usdg)), 1e18, "future-dated");
        feed.breakIt();
        assertEq(usdgOracle.getPrice(address(usdg)), 1e18, "reverting feed");
    }

    function test_otherAsset_reverts_andBadConstructorArgs() public {
        vm.expectRevert(abi.encodeWithSelector(ChainlinkStablecoinOracle.PriceUnavailable.selector, address(orbio)));
        usdgOracle.getPrice(address(orbio));
        MockAggregator tooPrecise = new MockAggregator(19);
        vm.expectRevert(ChainlinkStablecoinOracle.InvalidParameter.selector);
        new ChainlinkStablecoinOracle(address(usdg), tooPrecise, 25 hours);
        vm.expectRevert(ChainlinkStablecoinOracle.InvalidParameter.selector);
        new ChainlinkStablecoinOracle(address(usdg), feed, 0);
    }

    /// End to end: wired in as the CREDIT oracle's base, a depeg makes an over-borrowed USDG position
    /// liquidatable, where the old fixed $1 price never could.
    function test_depeg_makesPositionLiquidatable() public {
        MockOrbioExchange book = new MockOrbioExchange(address(credit));
        CreditPriceOracle po = new CreditPriceOracle(book, usdgOracle, 5_000e6, 5 minutes, 1 hours, 2 hours, 2_500, 200);
        // The test fixture also lists ORBIO, which setOracle requires a price for; give it one.
        vm.mockCall(address(usdgOracle), abi.encodeCall(usdgOracle.getPrice, (address(orbio))), abi.encode(0.5e18));
        vm.prank(owner);
        cm.setOracle(po);

        _lend(lender, 10_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 690 * ONE_CREDIT);
        assertGt(_healthFactor(borrower), 1e18);

        feed.set(0.80e8, block.timestamp); // USDG depegs 20%
        assertLt(_healthFactor(borrower), 1e18, "now liquidatable: 1000 * 0.80 * 0.8 / 690 < 1");
        (uint256 repaid,) = _liquidate(borrower, address(usdg), 345 * ONE_CREDIT);
        assertGt(repaid, 0);
    }
}
