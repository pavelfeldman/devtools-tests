// Copyright 2016 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

var frontendPatch = require("./frontend_patch");
var testRunnerPatch = require("./test_runner_patch");
var fs = require("fs");
var rdp = require("./rdp");
eval(fs.readFileSync("./third_party/diff_match_patch/diff_match_patch.js", "utf8"));

var argv = require('minimist')(process.argv.slice(2));
var frontendPath = "http://localhost:" + argv["frontend_port"] + "/front_end/inspector.html";
var testPaths = argv["_"];

var server = new rdp.Server("localhost", argv["chrome_port"]);

function Frontend(frontend, backend)
{
    this._connection = frontend.fork("                                                                                                          frontend");
    this._connection.on("notification", this._handleNotification.bind(this));
    this._inspectedConnection = backend.fork("                                             inspected");
    this._inspectedConnection.on("notification", this._dispatchMessageFromBackend.bind(this));
    this._pendingEvaluateInWebInspector = [];
}

Frontend.prototype = {
    init()
    {
        return Promise.all([this._connection.sendCommand("Console.enable"),
                     this._connection.sendCommand("Page.enable"),
                     this._connection.sendCommand("Network.setCacheDisabled", { cacheDisabled: true }),
                     this._connection.sendCommand("Runtime.enable")]).then(() => {
            return this._connection.sendCommand("Page.addScriptToEvaluateOnLoad", { scriptSource: "(" + frontendPatch + ")()" });
        });
    },

    setInspected(inspected)
    {
        this._inspected = inspected;
    },

    reload(testPath)
    {
        this._testPath = testPath;
        this._readyForTest = false;
        var settings = JSON.stringify({testPath : testPath});
        this._connection.sendCommand("Page.navigate", { url: frontendPath });
        this._disconnected = false;
    },

    disconnect: function()
    {
        this._pendingEvaluateInWebInspector = [];
    },

    evaluateInWebInspector: function(code)
    {
        if (code)
            this._pendingEvaluateInWebInspector.push(code);
        if (!this._readyForTest)
            return;
        for (var code of this._pendingEvaluateInWebInspector)
            this._connection.sendCommand("Runtime.evaluate", { expression: code });
        this._pendingEvaluateInWebInspector = [];
    },

    _dispatchMessageFromBackend: function(message)
    {
        if (this._disconnected)
            return;
        this._connection.sendCommand("Runtime.evaluate", { expression: "InspectorFrontendHost.dispatchMessageOnFrontend(" + JSON.stringify(message) + ")"});
    },

    _handleNotification(notification)
    {
        if (this._disconnected)
            return;
        if (notification.method !== "Console.messageAdded")
            return;
        var text = notification.params.message.text;
        if (!text.startsWith("#devtools-tests#"))
            return;

        var command = JSON.parse(text.substring("#devtools-tests#".length));
        if (command.method === "loadCompleted") {
            var setting = JSON.stringify({testPath: this._testPath});
            this._connection.sendCommand("Runtime.evaluate", { expression: "(" + setTestPath + ")(\"" + this._testPath + "\")" });
        } else if (command.method === "sendMessageToBackend") {
            var parsedCommand;
            try {
                parsedCommand = JSON.parse(command.args[0]);
            } catch(e) {
            }
            this._inspectedConnection.sendCommandObject(parsedCommand).then(this._dispatchMessageFromBackend.bind(this));
        } else if (command.method === "readyForTest") {
            this._readyForTest = true;
            this.evaluateInWebInspector(null);
        }

        function setTestPath(testPath)
        {
            WebInspector.settings.createSetting("testPath", "").set(testPath);
        }
    }
}

function TestRunner(paths)
{
    this._paths = paths;
    TestRunner._successCount = 0;
}

TestRunner._successCount = 0;
TestRunner._failedCount = 0;
TestRunner._timedOutCount = 0;

