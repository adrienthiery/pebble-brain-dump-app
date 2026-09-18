// Integration-focused tests for the Pebble Timeline destination.
// Run: node test/timelineFormat.test.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pkjsPath = path.join(__dirname, '..', 'src', 'pkjs', 'index.js');
var watchPath = path.join(__dirname, '..', 'src', 'c', 'main.c');
var pkjsSource = fs.readFileSync(pkjsPath, 'utf8');
var watchSource = fs.readFileSync(watchPath, 'utf8');

var listeners = {};
var storage = {};
var sentToWatch = [];
var openedUrl = '';
var tokenResult = { ok: true, value: 'user-token' };
var tokenCalls = 0;

var context = {
    console: { log: function() {} },
    setTimeout: function(callback) { callback(); },
    localStorage: {
        getItem: function(key) {
            return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
        },
        setItem: function(key, value) { storage[key] = String(value); },
        removeItem: function(key) { delete storage[key]; }
    },
    Pebble: {
        addEventListener: function(name, handler) { listeners[name] = handler; },
        sendAppMessage: function(message, onSuccess) {
            sentToWatch.push(message);
            if (onSuccess) onSuccess();
        },
        openURL: function(url) { openedUrl = url; },
        getTimelineToken: function(onSuccess, onFailure) {
            tokenCalls++;
            if (tokenResult.ok) onSuccess(tokenResult.value);
            else onFailure('no token');
        }
    }
};

vm.createContext(context);
vm.runInContext(pkjsSource, context, { filename: pkjsPath });

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

function installFakeXhr() {
    var requests = [];

    function FakeXhr() {
        this.headers = {};
        requests.push(this);
    }

    FakeXhr.prototype.open = function(method, url) {
        this.method = method;
        this.url = url;
    };
    FakeXhr.prototype.setRequestHeader = function(name, value) {
        this.headers[name] = value;
    };
    FakeXhr.prototype.send = function(body) { this.body = body; };
    FakeXhr.prototype.respond = function(status, responseText) {
        this.status = status;
        this.responseText = responseText || '';
        this.onload();
    };
    FakeXhr.prototype.failNetwork = function() { this.onerror(); };

    context.XMLHttpRequest = FakeXhr;
    return requests;
}

// The local calendar day extractDueDate resolves a phrase to, so expectations
// follow the same day the destination uses without re-deriving date logic here.
function dueDay(phrase) {
    var dp = context.extractDueDate(phrase).substring(0, 10).split('-');
    return new Date(parseInt(dp[0], 10), parseInt(dp[1], 10) - 1, parseInt(dp[2], 10));
}

function send(text, retryState) {
    var requests = installFakeXhr();
    var result = {};
    context.sendToTimeline(text, {}, function(ok, data, state) {
        result.ok = ok;
        result.data = data;
        result.state = state;
    }, retryState);
    return { requests: requests, result: result };
}

// ---------------------------------------------------------------------------
section('Pin creation');
var tomorrow = dueDay('tomorrow');
var created = send('Call the dentist tomorrow at 15:30', { timestamp: 1700000000 });
var pinReq = created.requests[0];
var pin = JSON.parse(pinReq.body);
var pinDate = new Date(pin.time);

check('puts the pin to the user pins endpoint', pinReq.method, 'PUT');
check('addresses the pin by its id', pinReq.url,
    'https://timeline-api.rebble.io/v1/user/pins/' + pin.id);
check('authenticates with the user timeline token', pinReq.headers['X-User-Token'], 'user-token');
check('sends JSON', pinReq.headers['Content-Type'], 'application/json');
check('pins at the spoken hour', pinDate.getHours(), 15);
check('pins at the spoken minute', pinDate.getMinutes(), 30);
check('pins on the spoken day', pinDate.toDateString(), tomorrow.toDateString());
check('titles the pin without the date/time tail', pin.layout.title, 'Call the dentist');
check('keeps the full dictation in the body', pin.layout.body, 'Call the dentist tomorrow at 15:30');
check('uses the generic pin layout', pin.layout.type, 'genericPin');
check('rings a reminder at the pin time', pin.reminders[0].time, pin.time);
checkObject('gives the reminder its own layout', pin.reminders[0].layout, {
    type: 'genericReminder',
    title: 'Call the dentist',
    tinyIcon: 'system://images/NOTIFICATION_REMINDER'
});
check('keeps the pin id within the 64-character limit', pin.id.length <= 64, true);

