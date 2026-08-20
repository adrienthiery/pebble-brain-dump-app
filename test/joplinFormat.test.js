// Integration-focused tests for the Joplin destination.
// Run: node test/joplinFormat.test.js

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
        openURL: function(url) { openedUrl = url; }
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
    FakeXhr.prototype.timeoutNow = function() { this.ontimeout(); };

    context.XMLHttpRequest = FakeXhr;
    return requests;
}

var BASE_CFG = {
    joplin_url: 'https://joplin.example.com/',
    joplin_token: 'tok en',
    joplin_notebook_id: 'nb-1'
};

function cfgWith(extra) {
    var c = {};
    Object.keys(BASE_CFG).forEach(function(k) { c[k] = BASE_CFG[k]; });
    Object.keys(extra || {}).forEach(function(k) { c[k] = extra[k]; });
    return c;
}

// ---------------------------------------------------------------------------
section('Note creation');
var requests = installFakeXhr();
var delivery;
context.sendToJoplin('Buy milk tomorrow', cfgWith({}), function(ok, data) {
    delivery = { ok: ok, data: data };
});

check('posts to the Data API /notes endpoint', requests[0].method, 'POST');
check('strips the trailing slash and passes the token in the query string',
    requests[0].url, 'https://joplin.example.com/notes?token=tok%20en');
check('sends JSON', requests[0].headers['Content-Type'], 'application/json');
checkObject('builds title, body, source and notebook', JSON.parse(requests[0].body), {
    title: 'Buy milk tomorrow',
    body: 'Buy milk tomorrow',
    source_url: 'pebble://brain-dump',
    parent_id: 'nb-1'
});

requests[0].respond(200, '{"id":"note-1"}');
checkObject('reports success once the note is created', delivery, { ok: true, data: 'joplin' });
check('sends nothing more when no tags are configured', requests.length, 1);

var longRequests = installFakeXhr();
var longText = new Array(200).join('x');
context.sendToJoplin(longText, cfgWith({}), function() {});
check('truncates the title to 80 characters',
    JSON.parse(longRequests[0].body).title.length, 80);
check('keeps the full text in the body',
    JSON.parse(longRequests[0].body).body, longText);

var noNotebookRequests = installFakeXhr();
context.sendToJoplin('No notebook', cfgWith({ joplin_notebook_id: '' }), function() {});
check('omits parent_id so Joplin picks its default notebook',
    'parent_id' in JSON.parse(noNotebookRequests[0].body), false);

// ---------------------------------------------------------------------------
section('Configuration and error mapping');
var unconfiguredRequests = installFakeXhr();
var unconfigured;
context.sendToJoplin('No URL', { joplin_token: 'abc' }, function(ok, data) {
    unconfigured = { ok: ok, data: data };
});
checkObject('refuses to send without a URL', unconfigured,
    { ok: false, data: 'Joplin not configured' });
check('makes no request when unconfigured', unconfiguredRequests.length, 0);

var noTokenRequests = installFakeXhr();
var noToken;
context.sendToJoplin('No token', { joplin_url: 'https://joplin.example.com' }, function(ok, data) {
    noToken = { ok: ok, data: data };
});
checkObject('refuses to send without a token', noToken,
    { ok: false, data: 'Joplin not configured' });
check('makes no request without a token', noTokenRequests.length, 0);

function failWith(status, body) {
    var r = installFakeXhr();
    var result;
    context.sendToJoplin('note', cfgWith({}), function(ok, data) {
        result = { ok: ok, data: data };
    });
    r[0].respond(status, body || '');
    return result;
}
checkObject('maps 401 to an invalid-token message', failWith(401),
    { ok: false, data: 'Invalid token' });
checkObject('maps 403 to an invalid-token message', failWith(403),
    { ok: false, data: 'Invalid token' });
checkObject('maps 404 to a missing-notebook message', failWith(404),
    { ok: false, data: 'Notebook not found' });
checkObject('falls back to the status code for other errors', failWith(500),
    { ok: false, data: 'Error 500' });

