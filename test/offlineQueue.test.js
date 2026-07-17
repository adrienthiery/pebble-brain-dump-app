// Unit tests for the failed-send retry queue (Brain Dump pkjs)
// Run: node test/offlineQueue.test.js

// ============================================================
// Functions under test — keep in sync with src/pkjs/index.js
// ============================================================

var MAX_QUEUE_RETRIES = 5;
var MAX_QUEUE_LEN     = 10;

// Minimal localStorage stand-in (the pkjs runtime provides the real one).
var _store = {};
var localStorage = {
    getItem: function(k) { return _store.hasOwnProperty(k) ? _store[k] : null; },
    setItem: function(k, v) { _store[k] = String(v); },
    removeItem: function(k) { delete _store[k]; }
};
var KEY_QUEUE = 'brain_dump_queue_v1';

function getQueue() {
    try { var r = localStorage.getItem(KEY_QUEUE); return r ? JSON.parse(r) : []; }
    catch(e) { return []; }
}
function saveQueue(q) {
    try { localStorage.setItem(KEY_QUEUE, JSON.stringify(q)); } catch(e) {}
}
function enqueueFailed(text, dest, ts) {
    var q = getQueue();
    q.push({ text: text, dest: dest, ts: ts, tries: 0 });
    if (q.length > MAX_QUEUE_LEN) q = q.slice(q.length - MAX_QUEUE_LEN);
    saveQueue(q);
}
function queueAfterResult(q, ok) {
    if (!q.length) return q;
    var item = q.shift();
    if (ok) return q;
    item.tries = (item.tries || 0) + 1;
    if (item.tries < MAX_QUEUE_RETRIES) q.push(item);
    return q;
}

// ============================================================
// Test harness (same style as the other pkjs tests)
// ============================================================

var passed = 0;
var failed = 0;

function check(label, got, expected) {
    if (got === expected) {
        passed++;
        process.stdout.write('  ✓ ' + label + '\n');
    } else {
        failed++;
        process.stdout.write('  ✗ ' + label + '\n      got: ' + got + '\n expected: ' + expected + '\n');
    }
}
function checkObject(label, got, expected) {
    check(label, JSON.stringify(got), JSON.stringify(expected));
}
function section(name) {
    process.stdout.write('\n' + name + '\n');
}
function reset() { _store = {}; }

// ============================================================
// enqueueFailed — order + bounds
// ============================================================

section('enqueueFailed — order and bounds');

reset();
enqueueFailed('first',  'notion',  1000);
enqueueFailed('second', 'todoist', 1001);
enqueueFailed('third',  'webhook', 1002);
check('preserves FIFO insertion order',
    getQueue().map(function(e) { return e.text; }).join(','),
    'first,second,third');
check('keeps the original dictation timestamp', getQueue()[0].ts, 1000);
check('stores the resolved destination', getQueue()[1].dest, 'todoist');
check('new entries start at zero tries', getQueue()[2].tries, 0);

reset();
for (var i = 0; i < MAX_QUEUE_LEN + 10; i++) enqueueFailed('n' + i, 'notion', i);
check('caps queue length at MAX_QUEUE_LEN', getQueue().length, MAX_QUEUE_LEN);
check('drops oldest entries when full (newest kept)',
    getQueue()[getQueue().length - 1].text, 'n' + (MAX_QUEUE_LEN + 9));
check('oldest surviving entry is the expected one',
    getQueue()[0].text, 'n10');

// ============================================================
// queueAfterResult — success / failure / retry cap
// ============================================================

section('queueAfterResult — advancing the head');

check('success removes the head',
    queueAfterResult([{ text: 'a', tries: 0 }, { text: 'b', tries: 0 }], true)
        .map(function(e) { return e.text; }).join(','),
    'b');

check('empty queue is left alone',
    JSON.stringify(queueAfterResult([], true)), '[]');

