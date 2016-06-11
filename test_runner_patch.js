// Copyright 2016 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

module.exports = function() {
    function TestRunner() {}
    TestRunner.prototype = {
        dumpAsText()
        {
            this._send("dumpAsText");
        },

        waitUntilDone()
        {
            this._send("waitUntilDone");
        },

        evaluateInWebInspector(id, code)
        {
            this._send("evaluateInWebInspector", [id, code]);
        },

        closeWebInspector()
        {
            this._send("closeWebInspector");
        },

        notifyDone()
        {
            this._send("notifyDone");
        },

        _send(method, args)
        {
        	console.log("#devtools-tests#" + JSON.stringify({ method: method, args: args || {}}));
        }
    };
    window.testRunner = new TestRunner();
}