var networkRequests = installFakeXhr();
var networkResult;
context.sendToJoplin('note', cfgWith({}), function(ok, data) {
    networkResult = { ok: ok, data: data };
});
networkRequests[0].failNetwork();
checkObject('reports a network error when the request never lands', networkResult,
    { ok: false, data: 'Network error' });

// ---------------------------------------------------------------------------
section('Tags');
delete storage.brain_dump_joplin_tags_v1;
var tagRequests = installFakeXhr();
var tagDelivery;
context.sendToJoplin('Tagged note', cfgWith({ joplin_tags: ' inbox , pebble , ' }),
    function(ok, data) { tagDelivery = { ok: ok, data: data }; });
tagRequests[0].respond(200, '{"id":"note-9"}');
checkObject('reports success before tagging starts', tagDelivery, { ok: true, data: 'joplin' });

check('searches for the first tag by title', tagRequests[1].url,
    'https://joplin.example.com/search?query=inbox&type=tag&token=tok%20en');
tagRequests[1].respond(200, '{"items":[{"id":"tag-inbox","title":"inbox"}]}');
check('attaches the existing tag to the note', tagRequests[2].url,
    'https://joplin.example.com/tags/tag-inbox/notes?token=tok%20en');
checkObject('identifies the note when attaching', JSON.parse(tagRequests[2].body), { id: 'note-9' });
tagRequests[2].respond(200, '{}');

tagRequests[3].respond(200, '{"items":[]}');
check('creates a tag Joplin does not have yet', tagRequests[4].url,
    'https://joplin.example.com/tags?token=tok%20en');
checkObject('creates it by title', JSON.parse(tagRequests[4].body), { title: 'pebble' });
tagRequests[4].respond(200, '{"id":"tag-pebble"}');
check('attaches the freshly created tag', tagRequests[5].url,
    'https://joplin.example.com/tags/tag-pebble/notes?token=tok%20en');
tagRequests[5].respond(200, '{}');
check('drops empty entries from the tag list', tagRequests.length, 6);

checkObject('caches the resolved tag ids for the next send',
    JSON.parse(storage.brain_dump_joplin_tags_v1),
    { base: 'https://joplin.example.com', ids: { inbox: 'tag-inbox', pebble: 'tag-pebble' } });

var cachedRequests = installFakeXhr();
context.sendToJoplin('Second tagged note', cfgWith({ joplin_tags: 'inbox,pebble' }), function() {});
cachedRequests[0].respond(200, '{"id":"note-10"}');
check('skips the search once the tag id is cached', cachedRequests[1].url,
    'https://joplin.example.com/tags/tag-inbox/notes?token=tok%20en');
cachedRequests[1].respond(200, '{}');
cachedRequests[2].respond(200, '{}');
check('costs one request per tag when cached', cachedRequests.length, 3);

var staleRequests = installFakeXhr();
context.sendToJoplin('Stale tag note', cfgWith({ joplin_tags: 'inbox' }), function() {});
staleRequests[0].respond(200, '{"id":"note-11"}');
staleRequests[1].respond(404, '');
check('forgets a cached id the server no longer knows',
    'inbox' in JSON.parse(storage.brain_dump_joplin_tags_v1).ids, false);

storage.brain_dump_joplin_tags_v1 = JSON.stringify({
    base: 'https://other.example.com', ids: { inbox: 'stale-id' }
});
var otherHostRequests = installFakeXhr();
context.sendToJoplin('Other host', cfgWith({ joplin_tags: 'inbox' }), function() {});
otherHostRequests[0].respond(200, '{"id":"note-12"}');
check('ignores tag ids cached for a different instance',
    otherHostRequests[1].url.indexOf('/search?') >= 0, true);

delete storage.brain_dump_joplin_tags_v1;
var brokenTagRequests = installFakeXhr();
var brokenTagDelivery;
context.sendToJoplin('Note whose tagging fails', cfgWith({ joplin_tags: 'inbox' }),
    function(ok, data) { brokenTagDelivery = { ok: ok, data: data }; });
brokenTagRequests[0].respond(200, '{"id":"note-13"}');
brokenTagRequests[1].failNetwork();
checkObject('still reports success when tagging fails — a retry would duplicate the note',
    brokenTagDelivery, { ok: true, data: 'joplin' });

