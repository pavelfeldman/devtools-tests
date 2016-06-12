// Copyright 2016 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

module.exports = function() {
    /**
     * @constructor
     * @implements {InspectorFrontendHostAPI}
     * @suppressGlobalPropertiesCheck
     */
    InspectorFrontendHostStub = function()
    {
        for (var method of [ "bringToFront",
                             "closeWindow",
                             "copyText",
                             "inspectElementCompleted",
                             "loadCompleted",
                             "openInNewTab",
                             "readyForTest",
                             "sendMessageToBackend" ]) {
            this[method] = function(method) {
                var args = Array.prototype.slice.call(arguments, 1);
                console.log("#devtools-tests#" + JSON.stringify({ method: method, args: args || []}));
            }.bind(null, method);
        }
        this._prefs = {};
    }

    InspectorFrontendHostStub.prototype = {

        dispatchMessageOnFrontend: function(message)
        {
            this.events.dispatchEventToListeners(InspectorFrontendHostAPI.Events.DispatchMessage, message);
        },

        getSelectionBackgroundColor: function() { return "#6e86ff"; },

        getSelectionForegroundColor: function() { return "#ffffff"; },

        platform: function()
        {
            var match = navigator.userAgent.match(/Windows NT/);
            if (match)
                return "windows";
            match = navigator.userAgent.match(/Mac OS X/);
            if (match)
                return "mac";
            return "linux";
        },

        setIsDocked: function(isDocked, callback) {  setTimeout(callback, 0); },

        setInspectedPageBounds: function(bounds) { },

        setInjectedScriptForOrigin: function(origin, script) { },

        inspectedURLChanged: function(url)
        {
            document.title = WebInspector.UIString("Developer Tools - %s", url);
        },

        save: function(url, content, forceSaveAs)
        {
            console.error("Saving files is not enabled in hosted mode. Please inspect using chrome://inspect");
            this.events.dispatchEventToListeners(InspectorFrontendHostAPI.Events.CanceledSaveURL, url);
        },

        append: function(url, content)
        {
            console.error("Saving files is not enabled in hosted mode. Please inspect using chrome://inspect");
        },

        recordEnumeratedHistogram: function(actionName, actionCode, bucketSize) { },

        requestFileSystems: function()
        {
            this.events.dispatchEventToListeners(InspectorFrontendHostAPI.Events.FileSystemsLoaded, []);
        },

        addFileSystem: function(fileSystemPath)
        {
        },

        removeFileSystem: function(fileSystemPath)
        {
        },

        isolatedFileSystem: function(fileSystemId, registeredName)
        {
            return null;
        },

        loadNetworkResource: function(url, headers, streamId, callback)
        {
            callback({statusCode : 404});
        },

        getPreferences: function(callback)
        {
            callback(this._prefs);
        },

        setPreference: function(name, value)
        {
            this._prefs[name] = value;
        },

        removePreference: function(name)
        {
            delete this._prefs[name];
        },

        clearPreferences: function()
        {
            this._prefs = {};
        },

        upgradeDraggedFileSystemPermissions: function(fileSystem) { },

        indexPath: function(requestId, fileSystemPath) { },

        stopIndexing: function(requestId) { },

        searchInPath: function(requestId, fileSystemPath, query) { },

        zoomFactor: function() { return 1; },

        zoomIn: function() { },

        zoomOut: function() { },

        resetZoom: function() { },

        setWhitelistedShortcuts: function(shortcuts) { },

        isUnderTest: function() { return true; },

        setDevicesDiscoveryConfig: function(discoverUsbDevices, portForwardingEnabled, portForwardingConfig) { },

        setDevicesUpdatesEnabled: function(enabled) { },

        performActionOnRemotePage: function(pageId, action) { },

        openRemotePage: function(browserId, url) { },

        showContextMenuAtPoint: function(x, y, items, document)
        {
            throw "Soft context menu should be used";
        },

        isHostedMode: function() { return false; },
    };
    InspectorFrontendHost = new InspectorFrontendHostStub();
}
