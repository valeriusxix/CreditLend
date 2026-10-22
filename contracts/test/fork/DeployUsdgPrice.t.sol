// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {CollateralManager} from "../../src/CollateralManager.sol";

/// AUDIT.md M-3: after the real deployment, a USDG depeg reported by Chainlink's USDG/USD feed on
/// Robinhood Chain must reach the market. Needs network: FOUNDRY_PROFILE=fork forge test.
contract DeployUsdgPriceForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // Chainlink "USDG / USD" on Robinhood Chain (reference-data-directory feeds-robinhood-mainnet.json), 8 decimals.
    address constant USDG_USD_FEED = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;

    function _deploy() internal returns (CollateralManager cm) {
        vm.createSelectFork("robinhood");
        vm.setEnv("ADMIN_MULTISIG", vm.toString(address(0xA11CE)));
        vm.setEnv("GUARDIAN", vm.toString(address(0x6A2D)));
        vm.setEnv("AGENT", vm.toString(address(0)));
        Deploy script = new Deploy();
        script.run();
        (, cm,) = script.deployed();
    }

    function _feedSays(int256 answer8, uint256 updatedAt) internal {
        vm.mockCall(
            USDG_USD_FEED,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), answer8, updatedAt, updatedAt, uint80(1))
        );
    }

    function test_fork_usdgDepeg_reachesTheMarket() public {
        CollateralManager cm = _deploy();
        assertApproxEqRel(cm.getPrice(USDG), 1e18, 0.01e18, "live USDG price near one dollar");

        _feedSays(0.40e8, block.timestamp); // USDG depegs to $0.40
        assertEq(cm.getPrice(USDG), 0.40e18, "the market sees the depeg");
    }

    function test_fork_usdgFeedStale_fallsBackToOneDollar() public {
        CollateralManager cm = _deploy();
        _feedSays(0.40e8, block.timestamp - 26 hours); // older than heartbeat + 1 hour
        assertEq(cm.getPrice(USDG), 1e18, "an outage is never worse than the old fixed price");
    }
}