var manyTagRequests = installFakeXhr();
var capLog = [];
context.console.log = function(m) { capLog.push(m); };
context.sendToJoplin('Many tags', cfgWith({ joplin_tags: 'a,b,c,d,e,f,g' }), function() {});
manyTagRequests[0].respond(200, '{"id":"note-14"}');
manyTagRequests[1].failNetwork();
manyTagRequests[2].failNetwork();
manyTagRequests[3].failNetwork();
manyTagRequests[4].failNetwork();
manyTagRequests[5].failNetwork();
check('caps the tag list at five', manyTagRequests.length, 6);
check('says which tags the cap dropped instead of losing them silently',
    capLog.join(' ').indexOf('ignoring: f, g') >= 0, true);
context.console.log = function() {};

// ---------------------------------------------------------------------------
section('Routing');
var routingCfg = {
    joplin_enabled: true,
    joplin_url: 'https://joplin.example.com',
    joplin_token: 'abc',
    discord_enabled: true,
    discord_url: 'https://discord.example/webhook'
};
check('exposes Joplin as its own destination',
    context.getEnabledDests(routingCfg).indexOf('joplin') >= 0, true);
check('routes a note naming Joplin to Joplin',
    context.classifyIntent('save to joplin buy milk',
        context.getEnabledDests(routingCfg), routingCfg), 'joplin');
check('routes a generic note-taking phrase to Joplin when it is the only note service',
    context.classifyIntent('write down the meeting outcome',
        ['joplin'], { joplin_enabled: true }), 'joplin');
check('honours custom routing keywords',
    context.classifyIntent('add this to my second brain',
        context.getEnabledDests(routingCfg),
        { joplin_keywords: 'second brain', discord_url: 'x' }), 'joplin');
check('leaves an explicit Discord note with Discord',
    context.classifyIntent('post to discord we are late',
        context.getEnabledDests(routingCfg), routingCfg), 'discord');

check('queues Joplin sends that fail', context.QUEUEABLE_DESTS.joplin, 1);
check('gives Joplin the watch destination index', context.DEST_INDEX.joplin, 9);
check('sets only the Joplin bit when Joplin alone is enabled',
    context.computeDestMask({ joplin_enabled: true }), 512);
check('combines the Joplin and Discord bits',
    context.computeDestMask(routingCfg), 768);

// ---------------------------------------------------------------------------
section('Settings and watch wiring');
var savedCfg = {
    joplin_enabled: true,
    joplin_url: 'https://joplin.example.com',
    joplin_token: 'abc',
    joplin_notebook_id: 'nb-1',
    joplin_tags: 'pebble',
    joplin_keywords: 'second brain'
};
listeners.webviewclosed({ response: encodeURIComponent(JSON.stringify(savedCfg)) });
checkObject('persists every Joplin field',
    JSON.parse(storage.brain_dump_cfg_v1), savedCfg);
check('updates the watch mask after saving Joplin settings',
    sentToWatch[sentToWatch.length - 1].DEST_MASK, 512);

function renderSettings() {
    context.openSettings();
    return decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1));
}

var probeRequests = installFakeXhr();
var settingsHtml = renderSettings();
check('probes the notebook list before opening settings', probeRequests[0].url,
    'https://joplin.example.com/folders?page=1&token=abc');
probeRequests[0].respond(200, JSON.stringify({ items: [
    { id: 'nb-1', parent_id: '', title: 'Inbox' },
    { id: 'nb-2', parent_id: 'nb-1', title: 'Work' }
], has_more: false }));
settingsHtml = decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1));
check('states the tag cap in the settings page',
    settingsHtml.indexOf('max 5') >= 0, true);
check('renders the Joplin enable, URL and token controls',
    settingsHtml.indexOf('id="joplin_enabled"') >= 0 &&
    settingsHtml.indexOf('id="joplin_url"') >= 0 &&
    settingsHtml.indexOf('id="joplin_token"') >= 0 &&
    settingsHtml.indexOf('id="joplin_tags"') >= 0 &&
    settingsHtml.indexOf('id="joplin_keywords"') >= 0, true);
