// Integration-focused tests for the standalone Discord destination.
// Run: node test/webhookDiscordFormat.test.js

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
var scheduledTimers = [];

var context = {
    console: { log: function() {} },
    setTimeout: function(callback, delay) {
        scheduledTimers.push({ callback: callback, delay: delay });
        return scheduledTimers.length;
    },
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

function resetTimers() {
    scheduledTimers = [];
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
    FakeXhr.prototype.send = function(body) {
        this.body = body;
    };
    FakeXhr.prototype.getResponseHeader = function(name) {
        return this.responseHeaders && this.responseHeaders[name] || null;
    };
    FakeXhr.prototype.respond = function(status, responseText, responseHeaders) {
        this.status = status;
        this.responseText = responseText || '';
        this.responseHeaders = responseHeaders || {};
        this.onload();
    };
    FakeXhr.prototype.failNetwork = function() {
        this.onerror();
    };

    context.XMLHttpRequest = FakeXhr;
    return requests;
}

var payload = { text: 'Buy milk tomorrow', timestamp: 1770000000 };
var discordPayload = context.buildDiscordPayloads(payload)[0];

section('Discord embed styling');
check('uses the Brain Dump sender name', discordPayload.username, 'Brain Dump');
check('uses the Brain Dump app icon', discordPayload.avatar_url,
    'https://raw.githubusercontent.com/adrienthiery/pebble-brain-dump-app/main/icon_144x144.png');
check('puts the note in the embed description',
    discordPayload.embeds[0].description, 'Buy milk tomorrow');
check('uses the Brain Dump orange accent', discordPayload.embeds[0].color, 0xff9900);
check('uses an ISO embed timestamp',
    discordPayload.embeds[0].timestamp, new Date(1770000000 * 1000).toISOString());
check('does not add a footer to a single-part note',
    discordPayload.embeds[0].footer, undefined);
checkObject('suppresses mentions', discordPayload.allowed_mentions, { parse: [] });

section('Lossless long notes');
var longNote = new Array(4096).join('a') + '🧠' + new Array(1001).join('b') + '\nLast line';
var longPayloads = context.buildDiscordPayloads({ text: longNote, timestamp: 1770000000 });
check('splits a long note into two messages', longPayloads.length, 2);
check('keeps every character in order',
    longPayloads.map(function(part) { return part.embeds[0].description; }).join(''),
    longNote);
check('keeps every part within the Discord limit',
    longPayloads.every(function(part) {
        return part.embeds[0].description.length <= context.DISCORD_MAX_DESCRIPTION_LENGTH;
    }), true);
check('labels the first part', longPayloads[0].embeds[0].footer.text, 'Part 1 of 2');
check('labels the second part', longPayloads[1].embeds[0].footer.text, 'Part 2 of 2');

section('Independent destination configuration and routing');
checkObject('enables Custom Webhook independently',
    context.getEnabledDests({ webhook_enabled: true }), ['webhook']);
checkObject('enables Discord independently',
    context.getEnabledDests({ discord_enabled: true }), ['discord']);
checkObject('allows Custom Webhook and Discord together',
    context.getEnabledDests({ webhook_enabled: true, discord_enabled: true }),
    ['webhook', 'discord']);

var routingCfg = {
    routing_auto: true,
    default_dest: 'webhook',
    webhook_enabled: true,
    webhook_keywords: 'automation',
    discord_enabled: true,
    discord_keywords: 'team chat'
};
var routingDests = context.getEnabledDests(routingCfg);
check('routes built-in Discord phrases to Discord',
    context.pickDest('Post to Discord project update', routingDests, routingCfg, false),
    'discord');
check('routes custom Discord keywords to Discord',
    context.pickDest('Team chat project update', routingDests, routingCfg, false),
    'discord');
check('respects Discord as the default when smart routing is off',
    context.pickDest('A plain note', routingDests, {
        routing_auto: false,
        default_dest: 'discord'
    }, false), 'discord');
check('assigns Discord its own destination-mask bit',
    context.computeDestMask({ webhook_enabled: true, discord_enabled: true }), 264);
check('keeps Discord eligible for the retry queue',
    context.QUEUEABLE_DESTS.discord, 1);
check('preserves Discord webhook query parameters when requesting confirmation',
    context.buildDiscordWebhookUrl('https://discord.example/webhook?thread_id=123'),
    'https://discord.example/webhook?thread_id=123&wait=true');
check('overrides an explicitly disabled Discord confirmation response',
    context.buildDiscordWebhookUrl('https://discord.example/webhook?wait=false'),
    'https://discord.example/webhook?wait=true');

section('Discord delivery');
var requests = installFakeXhr();
var deliveryResult;
var beforeSend = Math.floor(Date.now() / 1000);
context.sendToDest('discord', longNote, {
    discord_url: 'https://discord.example/webhook'
}, function(ok, data) {
    deliveryResult = { ok: ok, data: data };
});

check('starts with only the first request in flight', requests.length, 1);
check('uses POST for Discord webhooks', requests[0].method, 'POST');
check('requests Discord confirmation for the configured webhook', requests[0].url,
    'https://discord.example/webhook?wait=true');
check('sends JSON', requests[0].headers['Content-Type'], 'application/json');
var sentTimestamp = Date.parse(JSON.parse(requests[0].body).embeds[0].timestamp) / 1000;
check('timestamps the embed when the note is sent',
    sentTimestamp >= beforeSend && sentTimestamp <= Math.floor(Date.now() / 1000), true);
check('waits for the first part before starting the second', deliveryResult, undefined);

requests[0].respond(200, '{"id":"first"}');
check('starts the second part after the first succeeds', requests.length, 2);
check('waits for every part before reporting success', deliveryResult, undefined);
requests[1].respond(200, '{"id":"second"}');
checkObject('reports success after every part is delivered', deliveryResult,
    { ok: true, data: 'discord' });
check('sends every note character exactly once',
    requests.map(function(request) {
        return JSON.parse(request.body).embeds[0].description;
    }).join(''), longNote);

section('Multipart retry progress');
var partialRequests = installFakeXhr();
var partialFailure;
context.sendToDiscord(longNote, { discord_url: 'https://discord.example/webhook' },
    function(ok, data, retryState) {
        partialFailure = { ok: ok, data: data, retryState: retryState };
    }, { timestamp: 1770000000 });
partialRequests[0].respond(200, '{"id":"first"}');
partialRequests[1].respond(500);
checkObject('records the first unsent part after a partial failure', partialFailure,
    { ok: false, data: 'HTTP 500', retryState: {
        discordPart: 1,
        timestamp: 1770000000
    } });

var resumedRequests = installFakeXhr();
var resumedDelivery;
context.sendToDest('discord', longNote, { discord_url: 'https://discord.example/webhook' },
    function(ok, data) { resumedDelivery = { ok: ok, data: data }; },
    partialFailure.retryState);
check('resumes with only the failed part in flight', resumedRequests.length, 1);
check('does not resend the already-confirmed first part',
    JSON.parse(resumedRequests[0].body).embeds[0].footer.text, 'Part 2 of 2');
check('keeps the original timestamp when resuming',
    JSON.parse(resumedRequests[0].body).embeds[0].timestamp,
    new Date(1770000000 * 1000).toISOString());
resumedRequests[0].respond(200, '{"id":"second"}');
checkObject('reports success after the resumed part arrives', resumedDelivery,
    { ok: true, data: 'discord' });

section('Discord rate limits');
resetTimers();
var rateLimitedRequests = installFakeXhr();
var rateLimitedDelivery;
context.sendToDiscord('Rate-limited note', {
    discord_url: 'https://discord.example/webhook'
}, function(ok, data) {
    rateLimitedDelivery = { ok: ok, data: data };
});
rateLimitedRequests[0].respond(429, '{"retry_after":0.25}');
check('waits instead of failing immediately on a 429', rateLimitedDelivery, undefined);
check('uses Discord retry_after as milliseconds', scheduledTimers[0].delay, 250);
var firstRateLimitedBody = rateLimitedRequests[0].body;
scheduledTimers.shift().callback();
check('retries the same part after the delay', rateLimitedRequests.length, 2);
check('keeps the payload unchanged for the rate-limit retry',
    rateLimitedRequests[1].body, firstRateLimitedBody);
rateLimitedRequests[1].respond(200, '{"id":"retry"}');
checkObject('succeeds when the one-time rate-limit retry arrives', rateLimitedDelivery,
    { ok: true, data: 'discord' });

resetTimers();
var repeatedRateLimitRequests = installFakeXhr();
var repeatedRateLimitFailure;
context.sendToDiscord('Still rate-limited', {
    discord_url: 'https://discord.example/webhook'
}, function(ok, data, retryState) {
    repeatedRateLimitFailure = { ok: ok, data: data, retryState: retryState };
}, { timestamp: 1770000000 });
repeatedRateLimitRequests[0].respond(429, '{"retry_after":0.1}');
scheduledTimers.shift().callback();
repeatedRateLimitRequests[1].respond(429, '{"retry_after":0.1}');
checkObject('fails after one rate-limit retry', repeatedRateLimitFailure,
    { ok: false, data: 'HTTP 429', retryState: {
        discordPart: 0,
        timestamp: 1770000000
    } });
check('does not schedule a second rate-limit retry', scheduledTimers.length, 0);

section('Settings and watch wiring');
var savedCfg = {
    webhook_enabled: true,
    webhook_url: 'https://generic.example/hook',
    discord_enabled: true,
    discord_url: 'https://discord.example/webhook',
    discord_keywords: 'team chat'
};
listeners.webviewclosed({
    response: encodeURIComponent(JSON.stringify(savedCfg))
});
checkObject('persists Discord independently from Custom Webhook',
    JSON.parse(storage.brain_dump_cfg_v1), savedCfg);
check('updates the watch mask after saving Discord settings',
    sentToWatch[sentToWatch.length - 1].DEST_MASK, 264);

context.openSettings();
var settingsHtml = decodeURIComponent(openedUrl.substring(openedUrl.indexOf(',') + 1));
check('renders dedicated Discord enable and URL controls',
    settingsHtml.indexOf('id="discord_enabled"') >= 0 &&
    settingsHtml.indexOf('id="discord_url"') >= 0, true);
check('assigns Discord its own watch destination index',
    /#define DEST_DISCORD\s+8/.test(watchSource), true);
check('shows Discord by name on the watch',
    /case DEST_DISCORD:\s+return "Discord"/.test(watchSource), true);
check('renders a Discord glyph on the watch',
    /case DEST_DISCORD:\s+draw_glyph_letter\(ctx, 'D'/.test(watchSource), true);

process.stdout.write('\nPassed: ' + passed + '  Failed: ' + failed + '\n');
if (failed > 0) process.exit(1);
