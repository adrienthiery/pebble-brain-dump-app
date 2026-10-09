// Tests for the shared "extra request headers" mechanism and every
// destination wired into it.
// Run: node test/extraHeaders.test.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pkjsPath = path.join(__dirname, '..', 'src', 'pkjs', 'index.js');
var pkjsSource = fs.readFileSync(pkjsPath, 'utf8');

var listeners = {};
var storage = {};
var openedUrl = '';
var logLines = [];

var context = {
    console: { log: function(m) { logLines.push(String(m)); } },
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
        sendAppMessage: function(message, onSuccess) { if (onSuccess) onSuccess(); },
        openURL: function(url) { openedUrl = url; },
        getTimelineToken: function(onSuccess) { onSuccess('timeline-token'); }
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

// refuse: header names the request rejects, as XHR does for Host etc.
function installFakeXhr(refuse) {
    var requests = [];

    function FakeXhr() {
        this.headers = {};
        this.headerOrder = [];
        requests.push(this);
    }

    FakeXhr.prototype.open = function(method, url) {
        this.method = method;
        this.url = url;
    };
    FakeXhr.prototype.setRequestHeader = function(name, value) {
        if (refuse && refuse.indexOf(name) >= 0) throw new Error('refused: ' + name);
        this.headers[name] = value;
        this.headerOrder.push(name);
    };
    FakeXhr.prototype.send = function(body) { this.body = body; };
    FakeXhr.prototype.respond = function(status, responseText) {
        this.status = status;
        this.responseText = responseText || '';
        this.onload();
    };

    context.XMLHttpRequest = FakeXhr;
    return requests;
}

// ---------------------------------------------------------------------------
section('Parsing "Name: value" lines');
var parse = context.parseExtraHeaders;

checkObject('reads one header', parse('X-Hermes-Session-Id: brain-dump'),
    [{ name: 'X-Hermes-Session-Id', value: 'brain-dump' }]);
checkObject('reads several lines', parse('CF-Access-Client-Id: id\nCF-Access-Client-Secret: secret'),
    [{ name: 'CF-Access-Client-Id', value: 'id' },
     { name: 'CF-Access-Client-Secret', value: 'secret' }]);
checkObject('trims the padding around both halves', parse('   X-Title :   Brain Dump   '),
    [{ name: 'X-Title', value: 'Brain Dump' }]);
checkObject('splits on the first colon only, so a URL survives',
    parse('X-Base: https://host:8080/v1'),
    [{ name: 'X-Base', value: 'https://host:8080/v1' }]);
checkObject('skips blank lines', parse('\n\nX-A: 1\n   \n'),
    [{ name: 'X-A', value: '1' }]);
checkObject('treats a leading # as commented out', parse('#X-Off: 1\nX-On: 2'),
    [{ name: 'X-On', value: '2' }]);
checkObject('ignores a line with no colon', parse('not a header\nX-A: 1'),
    [{ name: 'X-A', value: '1' }]);
checkObject('ignores a line that starts with the colon', parse(': 1'), []);
checkObject('ignores a name that is not a header token', parse('X Bad: 1\nBad"Name: 2'), []);
checkObject('ignores an empty value', parse('X-Empty:   '), []);
checkObject('drops a smuggled carriage return rather than splitting a header',
    parse('X-A: 1\r\nX-B: 2'),
    [{ name: 'X-A', value: '1' }, { name: 'X-B', value: '2' }]);
checkObject('reads nothing from an unset field', parse(undefined), []);
checkObject('reads nothing from an empty field', parse(''), []);

logLines.length = 0;
var manyLines = [];
for (var i = 0; i < 13; i++) manyLines.push('X-H' + i + ': ' + i);
check('caps the list at ten', parse(manyLines.join('\n')).length, 10);
check('says how many the cap dropped', logLines.join(' ').indexOf('ignoring 3 more') >= 0, true);

// ---------------------------------------------------------------------------
section('Applying them to a request');
var applyRequests = installFakeXhr();
var xhr = new context.XMLHttpRequest();
context.applyExtraHeaders(xhr, { ai_headers: 'X-A: 1\nX-B: 2' }, 'ai');
checkObject('sets each parsed header', xhr.headers, { 'X-A': '1', 'X-B': '2' });

var perDest = new context.XMLHttpRequest();
context.applyExtraHeaders(perDest, { ai_headers: 'X-A: 1', webhook_headers: 'X-B: 2' }, 'webhook');
checkObject('reads only the destination it was asked for', perDest.headers, { 'X-B': '2' });

var noneXhr = new context.XMLHttpRequest();
context.applyExtraHeaders(noneXhr, {}, 'ai');
checkObject('sets nothing when the field is unset', noneXhr.headers, {});

logLines.length = 0;
installFakeXhr(['Host']);
var refusedXhr = new context.XMLHttpRequest();
context.applyExtraHeaders(refusedXhr, { ai_headers: 'Host: evil\nX-Ok: 1' }, 'ai');
checkObject('keeps going when the request refuses a header', refusedXhr.headers, { 'X-Ok': '1' });
check('names the refused header', logLines.join(' ').indexOf('Host') >= 0, true);
check('never logs a header value', logLines.join(' ').indexOf('evil') >= 0, false);

// ---------------------------------------------------------------------------
section('Wired into every user-configured destination');

function headersOf(request) { return request.headers; }

var aiRequests = installFakeXhr();
context.sendToAI('hello', false, {
    ai_url: 'https://ai.example.com/v1', ai_model: 'm', ai_key: 'k',
    ai_headers: 'X-Hermes-Session-Id: brain-dump'
}, function() {});
check('AI sends the extra header', headersOf(aiRequests[0])['X-Hermes-Session-Id'], 'brain-dump');
check('AI still sends its own Authorization', headersOf(aiRequests[0])['Authorization'], 'Bearer k');
check('AI still sends its own Content-Type',
    headersOf(aiRequests[0])['Content-Type'], 'application/json');

var overrideRequests = installFakeXhr();
context.sendToAI('hello', false, {
    ai_url: 'https://ai.example.com/v1',
    ai_headers: 'Content-Type: application/json; charset=utf-8'
}, function() {});
check('extra headers win over the destination default, so a gateway can override one',
    headersOf(overrideRequests[0])['Content-Type'], 'application/json; charset=utf-8');

var hookRequests = installFakeXhr();
context.sendToWebhook('note', {
    webhook_url: 'https://hook.example.com', webhook_token: 't',
    webhook_headers: 'X-Api-Key: secret'
}, function() {});
check('webhook sends the extra header', headersOf(hookRequests[0])['X-Api-Key'], 'secret');
check('webhook still sends its bearer token',
    headersOf(hookRequests[0])['Authorization'], 'Bearer t');

var getRequests = installFakeXhr();
context.sendToWebhook('note', {
    webhook_url: 'https://hook.example.com', webhook_verb: 'GET',
    webhook_headers: 'X-Api-Key: secret'
}, function() {});
check('a GET webhook sends it too, body or no body',
    headersOf(getRequests[0])['X-Api-Key'], 'secret');

var ncRequests = installFakeXhr();
context.sendToNextcloud('note', {
    nextcloud_url: 'https://cloud.example.com', nextcloud_user: 'u', nextcloud_pass: 'p',
    nextcloud_headers: 'CF-Access-Client-Id: id'
}, function() {});
check('Nextcloud Notes sends the extra header',
    headersOf(ncRequests[0])['CF-Access-Client-Id'], 'id');
check('Nextcloud Notes still sends its own auth',
    headersOf(ncRequests[0])['Authorization'].indexOf('Basic ') === 0, true);

var nctRequests = installFakeXhr();
context.sendToNextcloudTasks('note tomorrow', {
    nextcloud_tasks_url: 'https://cloud.example.com',
    nextcloud_tasks_user: 'u', nextcloud_tasks_pass: 'p',
    nextcloud_tasks_headers: 'CF-Access-Client-Id: id'
}, function() {});
check('Nextcloud Tasks sends the extra header',
    headersOf(nctRequests[0])['CF-Access-Client-Id'], 'id');
check('Nextcloud Tasks still declares iCalendar',
    headersOf(nctRequests[0])['Content-Type'], 'text/calendar; charset=utf-8');

var joplinRequests = installFakeXhr();
context.sendToJoplin('note', {
    joplin_url: 'https://joplin.example.com', joplin_token: 'tok',
    joplin_headers: 'CF-Access-Client-Id: id'
}, function() {});
check('Joplin sends the extra header',
    headersOf(joplinRequests[0])['CF-Access-Client-Id'], 'id');
check('Joplin still declares JSON',
    headersOf(joplinRequests[0])['Content-Type'], 'application/json');

// A gateway guards the whole instance, so the follow-up calls need them too.
var JOPLIN_TAG_CFG = {
    joplin_url: 'https://joplin.example.com/', joplin_token: 'tok',
    joplin_tags: 'inbox', joplin_headers: 'CF-Access-Client-Id: id'
};
delete storage.brain_dump_joplin_tags_v1;
var tagRequests = installFakeXhr();
context.sendToJoplin('note', JOPLIN_TAG_CFG, function() {});
tagRequests[0].respond(200, '{"id":"note-1"}');
check('the tag search sends them', headersOf(tagRequests[1])['CF-Access-Client-Id'], 'id');
tagRequests[1].respond(200, '{"items":[{"id":"tag-1"}]}');
check('the tag attach sends them', headersOf(tagRequests[2])['CF-Access-Client-Id'], 'id');
check('the tag attach still declares JSON',
    headersOf(tagRequests[2])['Content-Type'], 'application/json');
tagRequests[2].respond(200, '{}');

delete storage.brain_dump_joplin_tags_v1;
var createRequests = installFakeXhr();
context.sendToJoplin('note', JOPLIN_TAG_CFG, function() {});
createRequests[0].respond(200, '{"id":"note-2"}');
createRequests[1].respond(200, '{"items":[]}');
check('creating a missing tag sends them',
    headersOf(createRequests[2])['CF-Access-Client-Id'], 'id');

storage.brain_dump_cfg_v1 = JSON.stringify({
    joplin_enabled: true, joplin_url: 'https://joplin.example.com',
    joplin_token: 'tok', joplin_headers: 'CF-Access-Client-Id: id'
});
var probeRequests = installFakeXhr();
context.openSettings();
check('the notebook probe behind the settings picker sends them',
    headersOf(probeRequests[0])['CF-Access-Client-Id'], 'id');
check('the probe still asks for the first page',
    probeRequests[0].url, 'https://joplin.example.com/folders?page=1&token=tok');

// ---------------------------------------------------------------------------
section('Settings page');
var savedCfg = {
    ai_headers: 'X-Hermes-Session-Id: brain-dump',
    webhook_headers: 'X-Api-Key: k',
    nextcloud_headers: 'CF-Access-Client-Id: a',
    nextcloud_tasks_headers: 'CF-Access-Client-Id: b',
    joplin_headers: 'CF-Access-Client-Id: c'
};
listeners.webviewclosed({ response: encodeURIComponent(JSON.stringify(savedCfg)) });
checkObject('persists every destination\'s header field',
    JSON.parse(storage.brain_dump_cfg_v1), savedCfg);

installFakeXhr();
context.openSettings();
var html = decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1));

['ai', 'webhook', 'nextcloud', 'nextcloud_tasks', 'joplin'].forEach(function(dest) {
    check('renders a header field for ' + dest,
        html.indexOf('<textarea id="' + dest + '_headers"') >= 0, true);
    check('reads ' + dest + '\'s header field back when saving',
        html.indexOf(dest + '_headers:document.getElementById("' + dest + '_headers")') >= 0, true);
});
check('masks header values like an API key',
    /<textarea id="ai_headers"[^>]*class="secret"/.test(html), true);
check('offers a way to reveal them', html.indexOf('function toggleSecret(') >= 0, true);
check('states the cap on the page', html.indexOf('max 10') >= 0, true);
check('shows the saved value', html.indexOf('X-Hermes-Session-Id: brain-dump') >= 0, true);

storage.brain_dump_cfg_v1 = JSON.stringify({ ai_headers: 'X-A: <b>&"' });
installFakeXhr();
context.openSettings();
var escapedHtml = decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1));
check('escapes a value that would otherwise close the textarea',
    escapedHtml.indexOf('X-A: &lt;b&gt;&amp;"') >= 0, true);

process.stdout.write('\nPassed: ' + passed + '  Failed: ' + failed + '\n');
if (failed > 0) process.exit(1);