pinReq.respond(200, '');
checkObject('reports success once the pin is stored', created.result,
    { ok: true, data: 'timeline', state: undefined });

var dayOnly = JSON.parse(send('Renew passport tomorrow', { timestamp: 1 }).requests[0].body);
check('falls back to 9:00 when only a day is given', new Date(dayOnly.time).getHours(), 9);

var past = JSON.parse(send('Standup today at 00:00', { timestamp: 2 }).requests[0].body);
check('skips the reminder when the time has already passed', 'reminders' in past, false);

var plainTitle = JSON.parse(send('Dentist tomorrow', { timestamp: 3 }).requests[0].body);
check('still titles a short note', plainTitle.layout.title, 'Dentist');

// ---------------------------------------------------------------------------
section('Titles from dictation');
// The whole live path: the watch sends raw dictation, the router cleans it,
// and the pin title must keep only what to be reminded of.
function dictatedTitle(dictation) {
    storage.brain_dump_cfg_v1 = JSON.stringify({ timeline_enabled: true });
    var requests = installFakeXhr();
    listeners.appmessage({ payload: { NOTE_TEXT: dictation } });
    return requests.length ? JSON.parse(requests[0].body).layout.title : '(no pin)';
}
check('drops a date and time spoken before the task',
    dictatedTitle('Remind me tomorrow at 3pm to call mom'), 'Call mom');
check('drops a time hidden behind the closing period',
    dictatedTitle('Remind me to call mom at 15:00.'), 'Call mom');
check('drops a "set a reminder for" lead-in',
    dictatedTitle('Set a reminder for tomorrow at 9am to renew the passport'), 'Renew the passport');
check('drops a "Reminder:" label',
    dictatedTitle('Reminder: water the plants tonight'), 'Water the plants');
check('drops an "add to my timeline" lead-in',
    dictatedTitle('Add to my timeline dentist on Friday at 10am'), 'Dentist');
check('drops an "on my timeline" tail',
    dictatedTitle('Feed the cat tomorrow at 8am on my timeline'), 'Feed the cat');
check('drops German trigger words and a leading time',
    dictatedTitle('Erinnere mich morgen um 15 Uhr Mama anzurufen.'), 'Mama anzurufen');
check('drops French trigger words and a trailing time',
    dictatedTitle('Rappelle-moi d\'appeler maman demain \xe0 15h.'), 'Appeler maman');

// ---------------------------------------------------------------------------
section('Retries');
var first = send('Water the plants tomorrow at 18:00', { timestamp: 1700000100 });
var second = send('Water the plants tomorrow at 18:00', { timestamp: 1700000100 });
check('reuses the pin id for the same note so a retry cannot duplicate it',
    JSON.parse(first.requests[0].body).id, JSON.parse(second.requests[0].body).id);

var other = send('Water the garden tomorrow at 18:00', { timestamp: 1700000100 });
check('gives a different note a different id even in the same second',
    JSON.parse(other.requests[0].body).id !== JSON.parse(first.requests[0].body).id, true);

first.requests[0].respond(503, '');
check('hands back the resolved pin time for the queue', first.result.state.pinTime,
    new Date(JSON.parse(first.requests[0].body).time).getTime());
check('hands back the dictation timestamp for the queue', first.result.state.timestamp, 1700000100);

var fixedTime = new Date(2030, 0, 2, 7, 45).getTime();
var replay = send('Water the plants tomorrow at 18:00', { timestamp: 1700000100, pinTime: fixedTime });
check('keeps the originally resolved time on a later retry',
    JSON.parse(replay.requests[0].body).time, new Date(fixedTime).toISOString());

// ---------------------------------------------------------------------------
section('Errors');
tokenCalls = 0;
var noTime = send('Buy more coffee beans', undefined);
checkObject('refuses a note with no date or time', noTime.result,
    { ok: false, data: 'No date or time in note', state: undefined });
check('asks for no token when there is nothing to pin', tokenCalls, 0);
check('makes no request when there is nothing to pin', noTime.requests.length, 0);

