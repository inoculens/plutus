import importlib.util
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "collect-market-history.py"
SPEC = importlib.util.spec_from_file_location("plutus_market_collector", SCRIPT)
COLLECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COLLECTOR)


class MarketHistoryCollectorTests(unittest.TestCase):
    def test_fake_volume_cannot_move_trusted_reference(self):
        rows = [
            (100.0, 1.0, "kraken"),
            (101.0, 50.0, "coinbase"),
            (3.0, 1000000000.0, "mexc"),
        ]
        accepted = COLLECTOR.filter_observations(rows, "BTC")
        self.assertEqual([row[0] for row in accepted], [100.0, 101.0])

    def test_long_tail_exchanges_cannot_establish_price_without_trusted_anchor(self):
        rows = [(100.0, 10.0, "mexc"), (101.0, 20.0, "htx")]
        self.assertEqual(COLLECTOR.filter_observations(rows, "BTC"), [])

    def test_all_assets_require_two_trusted_exchange_anchors(self):
        one_anchor = [(100.0, 10.0, "kraken"), (100.5, 20.0, "mexc")]
        two_anchors = one_anchor + [(101.0, 30.0, "kucoin")]
        self.assertEqual(COLLECTOR.filter_observations(one_anchor, "BTC"), [])
        self.assertEqual(len(COLLECTOR.filter_observations(two_anchors, "XMR")), 2)

    def test_outlier_filter_rejects_price_far_from_trusted_anchor(self):
        rows = [
            (100.0, 1.0, "kraken"),
            (101.0, 1.0, "coinbase"),
            (3.0, 1000000000.0, "mexc"),
        ]
        accepted = COLLECTOR.filter_observations(rows, "BTC")
        self.assertNotIn(3.0, [row[0] for row in accepted])


    def test_long_tail_venue_cannot_contribute_even_with_two_trusted_anchors(self):
        rows = [(100.0, 10.0, 'kraken'), (101.0, 20.0, 'coinbase'), (100.5, 1000000000.0, 'mexc')]
        accepted = COLLECTOR.filter_observations(rows, 'BTC')
        self.assertEqual({row[2] for row in accepted}, {'kraken', 'coinbase'})

    def test_one_trusted_exchange_plus_long_tail_is_not_enough(self):
        rows = [(100.0, 10.0, 'kraken'), (100.5, 20.0, 'mexc')]
        self.assertEqual(COLLECTOR.filter_observations(rows, 'BTC'), [])

    def test_market_identity_requires_normalized_base_and_native_id(self):
        self.assertTrue(COLLECTOR.market_matches_symbol({'base': 'BTC', 'baseId': 'BTC'}, 'BTC'))
        self.assertTrue(COLLECTOR.market_matches_symbol({'base': 'BTC', 'baseId': 'XBT'}, 'BTC'))
        self.assertFalse(COLLECTOR.market_matches_symbol({'base': 'BTC', 'baseId': 'OTHER'}, 'BTC'))
        self.assertFalse(COLLECTOR.market_matches_symbol({'base': 'BTC'}, 'BTC'))
        self.assertFalse(COLLECTOR.market_matches_symbol({'base': 'WRAPPEDBTC', 'baseId': 'BTC'}, 'BTC'))

    def test_two_venues_use_midpoint_not_reported_volume(self):
        self.assertEqual(COLLECTOR.weighted_median([(100.0, 1.0), (101.0, 1000000000.0)]), 100.5)

    def test_single_extreme_volume_cannot_dominate_three_venues(self):
        rows = [(100.0, 1.0), (101.0, 1.0), (102.0, 1000000000.0)]
        self.assertEqual(COLLECTOR.weighted_median(rows), 101.0)

    def test_weighted_median_handles_empty_input(self):
        self.assertIsNone(COLLECTOR.weighted_median([]))

    def test_missing_archive_starts_at_collector_version_zero(self):
        with patch.object(COLLECTOR, "OUTPUT", Path("/tmp/plutus-no-such-archive/daily.json")):
            self.assertEqual(COLLECTOR.load_previous(), ({}, {}, 0))

    def test_archive_validator_accepts_well_formed_daily_points(self):
        stamp = 1604361599999
        archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[stamp, 100.0, 2]]}}}
        COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))

    def test_archive_validator_rejects_single_source_confidence(self):
        archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[1604361599999, 100.0, 1]]}}}
        with self.assertRaises(ValueError):
            COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))

    def test_archive_validator_rejects_duplicate_or_unsorted_days(self):
        archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[1604361599999, 100.0, 2], [1604361599999, 101.0, 2]]}}}
        with self.assertRaises(ValueError):
            COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))

    def test_archive_validator_rejects_future_points(self):
        archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[1798761599999, 100.0, 2]]}}}
        with self.assertRaises(ValueError):
            COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))

    def test_symbol_list_is_read_from_the_application_map(self):
        symbols = COLLECTOR.symbols_from_app()
        self.assertIn("BTC", symbols)
        self.assertIn("ADA", symbols)
        self.assertIn("XMR", symbols)
        self.assertEqual(len(symbols), len(set(symbols)))


if __name__ == "__main__":
    unittest.main()