var q = [{ text: 'a', tries: 0 }, { text: 'b', tries: 0 }];
q = queueAfterResult(q, false);
check('failure moves the head to the tail (b is now next up)',
    q.map(function(e) { return e.text; }).join(','), 'b,a');
check('failure increments tries on the re-appended item',
    q[q.length - 1].tries, 1);
check('a re-appended item keeps its text', q[q.length - 1].text, 'a');

section('queueAfterResult — retry cap');

// A permanently failing item cycles to the tail each time; it is dropped only
// once it has used up MAX_QUEUE_RETRIES attempts.
var poison = [{ text: 'bad', tries: 0 }];
for (var k = 0; k < MAX_QUEUE_RETRIES - 1; k++) poison = queueAfterResult(poison, false);
check('survives up to the cap (still queued, cycling)', poison.length, 1);
check('retry count reaches cap - 1 before the last attempt',
    poison[0].tries, MAX_QUEUE_RETRIES - 1);
poison = queueAfterResult(poison, false);
check('dropped once it exhausts MAX_QUEUE_RETRIES attempts', poison.length, 0);

// ============================================================
// End-to-end drain simulation (mirrors flushQueue control flow)
// ============================================================

section('drain simulation — per-destination failure isolation');

// Faithful synchronous mirror of flushStep() in index.js. `downDests` is the
// set of destinations that are unreachable for this simulated pass. Returns the
// list of note texts delivered during the pass, in the order they went out.
function drainPass(downDests) {
    var delivered = [];
    var down = {};        // destinations found down during this pass
    var rotated = 0;      // consecutive head-skips without a real attempt
    while (true) {
        var cur = getQueue();
        if (cur.length === 0) break;
        if (down[cur[0].dest]) {
            // Head bound for an already-down destination: rotate past it. When a
            // full lap yields no attemptable item, every remaining dest is down.
            if (rotated >= cur.length) break;
            cur.push(cur.shift());
            saveQueue(cur);
            rotated++;
            continue;
        }
        var item = cur[0];
        var ok = !downDests[item.dest];
        saveQueue(queueAfterResult(getQueue(), ok));
        if (ok) delivered.push(item.text);
        else    down[item.dest] = 1;
        rotated = 0;
    }
    return delivered;
}

// One destination down must not block notes bound for a healthy one.
reset();
enqueueFailed('w-1', 'webhook', 10);
enqueueFailed('n-1', 'notion',  11);
enqueueFailed('w-2', 'webhook', 12);
enqueueFailed('n-2', 'notion',  13);

var out = drainPass({ webhook: 1 }).sort().join(',');
check('notes for a healthy destination deliver despite another being down',
    out, 'n-1,n-2');
check('notes for the down destination stay queued',
    getQueue().map(function(e) { return e.text; }).sort().join(','), 'w-1,w-2');
check('a down destination is charged only one retry per pass (skip, not spin)',
    getQueue().reduce(function(s, e) { return s + (e.tries || 0); }, 0), 1);

section('drain simulation — outage then full recovery');

reset();
enqueueFailed('note-1', 'notion', 20);
enqueueFailed('note-2', 'notion', 21);
enqueueFailed('note-3', 'notion', 22);

// Offline: notion is down, so the first item is tried once and the rest are
// skipped for the pass — nothing delivered, retries not burned across the board.
var off = drainPass({ notion: 1 });
check('nothing delivered while offline', off.join(','), '');
check('only one retry charged during the outage pass',
    getQueue().reduce(function(s, e) { return s + (e.tries || 0); }, 0), 1);
check('all three notes still queued', getQueue().length, 3);

// Back online: the whole backlog drains (rotation may reorder a retried head).
var on = drainPass({});
check('all notes delivered once back online', on.slice().sort().join(','),
    'note-1,note-2,note-3');
check('queue is empty after a full drain', getQueue().length, 0);

// ============================================================
// Summary
// ============================================================

process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