check('turns the notebook field into a picker',
    settingsHtml.indexOf('<select id="joplin_notebook_id">') >= 0, true);
check('shows nested notebooks by their full path',
    settingsHtml.indexOf('>Inbox / Work</option>') >= 0, true);
check('preselects the configured notebook',
    /<option value="nb-1" selected>/.test(settingsHtml), true);
check('offers Joplin as a default destination',
    settingsHtml.indexOf('<option value="joplin"') >= 0, true);
check('dims Joplin with the other services when smart routing is off',
    settingsHtml.indexOf('"discord","joplin"') >= 0, true);

var pagedRequests = installFakeXhr();
renderSettings();
pagedRequests[0].respond(200, JSON.stringify({
    items: [{ id: 'nb-1', parent_id: '', title: 'Inbox' }], has_more: true
}));
check('follows has_more to the next page', pagedRequests[1].url,
    'https://joplin.example.com/folders?page=2&token=abc');
pagedRequests[1].respond(200, JSON.stringify({
    items: [{ id: 'nb-9', parent_id: '', title: 'Archive' }], has_more: false
}));
var pagedHtml = decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1));
check('lists notebooks from every page, not just the first',
    pagedHtml.indexOf('>Inbox</option>') >= 0 &&
    pagedHtml.indexOf('>Archive</option>') >= 0, true);
check('stops paging once has_more is false', pagedRequests.length, 2);

var runawayRequests = installFakeXhr();
renderSettings();
for (var pg = 0; pg < 12 && pg < runawayRequests.length; pg++) {
    runawayRequests[pg].respond(200, JSON.stringify({
        items: [{ id: 'nb-' + pg, parent_id: '', title: 'N' + pg }], has_more: true
    }));
}
check('gives up on a server that never stops saying has_more',
    runawayRequests.length, 10);
check('still shows what it collected before giving up',
    decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1))
        .indexOf('>N0</option>') >= 0, true);

var partialRequests = installFakeXhr();
renderSettings();
partialRequests[0].respond(200, JSON.stringify({
    items: [{ id: 'nb-1', parent_id: '', title: 'Inbox' }], has_more: true
}));
partialRequests[1].failNetwork();
check('keeps the pages it already fetched when a later page fails',
    decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1))
        .indexOf('<select id="joplin_notebook_id">') >= 0, true);

var accentRequests = installFakeXhr();
renderSettings();
accentRequests[0].respond(200, JSON.stringify({ items: [
    { id: 'nb-z', parent_id: '', title: 'Zoo' },
    { id: 'nb-e', parent_id: '', title: 'Élève' }
], has_more: false }));
var accentHtml = decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1));
check('sorts accented notebook names where a reader expects them',
    accentHtml.indexOf('>Élève</option>') < accentHtml.indexOf('>Zoo</option>'), true);

var failedProbeRequests = installFakeXhr();
renderSettings();
failedProbeRequests[0].failNetwork();
var fallbackHtml = decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1));
check('falls back to a free-text notebook field when the probe fails',
    fallbackHtml.indexOf('id="joplin_notebook_id"') >= 0 &&
    fallbackHtml.indexOf('<select id="joplin_notebook_id">') < 0, true);

var timeoutProbeRequests = installFakeXhr();
renderSettings();
timeoutProbeRequests[0].timeoutNow();
check('still opens settings when the probe times out',
    decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1))
        .indexOf('id="joplin_url"') >= 0, true);

listeners.webviewclosed({ response: encodeURIComponent(JSON.stringify({})) });
var noProbeRequests = installFakeXhr();
renderSettings();
check('skips the probe when Joplin is not configured', noProbeRequests.length, 0);

check('assigns Joplin its own watch destination index',
    /#define DEST_JOPLIN\s+9/.test(watchSource), true);
check('shows Joplin by name on the watch',
    /case DEST_JOPLIN:\s+return "Joplin"/.test(watchSource), true);
check('renders a Joplin glyph on the watch',
    /case DEST_JOPLIN:\s+draw_glyph_letter\(ctx, 'J'/.test(watchSource), true);

process.stdout.write('\nPassed: ' + passed + '  Failed: ' + failed + '\n');
if (failed > 0) process.exit(1);
