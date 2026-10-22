// Tests for the OpenAI-compatible AI request body and error reporting.
// Run: node test/aiRequest.test.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pkjsPath = path.join(__dirname, '..', 'src', 'pkjs', 'index.js');
var pkjsSource = fs.readFileSync(pkjsPath, 'utf8');

var context = {
    console: { log: function() {} },
    setTimeout: function(callback) { callback(); },
    localStorage: { getItem: function() { return null; }, setItem: function() {}, removeItem: function() {} },
    Pebble: {
        addEventListener: function() {},
        sendAppMessage: function(message, onSuccess) { if (onSuccess) onSuccess(); },
        openURL: function() {},
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

function installFakeXhr() {
    var requests = [];
    function FakeXhr() { requests.push(this); }
    FakeXhr.prototype.open = function(method, url) { this.method = method; this.url = url; };
    FakeXhr.prototype.setRequestHeader = function() {};
    FakeXhr.prototype.send = function(body) { this.body = body; };
    FakeXhr.prototype.respond = function(status, responseText) {
        this.status = status;
        this.responseText = responseText || '';
        this.onload();
    };
    context.XMLHttpRequest = FakeXhr;
    return requests;
}

function send(cfg) {
    var requests = installFakeXhr();
    var result = {};
    context.sendToAI('hello', false, cfg, function(ok, msg) { result.ok = ok; result.msg = msg; });
    result.request = requests[0];
    result.body = JSON.parse(requests[0].body);
    return result;
}

process.stdout.write('Request body\n');

var anthropic = send({ ai_url: 'https://api.anthropic.com/v1', ai_model: 'claude-opus-5-5', ai_key: 'k' });
check('Anthropic is sent to its chat/completions endpoint',
    anthropic.request.url, 'https://api.anthropic.com/v1/chat/completions');

var unset = send({ ai_url: 'https://ai.example.com/v1', ai_model: 'm' });
check('no temperature is sent by default, so every provider uses its own',
    'temperature' in unset.body, false);

var blank = send({ ai_url: 'https://ai.example.com/v1', ai_model: 'm', ai_temperature: '' });
check('a blank temperature setting sends none', 'temperature' in blank.body, false);

var set = send({ ai_url: 'https://ai.example.com/v1', ai_model: 'm', ai_temperature: '0.7' });
check('a temperature setting is sent as a number', set.body.temperature, 0.7);

var zero = send({ ai_url: 'https://ai.example.com/v1', ai_model: 'm', ai_temperature: '0' });
check('a temperature of 0 is still sent', zero.body.temperature, 0);

var junk = send({ ai_url: 'https://ai.example.com/v1', ai_model: 'm', ai_temperature: 'warm' });
check('a temperature that is not a number sends none', 'temperature' in junk.body, false);

process.stdout.write('Error reporting\n');

var rejected = send({ ai_url: 'https://api.anthropic.com/v1', ai_model: 'x', ai_key: 'k' });
rejected.request.respond(400, JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'temperature is not supported for this model' }
}));
check('a JSON error body surfaces its message instead of a bare status',
    rejected.msg, 'temperature is not supported for this model');
check('and is reported as a failure', rejected.ok, false);

var bare = send({ ai_url: 'https://ai.example.com/v1', ai_model: 'm' });
bare.request.respond(400, JSON.stringify({}));
check('an error with no message falls back to the status', bare.msg, 'HTTP 400');

var ok = send({ ai_url: 'https://ai.example.com/v1', ai_model: 'm' });
ok.request.respond(200, JSON.stringify({ choices: [{ message: { content: 'Done.' } }] }));
check('a normal reply still comes through', ok.msg, 'Done.');

var thinking = send({ ai_url: 'https://ai.example.com/v1', ai_model: 'm' });
thinking.request.respond(200, JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'Hmm' } }] }));
check('reasoning_content is still the fallback for thinking models', thinking.msg, 'Hmm');

process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed) process.exit(1);
