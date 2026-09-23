import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analytics import Index, price_for

PRICING = {'featured': ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra'],
           'models': {'gpt-5.6-luna': {'input': .2, 'cached': .02, 'output': 1.2}}}
NOW = datetime(2026, 9, 13, 12, tzinfo=timezone.utc)


def context(model='gpt-5.6-luna'):
    return {'type': 'turn_context', 'payload': {'model': model}}


def token(total, last=None, stamp='2026-09-12T16:30:00Z'):
    return {'timestamp': stamp, 'type': 'event_msg', 'payload': {'type': 'token_count',
            'info': {'total_token_usage': total, 'last_token_usage': last}}}


def usage(i=100, c=80, o=10, r=4):
    return dict(input_tokens=i, cached_input_tokens=c, output_tokens=o, reasoning_output_tokens=r)


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)/'sessions'
        self.root.mkdir()
        self.path = self.root/'rollout-a.jsonl'
        self.index = Index(self.root, Path(self.tmp.name)/'cache.sqlite3')

    def tearDown(self):
        self.index.db.close()
        self.tmp.cleanup()

    def write(self, events, path=None, mode='w'):
        with (path or self.path).open(mode) as f:
            for e in events:
                f.write(json.dumps(e)+'\n')

    def report(self, period='all', tz='Asia/Singapore'):
        self.index.scan()
        return self.index.report(period, tz, PRICING, NOW)

    def test_duplicate_status_and_fork_history(self):
        events = [context(), token(usage(), usage()), token(usage(), usage(), '2026-09-12T16:31:00Z')]
        self.write(events)
        self.write(events, self.root/'rollout-copy.jsonl')
        r = self.report()
        self.assertEqual(r['totals']['requests'], 1)
        self.assertEqual(r['totals']['total_tokens'], 110)
        self.assertEqual(r['scan']['duplicates_removed'], 1)

    def test_incremental_partial_line_restart(self):
        self.write([context(), token(usage(), usage())])
        self.report()
        self.assertEqual(self.report()['scan']['bytes_read'], 0)
        pending = json.dumps(token(usage(200, 160, 20, 8), usage(), '2026-09-13T01:00:00Z'))
        with self.path.open('a') as f:
            f.write(pending[:50])
        self.assertEqual(self.report()['totals']['requests'], 1)
        self.index.db.close()
        self.index = Index(self.root, Path(self.tmp.name)/'cache.sqlite3')
        with self.path.open('a') as f:
            f.write(pending[50:]+'\n')
        self.assertEqual(self.report()['totals']['requests'], 2)

    def test_model_switch_reset_and_missing_last(self):
        self.write([context(), token(usage(), usage()), context('gpt-6-astra'),
                    token(usage(200,160,20,8), None, '2026-09-13T01:00:00Z'),
                    token(usage(50,20,2,1), usage(50,20,2,1), '2026-09-13T02:00:00Z')])
        r=self.report()
        self.assertEqual(r['totals']['input_tokens'], 250)
        self.assertEqual(r['totals']['requests'], 3)
        self.assertEqual(r['totals']['unpriced_requests'], 2)
        self.assertEqual(next(m for m in r['models'] if m['id']=='gpt-6-astra')['requests'], 2)

    def test_truncate_replace_delete(self):
        self.write([context(), token(usage(), usage())])
        self.report()
        self.write([context(), token(usage(20,10,2,1), usage(20,10,2,1))])
        self.assertEqual(self.report()['totals']['total_tokens'], 22)
        self.path.unlink()
        self.assertEqual(self.report()['totals']['requests'], 0)

    def test_timezone_zero_days_and_price(self):
        self.write([context(), token(usage(), usage())])
        r=self.report('7d')
        self.assertEqual(r['daily'][-1]['requests'], 1)
        self.assertEqual(r['days'], 7)
        self.assertEqual(r['avg_day'], 110/7)
        self.assertEqual(r['longest_streak'], 1)
        self.assertAlmostEqual(r['totals']['cost'], (20*.2+80*.02+10*1.2)/1e6)
        self.assertEqual(self.report('7d','UTC')['daily'][-2]['requests'], 1)

    def test_logs_pagination_filter_and_totals(self):
        events = [context()]
        for i in range(31):
            events.append(token(usage(100*(i+1),80*(i+1),10*(i+1),4*(i+1)), usage(), f'2026-09-12T16:{i:02d}:00Z'))
        events += [context('unknown-model'), token(usage(3200,2560,320,128), usage(), '2026-09-13T03:00:00Z')]
        self.write(events)
        self.write(events, self.root/'rollout-copy.jsonl')
        self.index.scan()
        first = self.index.logs('7d', 'Asia/Singapore', PRICING, limit=25, now=NOW)
        second = self.index.logs('7d', 'Asia/Singapore', PRICING, page=2, limit=25, now=NOW)
        rows = first['logs']['items']+second['logs']['items']
        self.assertEqual(len(rows), 32)
        self.assertEqual(len({r['id'] for r in rows}), 32)
        self.assertEqual(first['logs']['total'], first['totals']['requests'])
        self.assertEqual(sum(r['input_tokens'] for r in rows), first['totals']['input_tokens'])
        self.assertAlmostEqual(sum(r['cost'] or 0 for r in rows), first['totals']['cost'])
        self.assertIsNone(rows[0]['cost'])
        filtered = self.index.logs('7d', 'UTC', PRICING, model='gpt-5.6-luna', now=NOW)
        self.assertEqual(filtered['logs']['total'], 31)
        self.assertEqual(filtered['totals']['requests'], 31)
        self.assertEqual(filtered['logs']['items'][0]['timestamp'], '2026-09-12T16:30:00+00:00')
        dated = self.index.logs('all', 'Asia/Singapore', PRICING, limit=25,
                                now=NOW, date_filter='2026-09-13')
        self.assertEqual(dated['logs']['date'], '2026-09-13')
        self.assertEqual(dated['logs']['total'], 32)
        self.assertTrue(all(item['timestamp'] >= '2026-09-12T16:00:00+00:00'
                            for item in dated['logs']['items']))
        with self.assertRaises(ValueError):
            self.index.logs('all', 'UTC', PRICING, now=NOW, date_filter='13/09/2026')
        with self.assertRaises(ValueError):
            self.index.logs('all', 'UTC', PRICING, page=0, now=NOW)

    def test_alias_and_malformed_usage(self):
        self.write([context('gpt-5.6'), token(usage(), usage())])
        with self.path.open('a') as f:
            f.write('{"type":"event_msg","payload":{"type":"token_count" broken}\n')
        r=self.report()
        self.assertEqual(r['scan']['malformed_lines'], 1)
        self.assertEqual(next(m for m in r['models'] if m['id']=='gpt-5.6-sol')['requests'], 1)

    def test_observed_model_pricing_mapping_and_switch(self):
        pricing = json.loads((Path(__file__).resolve().parents[1]/'pricing.json').read_text())
        before='2026-07-30T17:17:09+00:00'
        after='2026-07-30T17:17:11+00:00'
        self.assertEqual(price_for('gpt-reserve', after, pricing)[0], 'gpt-5.6-luna')
        self.assertEqual(price_for('gpt-5.3-codex-spark', before, pricing)[0], 'gpt-5.3-codex')
        self.assertEqual(price_for('codex-auto-review', before, pricing)[0], 'gpt-5.4-mini')
        self.assertEqual(price_for('codex-auto-review', after, pricing)[0], 'gpt-5.6-luna')
        events = [context('codex-auto-review'),
                  token(usage(), usage(), before),
                  token(usage(200,160,20,8), usage(), after),
                  context('gpt-reserve'), token(usage(300,240,30,12), usage(), '2026-08-30T01:00:00Z'),
                  context('gpt-5.3-codex-spark'), token(usage(400,320,40,16), usage(), '2026-05-08T01:00:00Z')]
        self.write(events)
        self.index.scan()
        report = self.index.logs('all', 'UTC', pricing, limit=25, now=NOW)
        self.assertEqual(report['totals']['unpriced_requests'], 0)
        self.assertEqual(report['totals']['requests'], 4)
        self.assertAlmostEqual(sum(x['cost'] for x in report['logs']['items']), report['totals']['cost'])
        self.assertEqual(next(m for m in report['models'] if m['id']=='gpt-5.6-luna')['requests'], 2)
        self.assertEqual(next(m for m in report['models'] if m['id']=='gpt-5.4-mini')['requests'], 1)
        self.assertEqual(next(m for m in report['models'] if m['id']=='gpt-5.3-codex')['requests'], 1)

    def test_report_cache_tracks_log_and_pricing_changes(self):
        self.write([context(), token(usage(), usage())])
        self.index.scan()
        first = self.index.report('all', 'UTC', PRICING, now=NOW)
        self.assertEqual(first['totals']['requests'], 1)
        self.assertEqual(self.index.report('all', 'UTC', PRICING, now=NOW)['totals'], first['totals'])
        changed_pricing = json.loads(json.dumps(PRICING))
        changed_pricing['models']['gpt-5.6-luna']['output'] = 2.4
        self.assertGreater(self.index.report('all', 'UTC', changed_pricing, now=NOW)['totals']['cost'],
                           first['totals']['cost'])
        self.write([token(usage(200, 160, 20, 8), usage(), '2026-09-12T17:00:00Z')], mode='a')
        self.index.scan()
        self.assertEqual(self.index.report('all', 'UTC', PRICING, now=NOW)['totals']['requests'], 2)

    def test_historical_and_new_model_prices(self):
        pricing = json.loads((Path(__file__).resolve().parents[1]/'pricing.json').read_text())
        expected = {
            'gpt-5': (1.25, .125, 10), 'gpt-5.1': (1.25, .125, 10),
            'gpt-5.2': (1.75, .175, 14), 'gpt-5.3-codex': (1.75, .175, 14),
            'gpt-6-sol': (2, .2, 10), 'gpt-6-luna': (.1, .01, .5),
        }
        for model, rates in expected.items():
            with self.subTest(model=model):
                actual = pricing['models'][model]
                self.assertEqual((actual['input'], actual['cached'], actual['output']), rates)
        self.assertEqual(price_for('gpt-5.0', '2026-09-01T00:00:00Z', pricing)[0], 'gpt-5')


if __name__ == '__main__':
    unittest.main()
