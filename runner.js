// Copyright 2016 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

var frontendPatch = require("./frontend_patch");
var testRunnerPatch = require("./test_runner_patch");
var fs = require("fs");
var rdp = require("./rdp");

var argv = require('minimist')(process.argv.slice(2));
var frontendPath = "http://localhost:" + argv["frontend_port"] + "/front_end/inspector.html";
var testsPath = argv["layout_tests"] + "/inspector/elements";

console.log("Frontend path: " + frontendPath);
console.log("Tests path: " + testsPath);
console.log("Chrome RDP path: " + "localhost:" + argv["chrome_port"]);

var server = new rdp.Server("localhost", argv["chrome_port"]);

function Frontend(frontend, backend)
{
    this._connection = frontend.fork("                                                                                                          frontend");
    this._connection.on("notification", this._handleNotification.bind(this));
    this._inspectedConnection = backend.fork("                                             inspected");
    this._inspectedConnection.on("notification", this._dispatchMessageFromBackend.bind(this));
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
        this._pendingEvaluateInWebInspector = [];
        this._readyForTest = false;
        var settings = JSON.stringify({testPath : testPath});
        this._connection.sendCommand("Page.navigate", { url: frontendPath });
        this._disconnected = false;
    },

    disconnect: function()
    {
        this._disconnected = true;
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
            this._inspectedConnection.sendCommandObject(JSON.parse(command.args[0])).then(this._dispatchMessageFromBackend.bind(this));
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

function TestRunner(frontend, backend)
{
    this._frontend = frontend;
    this._connection = backend.fork("testRunner");
    this._connection.on("notification", this._dispatchNotification.bind(this));
}

TestRunner.prototype = {
    init()
    {
        this._connection.sendCommand("Console.enable");
        this._connection.sendCommand("Page.enable");
        return this._connection.sendCommand("Page.addScriptToEvaluateOnLoad", { scriptSource: "(" + testRunnerPatch + ")()" });
    },

    runTest(testPath, callback)
    {
        this._watchdog = setTimeout(callback.bind(null, "TIMEOUT"), 5000);
        this._testDone = false;
        this._callback = callback;
        var expectationsPath = testPath.replace(".html", "-expected.txt");
        fs.readFile(expectationsPath, "utf8", (err, data) => {
            this._expected = data;
            this._connection.sendCommand("Page.navigate", { url: "file://" + testPath});
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

        var command = JSON.parse(text.substring("#devtools-tests#".length));
        if (command.method === "evaluateInWebInspector") {
            this._frontend.evaluateInWebInspector(command.args[1]);
        } else if (command.method === "notifyDone") {
            this._testDone = true;
            this._frontend.disconnect();
            clearTimeout(this._watchdog);
            this._connection.sendCommand("Runtime.enable");
            this._connection.sendCommand("Runtime.evaluate", { expression: "document.documentElement.innerText" }).then(response => {
                var actual = response.result.result.value + "\n";
                if (actual === this._expected)
                    this._callback("SUCCESS");
                else
                    this._callback("FAILURE");
            });
        }
    }
}

var frontend;
var testRunner;
var tests = [];

server.closeTabs().then(() => {
    setTimeout(() => {
        Promise.all([server.newTab(), server.newTab()]).then(mixers => {
            frontend = new Frontend(mixers[0], mixers[1]);
            testRunner = new TestRunner(frontend, mixers[1]);
            Promise.all([frontend.init(), testRunner.init()]).then(() => {
                fs.readdir(testsPath, function(err, items) {
                    for (var item of items) {
                        if (item.endsWith(".html"))
                            tests.push(testsPath + "/" + item);
                    }
                    runTests();
                });
            });
        });
    }, 1000);
});

function runTests()
{
    if (!tests.length)
        process.exit(0);
    var testPath = tests.shift();
    console.log("Running " + testPath + "...");
    frontend.reload(testPath);
    testRunner.runTest(testPath, result => {
        console.log(result);
        runTests();
    });
}