TestRunner.prototype = {
    run: function()
    {
        return new Promise((fulfill, reject) => {
            this._completeCallback = fulfill;
            Promise.all([server.newTab(), server.newTab()]).then(mixers => {
                this._connection = mixers[1].fork("testRunner");
                this._connection.on("notification", this._dispatchNotification.bind(this));
                this._frontend = new Frontend(mixers[0], mixers[1]);
                this._frontend.init().then(this._innerRunTests.bind(this));
            });
        });
    },

    _innerRunTests()
    {
        if (!this._paths.length) {
            this._completeCallback();
            return;
        }
        var testPath = this._paths.shift();
        this._runTest(testPath, this._innerRunTests.bind(this));
    },

    _runTest(testPath, callback)
    {
        this._currentTest = testPath;
        this._watchdog = setTimeout(this._timeout.bind(this), 5000);

        // Reattach to reset backend state.
        this._connection.reset().then(() => {
            this._connection.sendCommand("Page.enable");
            this._connection.sendCommand("Console.enable");
            this._connection.sendCommand("Page.addScriptToEvaluateOnLoad", { scriptSource: "(" + testRunnerPatch + ")()" }).then(() => {
                var expectationsPath = testPath.replace(".html", "-expected.txt");
                fs.readFile(expectationsPath, "utf8", (err, data) => {
                    var lines = data.split("\n");
                    lines = lines.filter(line => !line.startsWith("CONSOLE MESSAGE"));
                    this._expected = lines.join("\n");
                    this._testDone = false;
                    this._callback = callback;
                    this._connection.sendCommand("Page.navigate", { url: "file://" + testPath});
                    this._frontend.reload(testPath);
                });
            });
        });
    },

    _dispatchNotification(notification)
    {
        if (this._testDone)
            return;
        if (notification.method !== "Console.messageAdded")
            return;
        var text = notification.params.message.text;
        if (!text.startsWith("#devtools-tests#"))
            return;

        var command;
        try {
            // Page could override stringify.
            command = JSON.parse(text.substring("#devtools-tests#".length));
        } catch (e) {
            this._completeTest();
            this._fail();
            this._callback();
            return;
        }

        if (command.method === "evaluateInWebInspector") {
            this._frontend.evaluateInWebInspector(command.args[1]);
        } else if (command.method === "notifyDone") {
            this._completeTest();
            this._connection.sendCommand("Runtime.enable");
            this._connection.sendCommand("Runtime.evaluate", { expression: "document.documentElement.innerText" }).then(response => {
                var actual = response.result.result.value + "\n";
                if (actual === this._expected) {
                    this._succeed();
                    this._callback();
                } else {
                    this._fail();
                    this._callback();
                    var dmp = new diff_match_patch();
                    var a = dmp.diff_linesToChars_(this._expected, actual);
                    var diffs = dmp.diff_main(a.chars1, a.chars2, false);
                    dmp.diff_charsToLines_(diffs, a.lineArray);
                    var diffText = "";
                    for (var diff of diffs) {
                        if (diff[0] === 1)
                            diffText += "\n+" + diff[1].split("\n").join("\n+");
                        else if (diff[0] === -1)
                            diffText += "\n-" + diff[1].split("\n").join("\n-");
                    }
                    console.log(diffText);
                }
            });
        }
    },

    _completeTest()
    {
        this._testDone = true;
        this._frontend.disconnect();
        clearTimeout(this._watchdog);
    },

    _stats(result)
    {
        var path = this._currentTest.replace(/.*LayoutTests\//, "");
        var stats = "// S:" + TestRunner._successCount + " F:" + TestRunner._failedCount + " T:" + TestRunner._timedOutCount;
        console.log(path + "...[" + result + "] " + stats);
    },

    _succeed()
    {
        TestRunner._successCount++;
        this._stats("SUCCESS");
    },

    _fail()
    {
        TestRunner._failedCount++;
        this._stats("FAILED");
    },

    _timeout()
    {
        this._completeTest();
        TestRunner._timedOutCount++;
        this._stats("TIMEOUT");
        this._callback();
    }
}

var tests = [];

function collectFiles(path)
{
    if (!fs.existsSync(path))
        return Promise.resolve();
    if (path.endsWith(".html")) {
        tests.push(path);
        return Promise.resolve();
    }
    if (!fs.lstatSync(path).isDirectory() || path.endsWith("/resources"))
        return Promise.resolve();

    return new Promise((fulfill, reject) => {
        fs.readdir(path, (err, items) => {
            if (!items)
                return Promise.resolve();
            Promise.all(items.map(item => collectFiles(path + "/" + item))).then(fulfill);
        });
    });
}

Promise.all(testPaths.map(path => collectFiles(path))).then(() => {
    var jobs = argv["j"] || 1;
    console.log("Running " + tests.length + " tests using " + jobs + " jobs ...");
    var jobSize = Math.ceil(tests.length / jobs);
    server.closeTabs().then(() => {
        setTimeout(() => {
            var promises = [];
            for (var i = 0; i < jobs; ++i) {
                var testRunner = new TestRunner(tests.slice(jobSize * i, jobSize * (i + 1)));
                promises.push(testRunner.run());
            }
            Promise.all(promises).then(() => {
                console.log("Succeeded: " + TestRunner._successCount + ", Failed: " + TestRunner._failedCount + ", Timed out: " + TestRunner._timedOutCount);
                process.exit(0)
            });
        }, 1000);
    });
});
