import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "collect-market-history.py"
SPEC = importlib.util.spec_from_file_location("plutus_market_collector", SCRIPT)
COLLECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COLLECTOR)


class MarketHistoryCollectorTests(unittest.TestCase):
    def test_unweighted_median_cannot_be_moved_by_fake_volume(self):
        # Kraken 100, Coinbase 101, malicious venue 3 with huge volume.
        self.assertEqual(COLLECTOR.median([100.0, 101.0, 3.0]), 100.0)

    def test_outlier_filter_uses_unweighted_reference(self):
        prices = [100.0, 101.0, 3.0]
        reference = COLLECTOR.median(prices)
        accepted = [price for price in prices if abs(price / reference - 1) <= COLLECTOR.MAX_DEVIATION]
        self.assertEqual(accepted, [100.0, 101.0])

    def test_weighted_median_respects_volume_after_outlier_filter(self):
        self.assertEqual(COLLECTOR.weighted_median([(100.0, 1.0), (101.0, 50.0)]), 101.0)

    def test_weighted_median_handles_empty_input(self):
        self.assertIsNone(COLLECTOR.weighted_median([]))

    def test_single_exchange_is_not_enough_to_publish(self):
        self.assertLess(1, COLLECTOR.MIN_INDEPENDENT_EXCHANGES)

    def test_market_count_is_limited_per_asset(self):
        self.assertEqual(COLLECTOR.MAX_MARKETS_PER_ASSET, 5)

    def test_symbol_list_is_read_from_the_application_map(self):
        symbols = COLLECTOR.symbols_from_app()
        self.assertIn("BTC", symbols)
        self.assertIn("ADA", symbols)
        self.assertIn("XMR", symbols)
        self.assertEqual(len(symbols), len(set(symbols)))


if __name__ == "__main__":
    unittest.main()
