// Tests for the settings page's encoding: saved non-ASCII values must come back
// intact whatever the phone's locale.
// Run: node test/settingsPage.test.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pkjsPath = path.join(__dirname, '..', 'src', 'pkjs', 'index.js');
var pkjsSource = fs.readFileSync(pkjsPath, 'utf8');

var storage = {};
var openedUrl = '';
var context = {
    console: { log: function() {} },
    setTimeout: function(callback) { callback(); },
    localStorage: {
        getItem: function(k) { return storage.hasOwnProperty(k) ? storage[k] : null; },
        setItem: function(k, v) { storage[k] = String(v); },
        removeItem: function(k) { delete storage[k]; }
    },
    Pebble: {
        addEventListener: function() {},
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

var cfg = context.getConfig();
cfg.timeline_enabled = true;
cfg.timeline_keywords = 'Напомни, встреча, созвон';
context.saveConfig(cfg);
context.openSettings();

var prefix = openedUrl.substring(0, openedUrl.indexOf(',') + 1);
var html = decodeURIComponent(openedUrl.substring(prefix.length));

process.stdout.write('Encoding\n');
check('the data: URL declares UTF-8, so a cp1251 phone does not guess its locale',
    prefix, 'data:text/html;charset=utf-8,');
check('the page declares UTF-8 too', html.indexOf('<meta charset="utf-8">') >= 0, true);
check('a Cyrillic keyword is written back into its field unchanged',
    html.indexOf('value=\'Напомни, встреча, созвон\'') >= 0, true);

process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed) process.exit(1);
