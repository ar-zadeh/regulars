import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {DEFAULT_SETTINGS,validateSettings,readSettings,writeSettings} from '../src/config.js';

test('dashboard settings validate patches, bounds, and dependencies',()=>{
  assert.deepEqual(validateSettings({}),DEFAULT_SETTINGS);
  assert.equal(validateSettings({regularMode:'consecutive',regularMinimum:10}).regularMinimum,10);
  for(const invalid of [null,[],{other:1},{regularMinimum:6},{regularMinimum:0},{regularMinimum:1.5},{hypeMinContributors:1},{matchThreshold:NaN},{matchThreshold:0.3},{maybeThreshold:0.8},{nightOwlStart:'24:00'},{nightOwlStart:'05:00'}]) assert.throws(()=>validateSettings(invalid));
  assert.equal(validateSettings({nightOwlStart:'23:00',nightOwlEnd:'06:00'}).nightOwlStart,'23:00');
});

test('settings persist as one validated record and invalid changes are atomic',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    assert.deepEqual(readSettings(db),DEFAULT_SETTINGS);
    const next=validateSettings({regularMode:'consecutive',regularMinimum:8});
    writeSettings(db,next);
    assert.deepEqual(readSettings(db),next);
    assert.throws(()=>writeSettings(db,{...next,nightOwlEnd:'00:00'}));
    assert.deepEqual(readSettings(db),next);
  }finally{db.close();}
});
