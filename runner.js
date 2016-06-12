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

function runTest(testPath)
{
    return new Promise((fulfill, reject) => {
	    var expectationsPath = testPath.replace(".html", "-expected.txt");
		fs.readFile(expectationsPath, "utf8", (err, data) => {
			server.closeTabs().then(() => {
				setTimeout(() => { // FIXME: chrome bug !!!
	               	Promise.all([server.newTab(), server.newTab()])
	               	    .then(runTestWithConnections.bind(null, testPath, data, fulfill, reject));
				}, 1000);
			});
		});
    });
}

function runTestWithConnections(testPath, expectations, fulfill, reject, mixers)
{
	var tc = mixers[0].fork("testRunner");
	var ic = mixers[0].fork("                                                                                                    inspected");
	var fc = mixers[1].fork("                                                 frontend");
	var frontendLoaded = false;
	var testCompleted = false;
	var watchdogTimer = setTimeout(reject, 10000);

	tc.on("notification", notification => {
		if (notification.method !== "Console.messageAdded")
			return;
		var text = notification.params.message.text;
		if (!text.startsWith("#devtools-tests#"))
			return;

		var command = JSON.parse(text.substring("#devtools-tests#".length));
		// console.log("test: " + command.method);
		if (command.method === "evaluateInWebInspector") {
			evaluateInWebInspector(command.args[1]);
		}
		else if (command.method === "notifyDone") {
			testCompleted = true;
    	    tc.sendCommand("Runtime.enable");
			tc.sendCommand("Runtime.evaluate", { expression: "document.documentElement.innerText" }).then(response => {
				var actual = response.result.result.value + "\n";
				clearTimeout(watchdogTimer);
				if (actual === expectations)
					fulfill("SUCCESS");
				else
					fulfill("FAILURE");
			});
		}
	});
	tc.sendCommand("Console.enable");
    tc.sendCommand("Page.enable");
    tc.sendCommand("Page.addScriptToEvaluateOnLoad", { scriptSource: "(" + testRunnerPatch + ")()" }).then(response => {
	    tc.sendCommand("Page.navigate", { url: "file://" + testPath});
    });

	ic.on("notification", notification => {
		fc.sendCommand("Runtime.evaluate", { expression: "InspectorFrontendHost.dispatchMessageOnFrontend(" + JSON.stringify(notification) + ")"});
	});

	fc.on("notification", notification => {
		if (testCompleted)
			return;
		if (notification.method !== "Console.messageAdded")
		    return;
	    var text = notification.params.message.text;
		if (!text.startsWith("#devtools-tests#"))
			return;

		var command = JSON.parse(text.substring("#devtools-tests#".length));
		if (command.method === "sendMessageToBackend") {
			if (command.args[0]) {
				ic.sendCommandObject(JSON.parse(command.args[0])).then(response => {
					fc.sendCommand("Runtime.evaluate", { expression: "InspectorFrontendHost.dispatchMessageOnFrontend(" + JSON.stringify(response) + ")"});
				});
			}
		} else if (command.method === "readyForTest") {
			frontendLoaded = true;
			evaluateInWebInspector();
		}
	});

    Promise.all([fc.sendCommand("Console.enable"),
    	         fc.sendCommand("Page.enable"),
//    	         fc.sendCommand("Network.setCacheDisabled", { cacheDisabled: true }),
    	         fc.sendCommand("Runtime.enable")]).then(() => {
	    fc.sendCommand("Page.addScriptToEvaluateOnLoad", { scriptSource: "(" + frontendPatch + ")('" + testPath + "')" }).then(response => {
	    	// console.log(response);
		    fc.sendCommand("Page.navigate", { url: frontendPath});
	    });
	});

	var evaluateInWebInspectorCommands = [];
    function evaluateInWebInspector(code)
    {
    	if (code)
        	evaluateInWebInspectorCommands.push(code);
    	if (!frontendLoaded || !evaluateInWebInspectorCommands.length)
    		return;
    	var payload = evaluateInWebInspectorCommands.shift();
        fc.sendCommand("Runtime.evaluate", { expression: payload }).then(evaluateInWebInspector.bind(null, null));
    }
}

var tests = [];

fs.readdir(testsPath, function(err, items) { 
    for (var item of items) {
    	if (item.endsWith(".html"))
    		tests.push(testsPath + "/" + item);
    }
    runTests();
});

function runTests()
{
	if (!tests.length)
		process.exit(0);
	var test = tests.shift();
	console.log("Running " + test + "...");
    runTest(test).then(result => {
    	console.log(result);
    	runTests();
    }).catch(() => {
    	console.log("TIMEOUT");
    	runTests();
    });
}
