"""Local, incremental rollout usage index. Standard library only."""
import hashlib
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

FIELDS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
          'output_tokens', 'reasoning_output_tokens')
METRICS = FIELDS + ('uncached_input_tokens', 'total_tokens', 'requests', 'cost',
                    'base_cost', 'cache_savings', 'unpriced_requests')


def numbers(value):
    return {k: max(0, int(value.get(k) or 0)) for k in FIELDS}


def empty():
    return dict.fromkeys(METRICS, 0)


def add(target, source):
    for k in METRICS:
        target[k] += source.get(k, 0)


def model_key(model):
    if model == 'gpt-5.6':
        return 'gpt-5.6-sol'
    return model or 'unknown'


def price_for(model, timestamp, pricing):
    """Resolve an observed model to its price schedule without hiding its raw ID."""
    key = pricing.get('model_aliases', {}).get(model, model)
    rule = pricing.get('temporal_aliases', {}).get(model)
    if rule:
        switch = datetime.fromisoformat(rule['from']).astimezone(timezone.utc)
        key = rule['after'] if datetime.fromisoformat(timestamp).astimezone(timezone.utc) >= switch else rule['before']
    return key, pricing['models'].get(key)


class Index:
    def __init__(self, root, cache):
        self.root = Path(root).expanduser().resolve()
        Path(cache).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(cache, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY, inode TEXT, size INTEGER, mtime INTEGER,
            offset INTEGER, state TEXT, edge TEXT, bad INTEGER);
          CREATE TABLE IF NOT EXISTS events (
            path TEXT, offset INTEGER, fingerprint TEXT, ts TEXT, model TEXT,
            usage TEXT, PRIMARY KEY(path, offset));
          CREATE INDEX IF NOT EXISTS event_fingerprint ON events(fingerprint);
        ''')
        self.scan_info = {}
        self.report_cache = {}

    @staticmethod
    def edge(f, offset):
        f.seek(max(0, offset - 512))
        return hashlib.sha256(f.read(min(512, offset))).hexdigest()

    def scan(self):
        started = time.monotonic()
        seen, changed, removed, read_bytes, errors = set(), 0, 0, 0, []
        if not self.root.is_dir():
            raise FileNotFoundError('日志目录不存在：' + str(self.root))
        for path in sorted(self.root.rglob('rollout-*.jsonl')):
            # Do not follow symlinked files out of the configured source.
            if path.is_symlink():
                continue
            name = str(path)
            seen.add(name)
            try:
                st = path.stat()
                inode = f'{st.st_dev}:{st.st_ino}'
                old = self.db.execute('SELECT * FROM files WHERE path=?', (name,)).fetchone()
                if old and (old['inode'], old['size'], old['mtime']) == (inode, st.st_size, st.st_mtime_ns):
                    continue
                with path.open('rb') as f, self.db:
                    offset, state, bad = 0, {'model': 'unknown'}, 0
                    if old and old['inode'] == inode and st.st_size > old['size'] and self.edge(f, old['offset']) == old['edge']:
                        offset, state, bad = old['offset'], json.loads(old['state']), old['bad']
                    else:
                        self.db.execute('DELETE FROM events WHERE path=?', (name,))
                    changed += 1
                    f.seek(offset)
                    while f.tell() < st.st_size:
                        pos = f.tell()
                        line = f.readline(st.st_size - pos)
                        read_bytes += len(line)
                        if not line.endswith(b'\n'):
                            f.seek(pos)  # Retry unfinished trailing line on next append.
                            break
                        offset = f.tell()
                        # Never deserialize conversation content unless it is a metadata/usage line.
                        if b'"token_count"' not in line and b'"turn_context"' not in line and b'"session_meta"' not in line:
                            continue
                        try:
                            event = json.loads(line)
                            self.consume(name, pos, event, state)
                        except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                            bad += 1
                    digest = self.edge(f, offset)
                    self.db.execute('INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?,?)',
                                    (name, inode, st.st_size, st.st_mtime_ns, offset, json.dumps(state), digest, bad))
            except OSError as exc:
                errors.append(f'{path.name}: {exc.strerror}')
        with self.db:
            for row in self.db.execute('SELECT path FROM files').fetchall():
                if row['path'] not in seen:
                    self.db.execute('DELETE FROM events WHERE path=?', (row['path'],))
                    self.db.execute('DELETE FROM files WHERE path=?', (row['path'],))
                    removed += 1
        if changed or removed:
            self.report_cache.clear()
        count = self.db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
        unique = self.db.execute('SELECT COUNT(DISTINCT fingerprint) FROM events').fetchone()[0]
        self.scan_info = dict(files=len(seen), changed_files=changed, bytes_read=read_bytes,
                              duration_ms=round((time.monotonic()-started)*1000),
                              duplicates_removed=count-unique,
                              malformed_lines=self.db.execute('SELECT COALESCE(SUM(bad),0) FROM files').fetchone()[0],
                              errors=errors, scanned_at=datetime.now(timezone.utc).isoformat())
        return self.scan_info

    def consume(self, path, offset, event, state):
        payload = event.get('payload') or {}
        if event.get('type') == 'session_meta':
            state['id'] = payload.get('id') or path
            return
        if event.get('type') == 'turn_context':
            state['model'] = model_key(payload.get('model'))
            return
        if event.get('type') != 'event_msg' or payload.get('type') != 'token_count' or not payload.get('info'):
            return
        info = payload['info']
        total = numbers(info['total_token_usage']) if info.get('total_token_usage') else None
        previous = state.get('total')
        if total is not None and total == previous:
            return  # Repeated cumulative totals are status refreshes, not requests.
        if total is not None:
            state['total'] = total
        usage = numbers(info['last_token_usage']) if info.get('last_token_usage') else None
        if usage is None and total is not None:
            usage = {k: total[k] - (previous or {}).get(k, 0) for k in FIELDS}
            if any(v < 0 for v in usage.values()):
                usage = total.copy()  # Counter reset / resumed session.
        if not usage or not (usage['input_tokens'] or usage['output_tokens']):
            return
        usage['cached_input_tokens'] = min(usage['cached_input_tokens'], usage['input_tokens'])
        usage['reasoning_output_tokens'] = min(usage['reasoning_output_tokens'], usage['output_tokens'])
        ts = datetime.fromisoformat(event['timestamp'].replace('Z', '+00:00'))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        stamp = ts.astimezone(timezone.utc).isoformat()
        model = model_key(info.get('model') or payload.get('model') or state.get('model'))
        # Copied fork histories retain timestamps/counters. Do not use the child file ID.
        identity = [stamp, model, total, usage]
        fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        self.db.execute('INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?)',
                        (path, offset, fingerprint, stamp, model, json.dumps(usage)))

    def logs(self, period, tz_name, pricing, page=1, limit=50, model='', now=None,
             date_filter=''):
        if page < 1 or limit not in (25, 50, 100):
            raise ValueError('Invalid page or page size')
        report = self.report(period, tz_name, pricing, now, model)
        tz = ZoneInfo(tz_name)
        if date_filter:
            try:
                selected = datetime.strptime(date_filter, '%Y-%m-%d').date()
            except ValueError as exc:
                raise ValueError('Invalid log date') from exc
            start_day = selected
            end_day = selected + timedelta(days=1)
        else:
            start_day = datetime.fromisoformat(report['start']).date()
            end_day = datetime.fromisoformat(report['end']).date() + timedelta(days=1)
        start = datetime.combine(start_day, datetime.min.time(), tz).astimezone(timezone.utc).isoformat()
        end = datetime.combine(end_day, datetime.min.time(), tz).astimezone(timezone.utc).isoformat()
        where = 'ts >= ? AND ts < ?'
        args = [start, end]
        if model:
            where += ' AND model = ?'
            args.append(model)
        count = self.db.execute(f'SELECT COUNT(DISTINCT fingerprint) FROM events WHERE {where}', args).fetchone()[0]
        pages = max(1, (count+limit-1)//limit)
        page = min(page, pages)
        rows = self.db.execute(f'''SELECT fingerprint, ts, model, path, offset, usage
            FROM events WHERE {where} GROUP BY fingerprint
            ORDER BY ts DESC, fingerprint DESC LIMIT ? OFFSET ?''', args+[limit, (page-1)*limit])
        items = []
        for row in rows:
            u = json.loads(row['usage'])
            u['uncached_input_tokens'] = u['input_tokens']-u['cached_input_tokens']
            u['total_tokens'] = u['input_tokens']+u['output_tokens']
            priced_as, rate = price_for(row['model'], row['ts'], pricing)
            costs = None
            if rate:
                writes = min(u['cache_write_input_tokens'], u['uncached_input_tokens'])
                costs = dict(input=(u['uncached_input_tokens']-writes)*rate['input']/1e6,
                             cached=u['cached_input_tokens']*rate['cached']/1e6,
                             cache_write=writes*rate.get('cache_write', rate['input'])/1e6,
                             output=u['output_tokens']*rate['output']/1e6)
            items.append(dict(id=row['fingerprint'], timestamp=row['ts'], model=row['model'],
                              source=Path(row['path']).name, byte_offset=row['offset'],
                              priced_as=priced_as if rate else None,
                              cost=sum(costs.values()) if costs else None, costs=costs, **u))
        report['logs'] = dict(items=items, total=count, page=page, pages=pages, limit=limit,
                              model=model, date=date_filter or None,
                              available_models=[r[0] for r in self.db.execute('SELECT DISTINCT model FROM events ORDER BY model')])
        return report

    def report(self, period, tz_name, pricing, now=None, model_filter=''):
        tz = ZoneInfo(tz_name)
        today = (now or datetime.now(timezone.utc)).astimezone(tz).date()
        cache_key = (period, tz_name, today, model_filter,
                     json.dumps(pricing, sort_keys=True))
        if cache_key in self.report_cache:
            return dict(self.report_cache[cache_key], scan=self.scan_info)
        daily, models = {}, set(pricing['featured'])
        query = 'SELECT ts,model,usage FROM events'
        if model_filter:
            query += ' WHERE model=?'
        for row in self.db.execute(query+' GROUP BY fingerprint', [model_filter] if model_filter else []):
            day = datetime.fromisoformat(row['ts']).astimezone(tz).date().isoformat()
            if day > today.isoformat():
                continue
            observed_model = row['model']
            priced_as, rate = price_for(observed_model, row['ts'], pricing)
            model = priced_as if rate else observed_model
            models.add(model)
            u = json.loads(row['usage'])
            u.update(uncached_input_tokens=u['input_tokens']-u['cached_input_tokens'],
                     total_tokens=u['input_tokens']+u['output_tokens'], requests=1,
                     cost=0, base_cost=0, cache_savings=0, unpriced_requests=0)
            if rate:
                # A base-rate equivalent deliberately excludes context / service-tier uplifts.
                writes = min(u['cache_write_input_tokens'], u['uncached_input_tokens'])
                u['cost'] = ((u['uncached_input_tokens']-writes)*rate['input'] +
                             writes*rate.get('cache_write', rate['input']) +
                             u['cached_input_tokens']*rate['cached'] + u['output_tokens']*rate['output'])/1e6
                u['base_cost'] = u['cost']
                u['cache_savings'] = u['cached_input_tokens']*(rate['input']-rate['cached'])/1e6
            else:
                u['unpriced_requests'] = 1
            bucket = daily.setdefault(day, {}).setdefault(model, empty())
            add(bucket, u)
        first = min(daily) if daily else today.isoformat()
        if period == '7d':
            start = today-timedelta(days=6)
        elif period == '30d':
            start = today-timedelta(days=29)
        elif period == 'mtd':
            start = today.replace(day=1)
        elif period == 'all':
            start = datetime.fromisoformat(first).date()
        else:
            raise ValueError('Unknown time range')
        days = (today-start).days+1
        totals, by_model, trend = empty(), {m: empty() for m in models}, []
        longest = streak = active = 0
        for i in range(days):
            day = (start+timedelta(days=i)).isoformat()
            values = daily.get(day, {})
            t = empty()
            for model, u in values.items():
                add(t, u)
                add(by_model[model], u)
            add(totals, t)
            active += bool(t['requests'])
            streak = streak+1 if t['requests'] else 0
            longest = max(longest, streak)
            trend.append(dict(date=day, models=values, **t))
        previous = empty()
        for i in range(days):
            day = (start-timedelta(days=i+1)).isoformat()
            for u in daily.get(day, {}).values():
                add(previous, u)
        calendar = []
        calendar_start = datetime.fromisoformat(first).date().replace(month=1, day=1)
        for i in range((today-calendar_start).days+1):
            day = (calendar_start+timedelta(days=i)).isoformat()
            t = empty()
            for u in daily.get(day, {}).values():
                add(t, u)
            calendar.append(dict(date=day, **t))
        result = dict(range=period, timezone=tz_name, start=start.isoformat(), end=today.isoformat(),
                    first_date=first, totals=totals, previous=previous if period != 'all' else None,
                    days=days, active_days=active, longest_streak=longest,
                    avg_day=totals['total_tokens']/days, avg_week=totals['total_tokens']/days*7,
                    models=[dict(id=m, **u) for m,u in sorted(by_model.items(), key=lambda x:-x[1]['total_tokens'])],
                    daily=trend, calendar=calendar, scan=self.scan_info, pricing=pricing)
        if len(self.report_cache) >= 32:
            self.report_cache.clear()
        self.report_cache[cache_key] = result
        return dict(result)
