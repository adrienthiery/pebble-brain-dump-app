// Unit tests for the Discord webhook payload format (Brain Dump pkjs)
// Run: node test/webhookDiscordFormat.test.js

function buildWebhookPayload(text, timestamp) {
    return {
        text: text,
        timestamp: timestamp
    };
}

// Discord webhooks require a "content" field and reject the generic
// {text, timestamp} body with a 400. Discord's own <t:epoch:f> markup
// renders in each viewer's local timezone, so no TZ math is needed here.
function buildDiscordPayload(payload) {
    return { content: payload.text + '\n_(<t:' + payload.timestamp + ':f>)_' };
}

function webhookRequestBody(format, payload) {
    return format === 'discord' ? buildDiscordPayload(payload) : payload;
}

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
    var g = JSON.stringify(got);
    var e = JSON.stringify(expected);
    check(label, g, e);
}

function section(name) {
    process.stdout.write('\n' + name + '\n');
}

var payload = buildWebhookPayload('Buy milk tomorrow', 1770000000);

section('Discord payload shape');
checkObject(
    'discord format produces a single "content" field',
    buildDiscordPayload(payload),
    { content: 'Buy milk tomorrow\n_(<t:1770000000:f>)_' }
);
check(
    'discord payload embeds a Discord native timestamp tag',
    buildDiscordPayload(payload).content.indexOf('<t:1770000000:f>') >= 0 ? 'yes' : 'no',
    'yes'
);

section('Format dispatch');
checkObject(
    'generic format leaves payload untouched',
    webhookRequestBody('generic', payload),
    payload
);
checkObject(
    'unset format defaults to generic behavior',
    webhookRequestBody(undefined, payload),
    payload
);
checkObject(
    'discord format routes through buildDiscordPayload',
    webhookRequestBody('discord', payload),
    buildDiscordPayload(payload)
);

process.stdout.write('\nPassed: ' + passed + '  Failed: ' + failed + '\n');
if (failed > 0) process.exit(1);