tokenResult = { ok: false };
var noToken = send('Call mom tomorrow at 10:00', { timestamp: 5 });
check('reports an unavailable timeline when no token is issued', noToken.result.data,
    'Timeline unavailable');
check('lets a token failure be queued', typeof noToken.result.state.pinTime, 'number');
check('makes no request without a token', noToken.requests.length, 0);
tokenResult = { ok: true, value: 'user-token' };

function failWith(status) {
    var s = send('Call mom tomorrow at 10:00', { timestamp: 6 });
    s.requests[0].respond(status, '');
    return s.result.data;
}
check('maps 400 to a rejected pin', failWith(400), 'Pin rejected');
check('maps 410 to an invalid token', failWith(410), 'Timeline token invalid');
check('maps 429 to rate limiting', failWith(429), 'Rate limited');
check('falls back to the status code for other errors', failWith(500), 'Error 500');

var network = send('Call mom tomorrow at 10:00', { timestamp: 7 });
network.requests[0].failNetwork();
check('reports a network error when the request never lands', network.result.data, 'Network error');

// ---------------------------------------------------------------------------
section('Routing');
var both = { tasks_enabled: true, timeline_enabled: true };
var bothEnabled = context.getEnabledDests(both);
check('exposes the timeline as its own destination', bothEnabled.indexOf('timeline') >= 0, true);
check('routes a timed reminder to the timeline over Google Tasks',
    context.classifyIntent('remind me to call mom at 3pm', bothEnabled, both), 'timeline');
check('leaves an untimed errand with Google Tasks',
    context.classifyIntent('buy milk tomorrow', bothEnabled, both), 'tasks');
check('routes a note naming the timeline to the timeline',
    context.classifyIntent('put the vet on my timeline friday', bothEnabled, both), 'timeline');
check('routes a French reminder to the timeline',
    context.classifyIntent('rappelle-moi le dentiste demain \xe0 16h', bothEnabled, both), 'timeline');
check('honours custom routing keywords',
    context.classifyIntent('ping me about the oven',
        bothEnabled, { tasks_enabled: true, timeline_enabled: true, timeline_keywords: 'ping me' }),
    'timeline');

var aiAndTimeline = { ai_enabled: true, timeline_enabled: true };
check('redirects a timed reminder away from AI to the timeline',
    context.pickDest('remind me what to buy at 5pm?', context.getEnabledDests(aiAndTimeline),
        aiAndTimeline, false), 'timeline');
check('keeps an untimed reminder away from a timeline that cannot pin it',
    context.pickDest('remind me what to buy?', context.getEnabledDests(aiAndTimeline),
        aiAndTimeline, false), 'local');

check('queues timeline sends that fail', context.QUEUEABLE_DESTS.timeline, 1);
check('gives the timeline the watch destination index', context.DEST_INDEX.timeline, 10);
check('sets only the timeline bit when it alone is enabled',
    context.computeDestMask({ timeline_enabled: true }), 1024);
check('combines the timeline and Google Tasks bits', context.computeDestMask(both), 1025);

storage.brain_dump_cfg_v1 = JSON.stringify({ timeline_enabled: true });
sentToWatch.length = 0;
listeners.appmessage({ payload: { NOTE_TEXT: 'Dentist tomorrow at 15:00', NOTE_IS_CLASSIFY_ONLY: 1 } });
var preview = sentToWatch[sentToWatch.length - 1];
check('previews the timeline destination on the review screen', preview.ROUTING_DONE, 10);
check('shows the pin time on the review screen', preview.DUE_LABEL, 'Tomorrow 15:00');

// ---------------------------------------------------------------------------
section('Google Tasks timeline reminders');
var TASKS_CFG = { tasks_access_token: 'g-token', tasks_timeline_reminder: true };

function sendTask(text, cfg) {
    var requests = installFakeXhr();
    var results = [];
    context.sendToTasks(text, cfg, function(ok, data) {
        results.push({ ok: ok, data: data });
    }, { timestamp: 1700000200 });
    return { requests: requests, results: results };
}

var timedTask = sendTask('Call the bank tomorrow at 15:00', TASKS_CFG);
check('creates the Google task first',
    timedTask.requests[0].url.indexOf('https://tasks.googleapis.com/') === 0, true);
