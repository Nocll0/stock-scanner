# Stock Scanner

A day-trading scanner for **NASDAQ & NYSE** stocks. Runs as a desktop app
(Electron) with an embedded Node server that pulls live data from Yahoo Finance.

## Architecture
- **Data (now): Yahoo Finance** — scanning, discovery, quotes, charts, news,
  the watch list, and near-real-time streaming. Free, fast, no login.
- **Trading (coming): Tiger Brokers** — order placement will be added as a
  separate module. The "Trade" button and row-menu item are present but
  disabled until that lands. Trading is the only thing Tiger will do;
  all market data stays with Yahoo.

This split is deliberate: Yahoo is excellent for reading the whole market
quickly, while Tiger's API is built for placing trades. Keeping them separate
means the data side never depends on Tiger credentials or rate limits.

## Universe
Covers all NASDAQ- and NYSE-listed common stocks, pulled from NASDAQ Trader's
official symbol directory (refreshed daily, cached locally). The header shows
live S&P 500, Dow Jones, and Nasdaq index levels.

## Features
- Discovery-first scanning: ranks the market by what's actually moving
- Liquid / Full universe toggle
- Watch tab: a transparent bullish-setup score (momentum + volume + range
  position + the pattern analyzer's learned win rates)
- Charts with VWAP/EMA indicators, Fibonacci tool, and a self-learning
  candlestick pattern analyzer + forecast that grades its own predictions
- Favorites, CSV export, persistent pins, ticker search
- Sound alerts and Windows desktop notifications for big movers
- Near-real-time price streaming for on-screen stocks

## Run (development)
    npm install
    npm start

## Build a desktop app
    npm run dist        # or: npm run release  (auto-bumps the version)

Output in dist/:
- StockScanner-portable-<version>.exe — no install, just double-click
- StockScanner-setup-<version>.exe — one-click installer, updates in place

No Python, no external runtime, no login. Electron bundles its own Node, so
the packaged app is fully self-contained — double-click and go.

## Notes
- Yahoo's free data is delayed ~15 min for scanning; the streaming layer gives
  near-real-time ticks for stocks currently on screen. Truly instant
  full-market data requires a paid feed (a future option).
- Nothing is sent anywhere except Yahoo's public endpoints. No account, no key.
