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
        archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[stamp, 100.0, 2, ['kraken', 'coinbase']]]}}}
        COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))

    def test_archive_validator_rejects_single_source_confidence(self):
        archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[1604361599999, 100.0, 1, ['kraken']]]}}}
        with self.assertRaises(ValueError):
            COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))

    def test_archive_validator_rejects_duplicate_or_unsorted_days(self):
        archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[1604361599999, 100.0, 2, ['kraken', 'coinbase']], [1604361599999, 101.0, 2, ['kraken', 'coinbase']]]}}}
        with self.assertRaises(ValueError):
            COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))

    def test_archive_validator_rejects_future_points(self):
        archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[1798761599999, 100.0, 2, ['kraken', 'coinbase']]]}}}
        with self.assertRaises(ValueError):
            COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))


    def test_archive_validator_requires_per_day_trusted_exchange_provenance(self):
        archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[1604361599999, 100.0, 2]]}}}
        with self.assertRaises(ValueError):
            COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))

    def test_archive_validator_rejects_untrusted_provenance(self):
        archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[1604361599999, 100.0, 2, ['kraken', 'mexc']]]}}}
        with self.assertRaises(ValueError):
            COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))

    @staticmethod
    def _midnight_ms(days_ago):
        today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        return int(today.timestamp() * 1000) - days_ago * COLLECTOR.DAY_MS

    def _fake_exchange(self, exchange_id, listed_days_ago, mode, limit_cap):
        """Mimics ccxt OHLCV paging. mode: windowed | limit | latest."""
        day = COLLECTOR.DAY_MS
        listed = self._midnight_ms(listed_days_ago)
        today = self._midnight_ms(0)
        calls = []

        class Fake:
            id = exchange_id
            options = {}

            def fetch_ohlcv(self, market, timeframe="1d", since=None, limit=None):
                calls.append(since)
                stamps = [s for s in range(listed, today + day, day) if s >= since]
                if mode == "windowed":
                    stamps = [s for s in stamps if s < since + limit * day]
                elif mode == "latest":
                    stamps = stamps[-limit:]
                else:
                    stamps = stamps[:limit]
                return [[s, 1, 1, 1, 100.0, 5.0] for s in stamps[:limit_cap]]

        return Fake(), calls

    def test_windowed_exchange_pages_past_empty_window_before_listing(self):
        # Asset listed 300 days ago, history requested for ~6 years: the first
        # windows are empty/short, yet the recent history must still be fetched.
        for exchange_id, limit in (("kucoin", 1000), ("okx", 100), ("coinbase", 300)):
            exchange, calls = self._fake_exchange(exchange_id, 300, "windowed", limit)
            with patch.dict(COLLECTOR.PAGE_LIMITS, {exchange_id: limit}):
                rows = COLLECTOR.candle_rows(exchange, "X/USD", self._midnight_ms(2200))
            days = {int(row[0]) // COLLECTOR.DAY_MS for row in rows}
            expected = {s // COLLECTOR.DAY_MS for s in range(self._midnight_ms(300), self._midnight_ms(0), COLLECTOR.DAY_MS)}
            self.assertEqual(days, expected, exchange_id)

    def test_windowed_exchange_short_first_window_does_not_stop_paging(self):
        # Listed 1500 days ago: the first 1000-day window holds only ~500
        # candles (< page_limit) but 1000+ more days exist after it.
        exchange, _ = self._fake_exchange("kucoin", 1500, "windowed", 1000)
        rows = COLLECTOR.candle_rows(exchange, "X/USD", self._midnight_ms(2200))
        self.assertEqual(len(rows), 1500)

    def test_windowed_exchange_has_no_duplicate_or_missing_days(self):
        exchange, _ = self._fake_exchange("okx", 700, "windowed", 100)
        with patch.dict(COLLECTOR.PAGE_LIMITS, {"okx": 100}):
            rows = COLLECTOR.candle_rows(exchange, "X/USD", self._midnight_ms(700))
        stamps = [row[0] for row in rows]
        self.assertEqual(len(stamps), len(set(stamps)))
        self.assertEqual(len(rows), 700)

    def test_limit_based_exchange_paging_is_unchanged(self):
        exchange, calls = self._fake_exchange("bitfinex", 1500, "limit", 1000)
        rows = COLLECTOR.candle_rows(exchange, "X/USD", self._midnight_ms(2200))
        self.assertEqual(len(rows), 1500)
        self.assertLessEqual(len(calls), 3)

    def test_latest_only_exchange_stops_after_its_cap(self):
        exchange, calls = self._fake_exchange("kraken", 3000, "latest", 720)
        rows = COLLECTOR.candle_rows(exchange, "X/USD", self._midnight_ms(2200))
        # The venue's newest 720 candles include today's still-open candle,
        # which the collector excludes by design.
        self.assertEqual(len(rows), 719)
        self.assertEqual(len(calls), 1)

    def test_incremental_run_uses_a_single_page_per_venue(self):
        for exchange_id in ("kucoin", "okx", "coinbase"):
            exchange, calls = self._fake_exchange(exchange_id, 3000, "windowed", 100)
            with patch.dict(COLLECTOR.PAGE_LIMITS, {exchange_id: 100}):
                rows = COLLECTOR.candle_rows(exchange, "X/USD", self._midnight_ms(4))
            self.assertEqual(len(calls), 1, exchange_id)
            self.assertEqual(len(rows), 4)

    def test_runner_blocked_exchanges_are_not_collected_or_trusted(self):
        for blocked in ("binance", "bybit"):
            self.assertNotIn(blocked, COLLECTOR.EXCHANGES)
            archive = {'schema': 1, 'currency': 'USD', 'assets': {'BTC': {'points': [[1604361599999, 100.0, 2, ['kraken', blocked]]]}}}
            with self.assertRaises(ValueError):
                COLLECTOR.validate_archive(archive, datetime(2026, 1, 1, tzinfo=timezone.utc))
        # Every venue with a paging rule must still be a collected venue.
        self.assertTrue(COLLECTOR.WINDOWED_EXCHANGES.issubset(COLLECTOR.EXCHANGES))

    def test_collector_version_forces_rebuild_of_gapped_archives(self):
        # v6 archives contain permanent 1000-day holes for late-listed assets.
        self.assertGreaterEqual(COLLECTOR.COLLECTOR_VERSION, 7)

    def test_symbol_list_is_read_from_the_application_map(self):
        symbols = COLLECTOR.symbols_from_app()
        self.assertIn("BTC", symbols)
        self.assertIn("ADA", symbols)
        self.assertIn("XMR", symbols)
        self.assertEqual(len(symbols), len(set(symbols)))


class CollectorRunHealthTests(unittest.TestCase):
    """End-to-end runs of main() against fake exchanges (no network)."""

    SYMBOLS = ["BTC", "ETH", "LTC", "XRP", "ADA"]

    def setUp(self):
        import json
        import tempfile
        from types import SimpleNamespace
        self.json = json
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.output = root / "market-history" / "daily.json"
        app = root / "app.js"
        app.write_text("var SYMBOL_MAP = {\n" + "".join(f"  {sym}: 'x',\n" for sym in self.SYMBOLS) + "};\n", encoding="utf-8")
        self.failing = set()
        self.empty = set()      # venues answer cleanly with an empty candle list
        self.empty_on = None    # restrict `empty` to one exchange id (None = all venues)
        self.active_flag = None  # value of the markets' `active` field
        outer = self

        def make(exchange_id):
            class Fake:
                id = exchange_id
                options = {}

                def __init__(self, *_args, **_kwargs):
                    self.markets = {
                        f"{sym}/USD": {"spot": True, "base": sym, "baseId": sym, "quote": "USD", "symbol": f"{sym}/USD", "active": outer.active_flag}
                        for sym in outer.SYMBOLS
                    }

                def load_markets(self):
                    return self.markets

                def fetch_ohlcv(self, market, timeframe="1d", since=0, limit=1000):
                    base = market.split("/")[0]
                    if base in outer.failing:
                        raise RuntimeError("simulated exchange outage")
                    if base in outer.empty and outer.empty_on in (None, self.id):
                        return []
                    end = int(datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
                    rows, stamp = [], since - (since % COLLECTOR.DAY_MS)
                    while stamp < end and len(rows) < limit:
                        price = 100.0 + (stamp // COLLECTOR.DAY_MS) % 7
                        rows.append([stamp, price, price, price, price, 1000.0])
                        stamp += COLLECTOR.DAY_MS
                    return rows

                def close(self):
                    pass
            return Fake

        self.patches = [
            patch.object(COLLECTOR, "OUTPUT", self.output),
            patch.object(COLLECTOR, "APP_JS", app),
            patch.object(COLLECTOR, "EXCHANGES", ("kraken", "bitfinex")),
            patch.object(COLLECTOR, "TRUSTED_EXCHANGES", {"kraken", "bitfinex"}),
            patch.object(COLLECTOR, "INITIAL_DAYS", 12),
            patch.object(COLLECTOR, "ccxt", SimpleNamespace(kraken=make("kraken"), bitfinex=make("bitfinex"))),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.tmp.cleanup()

    def archive(self):
        return self.json.loads(self.output.read_text(encoding="utf-8"))

    def test_healthy_run_publishes_every_asset_without_gaps_or_duplicates(self):
        self.assertEqual(COLLECTOR.main(), 0)
        archive = self.archive()
        self.assertEqual(sorted(archive["assets"]), sorted(self.SYMBOLS))
        for symbol, asset in archive["assets"].items():
            days = [row[0] // COLLECTOR.DAY_MS for row in asset["points"]]
            self.assertEqual(days, sorted(set(days)), f"{symbol}: duplicate or unordered days")
            self.assertEqual(days[-1] - days[0] + 1, len(days), f"{symbol}: silent gap")
            self.assertEqual(archive["coverage"][symbol]["missingDays"], 0)
            self.assertTrue(all(row[2] == 2 and sorted(row[3]) == ["bitfinex", "kraken"] for row in asset["points"]))
        self.assertFalse(self.output.with_suffix(".json.tmp").exists())

    def test_total_outage_fails_and_leaves_the_last_good_archive_untouched(self):
        self.assertEqual(COLLECTOR.main(), 0)
        good = self.output.read_bytes()
        self.failing = set(self.SYMBOLS)
        with self.assertRaisesRegex(RuntimeError, "partial update"):
            COLLECTOR.main()
        self.assertEqual(self.output.read_bytes(), good)
        self.assertFalse(self.output.with_suffix(".json.tmp").exists())

    def test_majority_failure_is_not_published_as_success(self):
        self.assertEqual(COLLECTOR.main(), 0)
        good = self.output.read_bytes()
        self.failing = {"BTC", "ETH"}  # 2 of 5 assets lose every market
        with self.assertRaisesRegex(RuntimeError, "2 of 5"):
            COLLECTOR.main()
        self.assertEqual(self.output.read_bytes(), good)

    def test_single_isolated_failure_keeps_previous_points_and_still_publishes(self):
        self.assertEqual(COLLECTOR.main(), 0)
        before = self.archive()["assets"]["ADA"]["points"]
        self.failing = {"ADA"}  # 1 of 5 = 20%, under the gate
        self.assertEqual(COLLECTOR.main(), 0)
        after = self.archive()
        self.assertEqual(after["assets"]["ADA"]["points"], before, "previous history is preserved, never dropped")
        self.assertEqual(sorted(after["assets"]), sorted(self.SYMBOLS))

    def test_empty_collection_never_overwrites_last_good_data(self):
        self.assertEqual(COLLECTOR.main(), 0)
        good = self.output.read_bytes()
        with patch.object(COLLECTOR, "symbols_from_app", return_value=[]):
            with self.assertRaises(RuntimeError):
                COLLECTOR.main()
        self.assertEqual(self.output.read_bytes(), good)

    def test_interrupted_write_leaves_previous_archive_and_no_temp_file(self):
        self.assertEqual(COLLECTOR.main(), 0)
        good = self.output.read_bytes()
        with patch.object(COLLECTOR.os, "fsync", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                COLLECTOR.write_archive_atomically({"schema": 1}, self.output)
        self.assertEqual(self.output.read_bytes(), good)
        self.assertFalse(self.output.with_suffix(".json.tmp").exists())

    def test_corrupt_previous_archive_is_replaced_by_a_full_clean_collection(self):
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.output.write_text("{not json", encoding="utf-8")
        self.assertEqual(COLLECTOR.main(), 0)
        self.assertEqual(sorted(self.archive()["assets"]), sorted(self.SYMBOLS))

    def test_missing_day_counter_and_health_gate_boundaries(self):
        day = COLLECTOR.DAY_MS
        points = [[day * 10 + day - 1], [day * 11 + day - 1], [day * 14 + day - 1]]
        self.assertEqual(COLLECTOR.count_missing_days(points), 2)
        self.assertEqual(COLLECTOR.count_missing_days([]), 0)
        COLLECTOR.check_run_health(0, 0)
        COLLECTOR.check_run_health(4, 1)  # exactly 25%: allowed
        with self.assertRaises(RuntimeError):
            COLLECTOR.check_run_health(4, 2)

    def test_silent_empty_responses_for_assets_that_were_trading_fail_the_run(self):
        self.assertEqual(COLLECTOR.main(), 0)
        good = self.output.read_bytes()
        self.empty = {"BTC", "ETH"}  # every venue answers [] without raising: 2 of 5 assets
        with self.assertRaisesRegex(RuntimeError, "2 of 5 assets had no usable market data"):
            COLLECTOR.main()
        self.assertEqual(self.output.read_bytes(), good)

    def test_single_silent_empty_asset_keeps_history_and_publishes(self):
        self.assertEqual(COLLECTOR.main(), 0)
        before = self.archive()["assets"]["ADA"]["points"]
        self.empty = {"ADA"}  # 1 of 5 = 20%, under the gate
        self.assertEqual(COLLECTOR.main(), 0)
        after = self.archive()
        self.assertEqual(after["assets"]["ADA"]["points"], before)
        self.assertEqual(sorted(after["assets"]), sorted(self.SYMBOLS))

    def test_total_silent_outage_is_not_published(self):
        self.assertEqual(COLLECTOR.main(), 0)
        good = self.output.read_bytes()
        self.empty = set(self.SYMBOLS)
        with self.assertRaises(RuntimeError):
            COLLECTOR.main()
        self.assertEqual(self.output.read_bytes(), good)

    def test_empty_everywhere_for_a_never_seen_inactive_asset_is_legitimate_no_history(self):
        # No archive yet and no market claims to be active: nothing says these should have data.
        self.empty = {"BTC", "ETH", "LTC"}
        self.assertEqual(COLLECTOR.main(), 0)
        self.assertEqual(sorted(self.archive()["assets"]), ["ADA", "XRP"])

    def test_empty_everywhere_for_active_markets_is_unexpected_even_on_the_first_run(self):
        self.active_flag = True
        self.empty = {"BTC", "ETH", "LTC"}
        with self.assertRaisesRegex(RuntimeError, "3 of 5 assets had no usable market data"):
            COLLECTOR.main()
        self.assertFalse(self.output.exists())

    def test_one_venue_raising_and_the_other_empty_counts_as_incomplete(self):
        self.assertEqual(COLLECTOR.main(), 0)
        good = self.output.read_bytes()
        # kraken raises for BTC/ETH, bitfinex answers empty for them
        self.failing = set()
        orig = COLLECTOR.ccxt.kraken
        def raising(*a, **k):
            client = orig(*a, **k)
            real = client.fetch_ohlcv
            def fetch(market, **kw):
                if market.split("/")[0] in ("BTC", "ETH"):
                    raise RuntimeError("simulated exchange outage")
                return real(market, **kw)
            client.fetch_ohlcv = fetch
            return client
        self.empty, self.empty_on = {"BTC", "ETH"}, "bitfinex"
        with patch.object(COLLECTOR.ccxt, "kraken", raising):
            with self.assertRaisesRegex(RuntimeError, "2 of 5 assets had no usable market data"):
                COLLECTOR.main()
        self.assertEqual(self.output.read_bytes(), good)

    def test_one_empty_venue_with_another_returning_data_is_not_an_incomplete_asset(self):
        self.assertEqual(COLLECTOR.main(), 0)
        self.empty, self.empty_on = set(self.SYMBOLS), "bitfinex"
        # Every asset still has usable candles from kraken, so the health gate does not trip.
        self.assertEqual(COLLECTOR.main(), 0)

    def test_asset_classification_matrix(self):
        c = COLLECTOR.classify_asset_fetch
        self.assertEqual(c(2, 0, 10, False), "ok")
        self.assertEqual(c(2, 1, 10, True), "ok")
        self.assertEqual(c(2, 2, 0, False), "failed")
        self.assertEqual(c(2, 0, 0, True), "no_data")
        self.assertEqual(c(2, 1, 0, False), "no_data")
        self.assertEqual(c(2, 0, 0, False), "no_history")
        COLLECTOR.check_run_health(4, 0, 1)  # 25% exactly: allowed
        with self.assertRaises(RuntimeError):
            COLLECTOR.check_run_health(4, 1, 1)


if __name__ == "__main__":
    unittest.main()
