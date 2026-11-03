#!/usr/bin/env python3
"""Incrementally build Plutus' public daily crypto archive from CCXT spot markets."""
from __future__ import annotations

import json
import logging
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

import ccxt

ROOT = Path(__file__).resolve().parents[1]
APP_JS = ROOT / "app.js"
OUTPUT = ROOT / "market-history" / "daily.json"
INITIAL_DAYS = 6 * 365 + 2
DAY_MS = 86_400_000
QUOTES = ("USD", "USDT", "USDC")
EXCHANGES = ("binance", "kraken", "coinbase", "okx", "kucoin", "gateio", "mexc", "bitfinex", "htx", "bybit")
MAX_MARKETS_PER_ASSET = 5
MAX_DEVIATION = 0.08
MIN_INDEPENDENT_EXCHANGES = 2
MIN_TRUSTED_EXCHANGES = 2
MAX_WEIGHT_MULTIPLE = 1.0
COLLECTOR_VERSION = 5
BASE_ID_ALIASES = {"BTC": {"XBT"}}
TRUSTED_EXCHANGES = {"binance", "kraken", "coinbase", "okx", "kucoin", "bitfinex", "bybit"}
PAGE_LIMITS = {"okx": 100, "coinbase": 300, "kraken": 720, "bybit": 1000}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("plutus-market-history")


def symbols_from_app() -> list[str]:
    source = APP_JS.read_text(encoding="utf-8")
    match = re.search(r"var\s+SYMBOL_MAP\s*=\s*\{([\s\S]*?)\n\};", source)
    if not match:
        raise RuntimeError("Could not read SYMBOL_MAP from app.js")
    return list(dict.fromkeys(re.findall(r"^\s*([A-Z0-9]+)\s*:", match.group(1), re.M)))


def median(values: list[float]) -> float | None:
    values = sorted(value for value in values if math.isfinite(value) and value > 0)
    if not values:
        return None
    middle = len(values) // 2
    return values[middle] if len(values) % 2 else (values[middle - 1] + values[middle]) / 2


def filter_observations(rows: list[tuple[float, float, str]], symbol: str) -> list[tuple[float, float, str]]:
    # Two trusted venues establish the reference price. Long-tail venues
    # cannot establish or influence the published price.
    anchors = [row for row in rows if row[2] in TRUSTED_EXCHANGES]
    if len({row[2] for row in anchors}) < MIN_TRUSTED_EXCHANGES:
        return []
    reference = median([row[0] for row in anchors])
    if reference is None:
        return []
    # Only trusted anchors contribute to the published price. Long-tail
    # venues cannot influence the published price.
    return [row for row in anchors if abs(row[0] / reference - 1) <= MAX_DEVIATION]


def market_matches_symbol(market: dict, symbol: str) -> bool:
    base = str(market.get("base") or "").upper()
    base_id = str(market.get("baseId") or "").upper()
    # Both normalized base and exchange-native asset ID must match.
    return base == symbol and base_id in ({symbol} | BASE_ID_ALIASES.get(symbol, set()))


def weighted_median(rows: list[tuple[float, float]]) -> float | None:
    valid = sorted(
        (price, max(weight, 1e-12))
        for price, weight in rows
        if math.isfinite(price) and price > 0 and math.isfinite(weight) and weight >= 0
    )
    if not valid:
        return None
    # With two venues, trading volume cannot break the tie: use the ordinary
    # midpoint so one venue's reported volume cannot choose the whole result.
    if len(valid) == 2:
        return (valid[0][0] + valid[1][0]) / 2
    if len(valid) >= 3:
        # Winsorize at the median venue volume. A single venue can never have
        # more weight than the combined weight of the other accepted venues.
        volume_cap = (median([weight for _, weight in valid]) or 1e-12) * MAX_WEIGHT_MULTIPLE
        valid = [(price, min(weight, volume_cap)) for price, weight in valid]
    total = sum(weight for _, weight in valid)
    running = 0.0
    for price, weight in valid:
        running += weight
        if running >= total / 2:
            return price
    return valid[-1][0]


