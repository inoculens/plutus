#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const app=path.join(__dirname,'..','app.js');
execFileSync(process.execPath,['--check',app],{stdio:'pipe'});
const s=fs.readFileSync(app,'utf8');
assert(s.includes('function syncTradeTypeUI()'));
assert(s.includes('var multiSource = transferHasAdditionalSources(srcRows);'));
assert(s.includes("if (selfRawSub !== '')"));
assert(s.includes('srcRows.length === 1 && rows.length === 1'));
assert(s.includes('srcRows.forEach(function (sr) { if (qtyOverPrecise(sr.qty, symbol) || qtyOverPrecise(sr.fee, symbol)) precBad = true; });'));
assert(s.includes('singleSourceFeeSc !== nfScChk'));
console.log('multi-source transfer regression checks passed');
