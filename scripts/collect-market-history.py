#!/usr/bin/env python3
"""Build Plutus' public, exchange-aggregated daily crypto price archive.

Runs on GitHub Actions, not in visitors' browsers. It uses public spot OHLCV
endpoints through CCXT; no API keys, user data, or paid market-data API.
"""
from __future__ import annotations

import json
import logging
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

import ccxt

ROOT = Path(__file__).resolve().parents[1]
APP_JS = ROOT / "app.js"
OUTPUT = ROOT / "market-history" / "daily.json"
START = datetime.now(timezone.utc).date() - timedelta(days=6 * 365 + 2)
DAY_MS = 86_400_000
QUOTES = ("USD", "USDT", "USDC")
EXCHANGES = ("binance", "kraken", "coinbase", "okx", "kucoin", "gateio")
MAX_MARKETS_PER_ASSET = 3
MAX_DEVIATION = 0.08

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("plutus-market-history")


def symbols_from_app() -> list[str]:
    source = APP_JS.read_text(encoding="utf-8")
    match = re.search(r"var\s+SYMBOL_MAP\s*=\s*\{([\s\S]*?)\n\};", source)
    if not match:
        raise RuntimeError("Could not read SYMBOL_MAP from app.js")
    return list(dict.fromkeys(re.findall(r"^\s*([A-Z0-9]+)\s*:", match.group(1), re.M)))


def weighted_median(rows: list[tuple[float, float]]) -> float | None:
    valid = sorted((p, max(w, 1e-12)) for p, w in rows if p > 0 and w >= 0)
    if not valid:
        return None
    total = sum(w for _, w in valid)
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
    while cursor < end_ms and pages < 12:
        batch = exchange.fetch_ohlcv(market, timeframe="1d", since=cursor, limit=1000)
        pages += 1
        if not batch:
            break
        advanced = cursor
        for row in batch:
            if not row or len(row) < 6:
                continue
            stamp, close, volume = int(row[0]), float(row[4] or 0), float(row[5] or 0)
            if close <= 0 or stamp < since_ms or stamp >= end_ms:
                continue
            day = stamp // DAY_MS
            # Quote-volume is approximated from base volume * daily close.
            rows_by_day.setdefault(day, []).append((close, max(close * volume, 1e-12)))
            advanced = max(advanced, stamp + DAY_MS)
        if advanced <= cursor:
            break
        cursor = advanced
        if len(batch) < 2:
            break
    return [[day * DAY_MS + DAY_MS - 1,
             sum(price * weight for price, weight in values) / sum(weight for _, weight in values),
             sum(weight for _, weight in values)]
            for day, values in sorted(rows_by_day.items())]


def main() -> int:
    symbols = symbols_from_app()
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
            market_index[base.upper()].append(
                (quote_rank[quote] * 10 + exchange_rank[exchange_id], market["symbol"], client)
            )

    archive = {
        "schema": 1,
        "currency": "USD",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "CCXT public spot OHLCV; daily close weighted median across exchanges",
        "rangeStart": START.isoformat(),
        "assets": {},
        "coverage": {},
    }
    since_ms = int(datetime.combine(START, datetime.min.time(), timezone.utc).timestamp() * 1000)

    for symbol in symbols:
        # Stablecoins are intentionally represented as USD parity only where
        # there is no independent market needed for portfolio valuation.
        if symbol in ("USDT", "USDC", "DAI"):
            continue
        candidates = sorted(market_index.get(symbol, []), key=lambda item: item[0])
        chosen = []
        used = set()
        for _, market, client in candidates:
            exchange_id = client.id
            if exchange_id in used:
                continue
            chosen.append((exchange_id, market, client))
            used.add(exchange_id)
            if len(chosen) >= MAX_MARKETS_PER_ASSET:
                break
        if not chosen:
            log.warning("%s: no supported USD/USDT/USDC spot market", symbol)
            continue

        by_day: dict[int, list[tuple[float, float, str]]] = defaultdict(list)
        for exchange_id, market, client in chosen:
            try:
                rows = candle_rows(client, market, since_ms)
                log.info("%s %s: %d daily candles", symbol, exchange_id, len(rows))
                for stamp, close, quote_volume in rows:
                    day = int(stamp) // DAY_MS
                    by_day[day].append((float(close), max(float(quote_volume), 1e-12), exchange_id))
            except Exception as exc:
                log.warning("%s %s %s: %s", symbol, exchange_id, market, exc)

        points = []
        sources = set()
        for day, observations in sorted(by_day.items()):
            prices = [row[0] for row in observations]
            median = weighted_median([(price, weight) for price, weight, _ in observations])
            if median is None:
                continue
            filtered = [(price, weight) for price, weight, _ in observations
                        if abs(price / median - 1) <= MAX_DEVIATION]
            close = weighted_median(filtered)
            if close is None:
                continue
            sources.update(row[2] for row in observations
                           if abs(row[0] / median - 1) <= MAX_DEVIATION)
            points.append([day * DAY_MS + DAY_MS - 1, round(close, 12), len(filtered)])
        if points:
            archive["assets"][symbol] = {"points": points}
            archive["coverage"][symbol] = {
                "days": len(points),
                "first": datetime.fromtimestamp(points[0][0] / 1000, timezone.utc).date().isoformat(),
                "last": datetime.fromtimestamp(points[-1][0] / 1000, timezone.utc).date().isoformat(),
                "exchanges": sorted(sources),
            }
        else:
            log.warning("%s: no daily prices collected", symbol)

    for client in clients.values():
        try:
            client.close()
        except Exception:
            pass

    if not archive["assets"]:
        raise RuntimeError("Collector produced an empty archive; refusing to overwrite last good data")
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