def candle_rows(exchange, market: str, since_ms: int) -> list[list[float]]:
    cursor = since_ms
    end_ms = int(datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
    rows_by_day: dict[int, list[tuple[float, float]]] = {}
    pages = 0
    page_limit = min(int(exchange.options.get("fetchOHLCVLimit", PAGE_LIMITS.get(exchange.id, 1000)) or PAGE_LIMITS.get(exchange.id, 1000)), PAGE_LIMITS.get(exchange.id, 1000))
    while cursor < end_ms and pages < 100:
        batch = exchange.fetch_ohlcv(market, timeframe="1d", since=cursor, limit=page_limit)
        pages += 1
        if not batch:
            break
        advanced = cursor
        for row in batch:
            if not row or len(row) < 6:
                continue
            stamp, close, volume = int(row[0]), float(row[4] or 0), float(row[5] or 0)
            if not math.isfinite(close) or not math.isfinite(volume) or close <= 0 or volume < 0 or stamp < since_ms or stamp >= end_ms:
                continue
            day = stamp // DAY_MS
            rows_by_day.setdefault(day, []).append((close, max(close * volume, 1e-12)))
            advanced = max(advanced, stamp + DAY_MS)
        if advanced <= cursor:
            break
        cursor = advanced
        if len(batch) < page_limit:
            break
    return [[day * DAY_MS + DAY_MS - 1,
             sum(price * weight for price, weight in values) / sum(weight for _, weight in values),
             sum(weight for _, weight in values)]
            for day, values in sorted(rows_by_day.items())]


def validate_archive(archive: dict, today: datetime | None = None) -> None:
    if archive.get('schema') != 1 or archive.get('currency') != 'USD':
        raise ValueError('Archive schema or currency is invalid')
    assets = archive.get('assets')
    if not isinstance(assets, dict) or not assets:
        raise ValueError('Archive contains no assets')
    current_day = (today or datetime.now(timezone.utc)).date()
    for symbol, asset in assets.items():
        points = asset.get('points') if isinstance(asset, dict) else None
        if not isinstance(points, list) or not points:
            raise ValueError(f'{symbol}: missing daily points')
        previous_day = None
        for row in points:
            if not isinstance(row, list) or len(row) < 3:
                raise ValueError(f'{symbol}: malformed point')
            stamp, price, confidence = int(row[0]), float(row[1]), int(row[2])
            if not math.isfinite(price) or price <= 0 or confidence < MIN_TRUSTED_EXCHANGES:
                raise ValueError(f'{symbol}: invalid price or insufficient source confidence')
            sources = row[3] if len(row) > 3 else None
            if not isinstance(sources, list) or len(sources) != confidence:
                raise ValueError(f'{symbol}: missing or inconsistent per-day exchange provenance')
            if len(set(sources)) != len(sources) or not set(sources).issubset(TRUSTED_EXCHANGES):
                raise ValueError(f'{symbol}: untrusted or duplicate per-day exchange provenance')
            if stamp % DAY_MS != DAY_MS - 1:
                raise ValueError(f'{symbol}: timestamp is not a UTC daily close')
            day = stamp // DAY_MS
            if previous_day is not None and day <= previous_day:
                raise ValueError(f'{symbol}: daily points are not strictly ordered')
            if datetime.fromtimestamp(stamp / 1000, timezone.utc).date() > current_day:
                raise ValueError(f'{symbol}: future-dated observation')
            previous_day = day

def load_previous() -> tuple[dict, dict, int]:
    if not OUTPUT.exists():
        return {}, {}, 0
    try:
        previous = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return previous.get("assets", {}), previous.get("coverage", {}), int(previous.get("collectorVersion", 0))
    except (OSError, ValueError, AttributeError):
        log.warning("Previous archive could not be read; starting a clean collection")
        return {}, {}, 0


def main() -> int:
    symbols = symbols_from_app()
    old_assets, old_coverage, previous_version = load_previous()
    rebuild_archive = previous_version < COLLECTOR_VERSION
    if rebuild_archive:
        log.info("Collector version changed; rebuilding all historical observations with the current validation policy")
        old_assets, old_coverage = {}, {}
    now = datetime.now(timezone.utc).date()
    initial_start = now - timedelta(days=INITIAL_DAYS)
    clients = {}
    for exchange_id in EXCHANGES:
        try:
            client = getattr(ccxt, exchange_id)({"enableRateLimit": True, "timeout": 20000})
            client.load_markets()
            clients[exchange_id] = client
            log.info("%s markets loaded", exchange_id)
        except Exception as exc:
            log.warning("%s unavailable: %s", exchange_id, exc)
    if not clients:
        raise RuntimeError("No public exchange market lists could be loaded")

    market_index: dict[str, list[tuple[int, str, object]]] = defaultdict(list)
    quote_rank = {quote: i for i, quote in enumerate(QUOTES)}
    exchange_rank = {name: i for i, name in enumerate(EXCHANGES)}
    for exchange_id, client in clients.items():
        for market in client.markets.values():
            if not market.get("spot") or market.get("active") is False:
                continue
            base, quote = market.get("base"), market.get("quote")
            if not base or quote not in quote_rank:
                continue
            # Require the exchange's normalized base identifier to match the
            # application ticker exactly; never infer identity from display names.
            if str(base).upper() not in symbols or not market_matches_symbol(market, str(base).upper()):
                continue
            market_index[str(base).upper()].append(
                (quote_rank[quote] * 10 + exchange_rank[exchange_id], market["symbol"], client)
            )

    archive = {
        "schema": 1, "collectorVersion": COLLECTOR_VERSION, "currency": "USD",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "CCXT public spot OHLCV; minimum two trusted exchanges; trusted-only unweighted outlier screen and winsorized volume-weighted median (equal-weight midpoint for two venues); USDT/USDC treated at USD parity; each daily point includes contributing exchange IDs",
        "rangeStart": initial_start.isoformat(), "assets": {}, "coverage": {},
    }

    try:
        for symbol in symbols:
            old_rows = old_assets.get(symbol, {}).get("points", [])
            old_by_day = {int(row[0]) // DAY_MS: row for row in old_rows
                          if isinstance(row, list) and len(row) >= 2}
            if old_by_day and not rebuild_archive:
                last_day = max(old_by_day)
                start_date = max(initial_start, datetime.fromtimestamp(last_day * DAY_MS / 1000, timezone.utc).date() - timedelta(days=3))
            else:
                start_date = initial_start
            since_ms = int(datetime.combine(start_date, datetime.min.time(), timezone.utc).timestamp() * 1000)

            candidates = sorted(market_index.get(symbol, []), key=lambda item: item[0])
            chosen, used = [], set()
            for _, market, client in candidates:
                if client.id in used:
                    continue
                chosen.append((client.id, market, client))
                used.add(client.id)
                if len(chosen) >= MAX_MARKETS_PER_ASSET:
                    break
            if not chosen:
                log.warning("%s: no supported USD/USDT/USDC spot market", symbol)
                if old_by_day:
                    archive["assets"][symbol] = {"points": [old_by_day[d] for d in sorted(old_by_day)]}
                    archive["coverage"][symbol] = old_coverage.get(symbol, {})
                continue

            by_day: dict[int, list[tuple[float, float, str]]] = defaultdict(list)
            for exchange_id, market, client in chosen:
                try:
                    rows = candle_rows(client, market, since_ms)
                    log.info("%s %s: %d daily candles", symbol, exchange_id, len(rows))
                    for stamp, close, quote_volume in rows:
                        by_day[int(stamp) // DAY_MS].append((float(close), float(quote_volume), exchange_id))
                except Exception as exc:
                    log.warning("%s %s %s: %s", symbol, exchange_id, market, exc)

            sources = set()
            for day, observations in sorted(by_day.items()):
                # A trusted venue set establishes identity/price context before
                # any volume is considered. Long-tail venues cannot set the
                # reference even when they report fabricated trading volume.
                accepted = filter_observations(observations, symbol)
                venues = {row[2] for row in accepted}
                if len(venues) < MIN_INDEPENDENT_EXCHANGES:
                    continue
                typical_volume = median([row[1] for row in accepted]) or 1.0
                weighted = [(price, min(max(volume, 1e-12), typical_volume * MAX_WEIGHT_MULTIPLE))
                            for price, volume, _ in accepted]
                close = weighted_median(weighted)
                if close is None:
                    continue
                # Row[2] stores independent venue count as a confidence score.
                new_row = [day * DAY_MS + DAY_MS - 1, round(close, 12), len(venues), sorted(venues)]
                old_row = old_by_day.get(day)
                if old_row and len(old_row) > 2 and int(old_row[2]) > len(venues):
                    continue
                old_by_day[day] = new_row
                sources.update(venues)

            merged = [old_by_day[d] for d in sorted(old_by_day)]
            if merged:
                archive["assets"][symbol] = {"points": merged}
                old_meta = old_coverage.get(symbol, {})
                archive["coverage"][symbol] = {
                    "days": len(merged),
                    "first": datetime.fromtimestamp(merged[0][0] / 1000, timezone.utc).date().isoformat(),
                    "last": datetime.fromtimestamp(merged[-1][0] / 1000, timezone.utc).date().isoformat(),
                    "exchanges": sorted(set(old_meta.get("exchanges", [])) | sources),
                }
            else:
                log.warning("%s: no independently corroborated prices; no data published", symbol)
    finally:
        for client in clients.values():
            try:
                client.close()
            except Exception:
                pass

    if not archive["assets"]:
        raise RuntimeError("Collector produced an empty archive; refusing to overwrite last good data")
    validate_archive(archive)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temp = OUTPUT.with_suffix(".json.tmp")
    temp.write_text(json.dumps(archive, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")
    temp.replace(OUTPUT)
    log.info("Wrote %s (%d assets)", OUTPUT, len(archive["assets"]))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        log.exception("Market-history collection failed")
        sys.exit(1)
