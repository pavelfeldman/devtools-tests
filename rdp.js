// Copyright 2016 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

var events = require("events");
var http = require("http");
var WebSocket = require("ws");

var log = false;

module.exports = {
    Connection: RDPConnection,
    ConnectionMixer: RDPConnectionMixer,
    Server: RDPServer
}

function RDPConnectionMixer(ws)
{
    this._id = 0;
    this._requests = new Map();
	this._ws = ws;
    this._ws.on("message", message => this._dispatchMessage(message));
    this._forkedConnections = new Set();
}

RDPConnectionMixer.connect = function(wsurl)
{
    return new Promise((fulfill, reject) => {
		var ws = new WebSocket(wsurl);
        ws.on("open", () => {
            fulfill(new RDPConnectionMixer(ws));
        });
    });
}

RDPConnectionMixer.prototype = {
	fork: function(name)
	{
        var connection = new RDPConnection(this, name);
        this._forkedConnections.add(connection);
        return connection;
	},

    release: function(connection)
    {
        this._forkedConnections.delete(connection);
    },

	_sendJSON(client, message)
	{
		var id = ++this._id;
		this._requests.set(id, [client, message.id]);
		message.id = id;
		this._ws.send(JSON.stringify(message));
	},

    _dispatchMessage(data)
    {
        var message = JSON.parse(data);
        if (!("id" in message)) {
        	for (connection of this._forkedConnections)
        		connection._dispatchJSON(message);
        	return;
        }

        var data = this._requests.get(message.id);
        if (data) {
            this._requests.delete(message.id);
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
    		if (log)
        		console.log(this._name + " => " + object.id + " " + object.method);
    		this._mixer._sendJSON(this, object);
        });
    },

    _dispatchJSON(message)
    {
    	if (log)
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

    newTab()
    {
		return this._sendRequest("new").then(result => {
			var wsurl = JSON.parse(result).webSocketDebuggerUrl;
		    return RDPConnectionMixer.connect(wsurl);
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
