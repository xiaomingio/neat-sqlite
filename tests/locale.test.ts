/*
Purpose: Verify parameterized interface messages keep language-specific word order.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Locale } from '../src/webview/Locale';

test('messages interpolate parameters after translation and leave unknown text intact', () => {
  const english = new Locale('en'); const chinese = new Locale('zh-CN');
  assert.equal(english.t('Delete {count} records?', { count: 3 }), 'Delete 3 records?');
  assert.equal(chinese.t('Delete {count} records?', { count: 3 }), '删除 3 条记录？');
  assert.equal(chinese.t('Filter {column}', { column: '{count}' }), '筛选 {count}');
  assert.equal(chinese.t('A database error mentioning {braces}'), 'A database error mentioning {braces}');
  assert.equal(english.t('Rows: {start}–{end}', { start: 1, end: 200 }), 'Rows: 1–200');
});
