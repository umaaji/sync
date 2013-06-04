var Logger = require("./logger");

const chars = "abcdefghijklmnopqsrtuvwxyz" +
              "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
              "0123456789";

var NotWebsocket = function() {
    this.hash = "";
    for(var i = 0; i < 30; i++) {
        this.hash += chars[parseInt(Math.random() * (chars.length - 1))];
    }

    this.pktqueue = [];
    this.handlers = {};
    this.room = "";
    this.lastpoll = Date.now();
}

NotWebsocket.prototype.emit = function(msg, data) {
    var pkt = [msg, data];
    this.pktqueue.push(pkt);
}

NotWebsocket.prototype.poll = function() {
    this.lastpoll = Date.now();
    var q = [];
    for(var i = 0; i < this.pktqueue.length; i++) {
        q.push(this.pktqueue[i]);
    }
    this.pktqueue.length = 0;
    if(q.length > 0)
        console.log("sending", q.length);
    return q;
}

NotWebsocket.prototype.on = function(msg, callback) {
    if(!(msg in this.handlers))
        this.handlers[msg] = [];
    this.handlers[msg].push(callback);
}

NotWebsocket.prototype.recv = function(urlstr) {
    var msg, data;
    try {
        var js = JSON.parse(urlstr);
        msg = js[0];
        data = js[1];
    }
    catch(e) {
        Logger.errlog.log("Failed to parse NWS string");
        Logger.errlog.log(urlstr);
    }
    if(!msg)
        return;
    if(!(msg in this.handlers))
        return;
    for(var i = 0; i < this.handlers[msg].length; i++) {
        this.handlers[msg][i](data);
    }
}

NotWebsocket.prototype.join = function(rm) {
    if(!(rm in rooms)) {
        rooms[rm] = [];
    }

    rooms[rm].push(this);
}

NotWebsocket.prototype.leave = function(rm) {
    if(rm in rooms) {
        var idx = rooms[rm].indexOf(this);
        if(idx >= 0) {
            rooms[rm].splice(idx, 1);
        }
    }
}

NotWebsocket.prototype.disconnect = function() {
    for(var rm in rooms) {
        this.leave(rm);
    }

    this.recv(JSON.stringify(["disconnect", undefined]));
    this.emit("disconnect");

    clients[this.hash] = null;
    delete clients[this.hash];
}

function sendJSON(res, obj) {
    var response = JSON.stringify(obj, null, 4);
    if(res.callback) {
        response = res.callback + "(" + response + ")";
    }
    var len = unescape(encodeURIComponent(response)).length;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Length", len);
    res.end(response);
}

var clients = {};
var rooms = {};

function newConnection(req, res) {
    var nws = new NotWebsocket();
    clients[nws.hash] = nws;
    sendJSON(res, nws.hash);
    return nws;
}
exports.newConnection = newConnection;

function msgReceived(req, res) {
    var h = req.params.hash;
    if(h in clients && clients[h] != null) {
        if(req.params.str == "poll") {
            sendJSON(res, clients[h].poll());
        }
        else {
            clients[h].recv(unescape(req.params.str));
            sendJSON(res, "");
        }
    }
    else {
        res.send(404);
    }
}
exports.msgReceived = msgReceived;

function inRoom(rm) {
    var cl = [];

    if(rm in rooms) {
        for(var i = 0; i < rooms[rm].length; i++) {
            cl.push(rooms[rm][i]);
        }
    }

    cl.emit = function(msg, data) {
        for(var i = 0; i < this.length; i++) {
            this[i].emit(msg, data);
        }
    };

    return cl;
}
exports.inRoom = inRoom;

function checkDeadSockets() {
    for(var h in clients) {
        if(Date.now() - clients[h].lastpoll >= 2000) {
            clients[h].disconnect();
        }
    }
}

setInterval(checkDeadSockets, 2000);