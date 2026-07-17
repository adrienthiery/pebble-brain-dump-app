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
    if (ok) { q.shift(); return q; }
    q[0].tries = (q[0].tries || 0) + 1;
    if (q[0].tries >= MAX_QUEUE_RETRIES) q.shift();
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
check('failure increments the head tries', q[0].tries, 1);
check('failure keeps the head in place (order preserved)',
    q.map(function(e) { return e.text; }).join(','), 'a,b');

section('queueAfterResult — retry cap');

var poison = [{ text: 'bad', tries: 0 }, { text: 'good', tries: 0 }];
for (var k = 0; k < MAX_QUEUE_RETRIES; k++) poison = queueAfterResult(poison, false);
check('a permanently failing head is dropped after the cap',
    poison.map(function(e) { return e.text; }).join(','), 'good');

// ============================================================
// End-to-end drain simulation (mirrors flushQueue control flow)
// ============================================================

section('drain simulation — outage then recovery, FIFO preserved');

reset();
enqueueFailed('note-1', 'notion',  10);
enqueueFailed('note-2', 'todoist', 11);
enqueueFailed('note-3', 'webhook', 12);

var delivered = [];

// One flush pass over the head, honouring the "stop on first failure" rule.
// Returns true when the head was delivered (so the caller keeps draining).
function flushOnce(online) {
    var cur = getQueue();
    if (!cur.length) return false;
    var head = cur[0];
    var ok = online;
    if (ok) delivered.push(head.text);
    saveQueue(queueAfterResult(getQueue(), ok));
    return ok;
}

// Network down: one trigger fires; head fails, draining stops.
flushOnce(false);
check('nothing delivered while offline', delivered.join(','), '');
check('head retry recorded, queue intact', getQueue()[0].tries, 1);
check('order unchanged during outage',
    getQueue().map(function(e) { return e.text; }).join(','), 'note-1,note-2,note-3');

// Network back: drain until the queue empties or the head fails.
while (flushOnce(true)) { /* keep draining */ }
check('all notes delivered in original order once online',
    delivered.join(','), 'note-1,note-2,note-3');
check('queue is empty after a full drain', getQueue().length, 0);

// ============================================================
// Summary
// ============================================================

process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
