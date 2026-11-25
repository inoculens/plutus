'use strict';
// Asset symbol maps shared by the live and historical price sources.
//
// Live crypto prices come from CoinGecko simple/price with exchange fallbacks.
// Resolution order per symbol: (1) manual override from live
// loadState().priceOverrides (wins, no network), (2) CoinGecko
// simple/price for mapped symbols with a 60s in-memory cache,
// (3) null for unknown tickers or failed fetches (last cached price
// is returned when available). Never throws to the UI — failures
// resolve to cached-or-null. The UI reads them via refreshAllPrices.

var SYMBOL_MAP = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  DOT: 'polkadot',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  XLM: 'stellar',
  ATOM: 'cosmos',
  UNI: 'uniswap',
  TRX: 'tron',
  NEAR: 'near',
  ARB: 'arbitrum',
  OP: 'optimism',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai',
  MATIC: 'matic-network',
  POL: 'polygon-ecosystem-token',
  APT: 'aptos',
  INJ: 'injective-protocol',
  SUI: 'sui',
  SEI: 'sei-network',
  TIA: 'celestia',
  PEPE: 'pepe',
  SHIB: 'shiba-inu',
  TON: 'toncoin',
  ICP: 'internet-computer',
  FIL: 'filecoin',
  ETC: 'ethereum-classic',
  HBAR: 'hedera-hashgraph',
  VET: 'vechain',
  RENDER: 'render-token',
  FET: 'fetch-ai',
  KAS: 'kaspa',
  MNT: 'mantle',
  STX: 'stacks',
  MKR: 'maker',
  AAVE: 'aave',
  CRV: 'curve-dao-token',
  LDO: 'lido-dao',
  AR: 'arweave',
  SAND: 'the-sandbox',
  MANA: 'decentraland',
  AXS: 'axie-infinity',
  CHZ: 'chiliz',
  ENJ: 'enjincoin',
  BAT: 'basic-attention-token',
  ZEC: 'zcash',
  DASH: 'dash',
  XTZ: 'tezos',
  EOS: 'eos',
  KSM: 'kusama',
  ALGO: 'algorand',
  THETA: 'theta-network',
  FTM: 'fantom',
  CELO: 'celo',
  KAVA: 'kava',
  RUNE: 'thorchain',
  WBTC: 'wrapped-bitcoin',
  WSTETH: 'wrapped-steth',
  RPL: 'rocket-pool',
  SNX: 'havven',
  COMP: 'compound-governance-token',
  YFI: 'yearn-finance',
  SUSHI: 'sushi',
  ASTR: 'astar',
  JUP: 'jupiter-exchange-solana',
  PYTH: 'pyth-network',
  ONDO: 'ondo-finance',
  TAO: 'bittensor',
  XMR: 'monero',
  CRO: 'crypto-com-chain',
  GRT: 'the-graph',
  IMX: 'immutable-x',
  ENS: 'ethereum-name-service',
  LRC: 'loopring',
  QNT: 'quant-network',
  CAKE: 'pancakeswap-token',
  EGLD: 'elrond-erd-2',
  FLOW: 'flow',
  GALA: 'gala',
  APE: 'apecoin',
  JASMY: 'jasmycoin',
  HNT: 'helium',
  WIF: 'dogwifcoin',
  BONK: 'bonk',
  FLOKI: 'floki',
  RAY: 'raydium',
  PENDLE: 'pendle',
  ENA: 'ethena',
  STRK: 'starknet',
  ZK: 'zksync',
  W: 'wormhole',
  BLUR: 'blur',
  ORCA: 'orca',
  PAXG: 'pax-gold',
  XAUT: 'tether-gold'
};

// Commodities / precious metals / energy, quoted in USD on Stooq (spot for
// metals, front-month futures for energy/materials). Keys are the account
// tickers users type; values are Stooq codes (lowercase). Tickers containing
// a dot (e.g. GC.F) bypass the map and are used as Stooq codes directly so
// new instruments work without a code change. Units: metals per troy ounce,
// oil per barrel — converted into the display main via ECB like stocks.
var COMMODITY_MAP = {
  XAU: 'xauusd',
  XAG: 'xagusd',
  XPT: 'xptusd',
  XPD: 'xpdusd',
  WTI: 'cl.f',
  USOIL: 'cl.f',
  OIL: 'cl.f',
  BRENT: 'cb.f',
  UKOIL: 'cb.f',
  BRENTOIL: 'cb.f',
  NG: 'ng.f',
  NATGAS: 'ng.f',
  COPPER: 'hg.f',
  HG: 'hg.f',
  GC: 'gc.f',
  SI: 'si.f',
  PL: 'pl.f',
  PA: 'pa.f'
};

function isStooqKind(kd) {
  var k = (typeof kd === 'string') ? kd.trim().toLowerCase() : '';
  return k === 'stock' || k === 'commodity';
}

function stooqCommoditySymbol(sym) {
  var s = String(sym || '').trim().toUpperCase();
  if (!/^[A-Z0-9._-]{1,12}$/.test(s)) return null;
  if (Object.prototype.hasOwnProperty.call(COMMODITY_MAP, s)) return COMMODITY_MAP[s];
  if (s.indexOf('.') !== -1) return s.toLowerCase();
  return null;
}

function histKindFor(kd) {
  var k = (typeof kd === 'string') ? kd.trim().toLowerCase() : '';
  if (k === 'stock') return 'stock';
  if (k === 'commodity') return 'commodity';
  return 'crypto';
}
