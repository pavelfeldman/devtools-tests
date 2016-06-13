// Copyright 2016 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

var events = require("events");
var http = require("http");
var WebSocket = require("ws");

var logTransport = false;

module.exports = {
    Connection: RDPConnection,
    ConnectionMixer: RDPConnectionMixer,
    Server: RDPServer
}

function RDPConnectionMixer(wsurl)
{
    this._wsurl = wsurl;
    this._forkedConnections = new Set();
    this._pendingMessages = [];
    this._pendingCallbacks = new Map();
    this._id = 0;
}

RDPConnectionMixer.prototype = {
    fork(name)
    {
        var connection = new RDPConnection(this, name);
        this._forkedConnections.add(connection);
        return connection;
    },

    reconnect()
    {
        this._pendingMessages = [];
        this._pendingCallbacks.clear();
        this._resetConnection();
    },

    _resetConnection()
    {
        if (this._ws)
            this._ws.close();
        this._ws = null;
        this._id = 0;
        this._initPromise = null;
    },

    init()
    {
        if (!this._initPromise) {
            this._initPromise = new Promise((fulfill, reject) => {
                this._ws = new WebSocket(this._wsurl);
                this._ws.on("message", message => this._dispatchMessage(message));
                this._ws.on("open", fulfill);
            });
        }
        return this._initPromise;
    },

    release(connection)
    {
        this._forkedConnections.delete(connection);
    },

    _sendJSON(client, message)
    {
        var id = ++this._id;
        this._pendingCallbacks.set(id, [client, message.id]);
        message.id = id;
        this._pendingMessages.push(message);
        this._sendPendingMessages();
    },

    _sendPendingMessages()
    {
        if (!this._pendingMessages.length)
            return;
        this._sendMessage(this._pendingMessages.shift()).then(this._sendPendingMessages.bind(this));
    },

   _sendMessage(message)
    {
        return new Promise((fulfill, reject) => {
            this.init().then(() => {
                this._ws.send(JSON.stringify(message), error => {
                    if (!error) {
                        fulfill();
                        return;
                    }
                    this._resetConnection();
                    setTimeout(() => {
                        this._sendMessage(message).then(fulfill);
                    }, 100);
                });
            });
        });
    },

    _dispatchMessage(data)
    {
        var message = JSON.parse(data);
        if (!("id" in message)) {
            for (connection of this._forkedConnections)
                connection._dispatchJSON(message);
            return;
        }

        var data = this._pendingCallbacks.get(message.id);
        if (data) {
            this._pendingCallbacks.delete(message.id);
            message.id = data[1];
            data[0]._dispatchJSON(message);
        }
    }
}

function RDPConnection(mixer, name)
{
    events.EventEmitter.call(this);
    this._id = 0;
    this._name = name;
    this._requests = new Map();
    this._mixer = mixer;
}

RDPConnection.prototype = {
    reconnect: function()
    {
        if (logTransport)
            console.log(this._name + " ==== [reconnect] ===");
        return this._mixer.reconnect();
    },

    sendCommand(method, params)
    {
        return this.sendCommandObject({
            id: ++this._id,
            method: method,
            params: params
        });
    },

    sendCommandObject(object)
    {
        return new Promise((fulfill, reject) => {
            this._requests.set(object.id, fulfill);
            if (logTransport)
                console.log(this._name + " => " + object.id + " " + object.method);
            this._mixer._sendJSON(this, object);
        });
    },

    _dispatchJSON(message)
    {
        if (logTransport)
            console.log(this._name + " <= " + (message.id || "") + " " + (message.method || ""));
        if (!("id" in message)) {
            this.emit("notification", message);
            return;
        }
        var cb = this._requests.get(message.id);
        if (cb) {
            this._requests.delete(message.id);
            cb(message);
        }
    },

    __proto__: events.EventEmitter.prototype
}

function RDPServer(host, port)
{
    this._host = host;
    this._port = port;
}

RDPServer.prototype = {
    closeTabs()
    {
        return this._sendRequest("list").then(result => {
            var list = JSON.parse(result);
            var promises = list.map(entry => this._sendRequest("close/" + entry.id));
            return Promise.all(promises);
        });
    },

    newTab(activate)
    {
        return this._sendRequest("new").then(result => {
            var response = JSON.parse(result);
            var wsurl = response.webSocketDebuggerUrl;
            if (activate)
                this._sendRequest("activate/" + response.id);
            var mixer = new RDPConnectionMixer(wsurl);
            return mixer.init().then(() => mixer);
        });
    },

    _sendRequest(path)
    {
        return new Promise((fulfill, reject) => {
            http.get({
                host: this._host,
                port: this._port,
                path: "/json/" + path
            }, response => {
                // Continuously update stream with data
                var body = "";
                response.on("data", d => {
                    body += d;
                });
                response.on("end", () => {
                    fulfill(body);
                });
            });
        });
    }
}