check('pins nothing before the task exists', timedTask.requests.length, 1);
timedTask.requests[0].respond(200, '{"id":"task-1"}');
checkObject('reports the task result unchanged', timedTask.results,
    [{ ok: true, data: { taskId: 'task-1' } }]);
var taskPinReq = timedTask.requests[1];
check('then pins a timeline reminder', taskPinReq && taskPinReq.method, 'PUT');
var taskPin = JSON.parse(taskPinReq.body);
check('rings at the time Google Tasks drops', new Date(taskPin.time).getHours(), 15);
check('titles the reminder like the task', taskPin.layout.title, 'Call the bank');
check('keeps the time in the task notes too',
    JSON.parse(timedTask.requests[0].body).notes, 'Due at 15:00');

taskPinReq.respond(500, '');
check('keeps a failed pin out of the send result — a retry would duplicate the task',
    timedTask.results.length, 1);

var untimedTask = sendTask('Call the bank tomorrow', TASKS_CFG);
untimedTask.requests[0].respond(200, '{"id":"task-2"}');
check('pins nothing when no time was spoken', untimedTask.requests.length, 1);

var optedOut = sendTask('Call the bank tomorrow at 15:00', { tasks_access_token: 'g-token' });
optedOut.requests[0].respond(200, '{"id":"task-3"}');
check('pins nothing when the setting is off', optedOut.requests.length, 1);

var failedTask = sendTask('Call the bank tomorrow at 15:00', TASKS_CFG);
failedTask.requests[0].respond(500, '');
check('pins nothing when the task was not created', failedTask.requests.length, 1);

var refreshed = sendTask('Call the bank tomorrow at 15:00', {
    tasks_access_token: 'old', tasks_refresh_token: 'refresh', tasks_timeline_reminder: true
});
refreshed.requests[0].respond(401, '');
refreshed.requests[1].respond(200, '{"access_token":"new"}');
refreshed.requests[2].respond(200, '{"id":"task-4"}');
check('still pins once a refreshed token created the task',
    refreshed.requests[3] && refreshed.requests[3].method, 'PUT');
check('pins only once after a token refresh', refreshed.requests.length, 4);

// ---------------------------------------------------------------------------
section('Settings and watch wiring');
var savedCfg = { timeline_enabled: true, timeline_keywords: 'ping me' };
listeners.webviewclosed({ response: encodeURIComponent(JSON.stringify(savedCfg)) });
checkObject('persists every timeline field', JSON.parse(storage.brain_dump_cfg_v1), savedCfg);
check('updates the watch mask after saving timeline settings',
    sentToWatch[sentToWatch.length - 1].DEST_MASK, 1024);

context.openSettings();
var settingsHtml = decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1));
check('renders the timeline enable and keyword controls',
    settingsHtml.indexOf('id="timeline_enabled"') >= 0 &&
    settingsHtml.indexOf('id="timeline_keywords"') >= 0, true);
check('reads both timeline fields back when saving',
    settingsHtml.indexOf('timeline_enabled:document.getElementById("timeline_enabled").checked') >= 0 &&
    settingsHtml.indexOf('timeline_keywords:document.getElementById("timeline_keywords")') >= 0, true);
check('offers the timeline as a default destination',
    settingsHtml.indexOf('<option value="timeline"') >= 0, true);
check('offers the Google Tasks timeline reminder toggle',
    settingsHtml.indexOf('id="tasks_timeline_reminder"') >= 0, true);
check('reads the Google Tasks reminder toggle back when saving',
    settingsHtml.indexOf('tasks_timeline_reminder:document.getElementById("tasks_timeline_reminder").checked') >= 0, true);
check('dims the timeline with the other services when smart routing is off',
    settingsHtml.indexOf('"joplin","timeline"') >= 0, true);

check('assigns the timeline its own watch destination index',
    /#define DEST_TIMELINE\s+10/.test(watchSource), true);
check('shows the timeline by name on the watch',
    /case DEST_TIMELINE:\s+return "Timeline"/.test(watchSource), true);
check('renders a timeline glyph on the watch',
    /case DEST_TIMELINE:\s+draw_glyph_letter\(ctx, 'R'/.test(watchSource), true);

process.stdout.write('\nPassed: ' + passed + '  Failed: ' + failed + '\n');
if (failed > 0) process.exit(1);
