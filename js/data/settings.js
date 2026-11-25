'use strict';
// Default state and user settings (main currency, cost method, date format):
// validation and normalization.

'use strict';

function defaultState() {
  return {
    settings: { mainCurrency: 'EUR', costMethod: 'average', assetLedgers: true, dateFormat: 'DD/MM/YYYY' },
    accounts: [],
    trades: [],
    priceOverrides: {}
  };
}

var MAIN_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'RON'];

function isValidSettings(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.mainCurrency === 'string' && MAIN_CURRENCIES.indexOf(v.mainCurrency.toUpperCase()) !== -1 &&
    (v.costMethod === 'average' || v.costMethod === 'fifo') &&
    (v.dateFormat === undefined || isValidDateFormat(v.dateFormat));
}

function normalizeSettings(s, fallback) {
  var fb = fallback || { mainCurrency: 'EUR', costMethod: 'average', assetLedgers: true, dateFormat: DEFAULT_DATE_FORMAT };
  if (!isValidSettings(s)) {
    var outFb = {
      mainCurrency: fb.mainCurrency,
      costMethod: fb.costMethod,
      assetLedgers: (fb.assetLedgers === false) ? false : true,
      dateFormat: normalizeDateFormat(fb.dateFormat)
    };
    var fbf = normalizeAccountFilter(fb.accountFilter);
    if (fbf !== null) outFb.accountFilter = fbf;
    return outFb;
  }
  var res = {
    mainCurrency: String(s.mainCurrency).toUpperCase(),
    costMethod: s.costMethod,
    assetLedgers: (s.assetLedgers === false) ? false : true,
    dateFormat: normalizeDateFormat(s.dateFormat)
  };
  var flt = normalizeAccountFilter(s.accountFilter);
  if (flt !== null) res.accountFilter = flt;
  // Default chart of accounts: code -> label. Bad keys are dropped
  // individually; valid entries persist through export/import.
  if (s.ledgerLabels !== undefined && s.ledgerLabels !== null && s.ledgerLabels && typeof s.ledgerLabels === 'object' && !Array.isArray(s.ledgerLabels)) {
    res.ledgerLabels = normalizeLedgerLabels(s.ledgerLabels);
  }
  return res;
}
