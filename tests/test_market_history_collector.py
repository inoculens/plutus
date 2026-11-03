import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "collect-market-history.py"
SPEC = importlib.util.spec_from_file_location("plutus_market_collector", SCRIPT)
COLLECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COLLECTOR)


class MarketHistoryCollectorTests(unittest.TestCase):
    def test_weighted_median_rejects_extreme_unweighted_outlier(self):
        self.assertEqual(COLLECTOR.weighted_median([(10.0, 1.0), (11.0, 1.0), (900.0, 1.0)]), 11.0)

    def test_weighted_median_respects_quote_volume(self):
        self.assertEqual(COLLECTOR.weighted_median([(10.0, 1.0), (11.0, 50.0), (12.0, 1.0)]), 11.0)

    def test_weighted_median_handles_empty_input(self):
        self.assertIsNone(COLLECTOR.weighted_median([]))

    def test_symbol_list_is_read_from_the_application_map(self):
        symbols = COLLECTOR.symbols_from_app()
        self.assertIn("BTC", symbols)
        self.assertIn("ADA", symbols)
        self.assertIn("XMR", symbols)
        self.assertEqual(len(symbols), len(set(symbols)))


if __name__ == "__main__":
    unittest.main()
