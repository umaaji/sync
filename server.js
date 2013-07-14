/*
The MIT License (MIT)
Copyright (c) 2013 Calvin Montgomery

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

const VERSION = "2.0.5";

var fs = require("fs");
var Logger = require("./logger.js");

Logger.syslog.log("Starting CyTube v" + VERSION);
var Config = require("./config.js");
var express = require("express");
var API = require("./api.js");
var NWS = require("./notwebsocket");

var app = express();
app.get("/r/:channel(*)", function(req, res, next) {
    var param = req.params.channel;
    if(!param.match(/^[a-zA-Z0-9-_]+$/)) {
        res.redirect("/" + param);
    }
    else {
        res.sendfile(__dirname + "/www/channel.html");
    }
});

app.get("/api/:apireq(*)", function(req, res, next) {
    API.handle(req.url.substring(5), req, res);
});

function getClientIP(req) {
    var ip = false;
    var raw = req.connection.remoteAddress;
    var forward = req.header("x-forwarded-for");
    if(Config.REVERSE_PROXY && forward) {
        ip = forward.split(",")[0];
        Logger.syslog.log("/" + ip + " is proxied by /" + raw);
        return ip;
    }
    return raw;
}

app.get("/nws/connect", function(req, res, next) {
    var socket = NWS.newConnection(req, res);
    var ip = getClientIP(req);
    if(Database.checkGlobalBan(ip)) {
        Logger.syslog.log("Disconnecting " + ip + " - bant");
        socket.emit("kick", {
            reason: "You're globally banned!"
        });
        socket.disconnect(true);
        return;
    }
    socket.on("disconnect", function() {
        exports.clients[ip]--;
    });
    if(!(ip in exports.clients)) {
        exports.clients[ip] = 1;
    }
    else {
        exports.clients[ip]++;
    }
    if(exports.clients[ip] > Config.MAX_PER_IP) {
        socket.emit("kick", {
            reason: "Too many connections from your IP address"
        });
        socket.disconnect(true);
        return;
    }
    var user = new User(socket, ip);
    Logger.syslog.log("Accepted connection from /" + user.ip);
});

app.get("/nws/:hash/:str", function(req, res, next) {
    NWS.msgReceived(req, res);
});

app.get("/:thing(*)", function(req, res, next) {
    res.sendfile(__dirname + "/www/" + req.params.thing);
});

app.use(function(err, req, res, next) {
    if(404 == err.status) {
        res.statusCode = 404;
        res.send("Page not found");
    }
    else {
        next(err);
    }
});
//app.use(express.static(__dirname + "/www"));
var httpserv = app.listen(Config.WEBSERVER_PORT);
var ioserv = express().listen(Config.IO_PORT);

exports.io = require("socket.io").listen(ioserv);
exports.io.set("log level", 1);
var User = require("./user.js").User;
var Database = require("./database.js");
Database.setup(Config);
Database.init();

var channels = {};
exports.clients = {};

fs.exists("chandump", function(exists) {
    if(!exists) {
        fs.mkdir("chandump", function(err) {
            if(err)
                Logger.errlog.log(err);
        });
    }
});

fs.exists("chanlogs", function(exists) {
    if(!exists) {
        fs.mkdir("chanlogs", function(err) {
            if(err)
                Logger.errlog.log(err);
        });
    }
});

function getSocketIP(socket) {
    var raw = socket.handshake.address.address;
    if(Config.REVERSE_PROXY) {
        if(typeof socket.handshake.headers["x-forwarded-for"] == "string") {
            var ip = socket.handshake.headers["x-forwarded-for"].split(",")[0];
            Logger.syslog.log("/" + ip + " is proxied by /" + raw);
            return ip;
        }
    }
    return socket.handshake.address.address;
}

exports.io.sockets.on("connection", function(socket) {
    var ip = getSocketIP(socket);
    if(Database.checkGlobalBan(ip)) {
        Logger.syslog.log("Disconnecting " + ip + " - bant");
        socket.emit("kick", {
            reason: "You're globally banned!"
        });
        socket.disconnect(true);
        return;
    }
    socket.on("disconnect", function() {
        exports.clients[ip]--;
    });
    if(!(ip in exports.clients)) {
        exports.clients[ip] = 1;
    }
    else {
        exports.clients[ip]++;
    }
    if(exports.clients[ip] > Config.MAX_PER_IP) {
        socket.emit("kick", {
            reason: "Too many connections from your IP address"
        });
        socket.disconnect(true);
        return;
    }
    var user = new User(socket, ip);
    Logger.syslog.log("Accepted connection from /" + user.ip);
});

if(!Config.DEBUG) {
    process.on("uncaughtException", function(err) {
        Logger.errlog.log("[SEVERE] Uncaught Exception: " + err);
        Logger.errlog.log(err.stack);
    });

    process.on("exit", shutdown);
    process.on("SIGINT", shutdown);
}

function shutdown() {
    Logger.syslog.log("Unloading channels...");
    for(var name in channels) {
        if(channels[name].registered)
            channels[name].saveDump();
    }
    Logger.syslog.log("Shutting Down");
    process.exit(0);
}

exports.getChannel = function (name) {
    return channels[name];
}

exports.getAllChannels = function () {
    return channels;
}

var Channel = require("./channel.js").Channel;
exports.createChannel = function (name) {
    var chan = new Channel(name);
    channels[name] = chan;
    return chan;
}

exports.getOrCreateChannel = function (name) {
    var chan = exports.getChannel(name);
    if(chan !== undefined)
        return chan;
    return exports.createChannel(name);
}

exports.unload = function(chan) {
    if(chan.registered) {
        chan.saveDump();
    }
    chan.playlist.die();
    delete channels[chan.name];
    for(var i in chan)
        delete chan[i];
}
