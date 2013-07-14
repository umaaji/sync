/*
The MIT License (MIT)
Copyright (c) 2013 Calvin Montgomery

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

var Rank = require("./rank.js");
var Auth = require("./auth.js");
var Channel = require("./channel.js").Channel;
var formatTime = require("./media.js").formatTime;
var Server = require("./server.js");
var Database = require("./database.js");
var Logger = require("./logger.js");
var Config = require("./config.js");
var ACP = require("./acp");
var ActionLog = require("./actionlog");

// Represents a client connected via socket.io
var User = function(socket, ip) {
    this.ip = ip;
    this.socket = socket;
    this.loggedIn = false;
    this.rank = Rank.Anonymous;
    this.global_rank = Rank.Anonymous;
    this.channel = null;
    this.name = "";
    this.meta = {
        afk: false,
        icon: false
    };
    this.muted = false;
    this.throttle = {};
    this.flooded = {};
    this.profile = {
        image: "",
        text: ""
    };

    this.initCallbacks();
    if(Server.announcement != null) {
        this.socket.emit("announcement", Server.announcement);
    }
};

// Throttling/cooldown
User.prototype.noflood = function(name, hz) {
    var time = new Date().getTime();
    if(!(name in this.throttle)) {
        this.throttle[name] = [time];
        return false;
    }
    else if(name in this.flooded && time < this.flooded[name]) {
        this.socket.emit("noflood", {
            action: name,
            msg: "You're still on cooldown!"
        });
        return true;
    }
    else {
        this.throttle[name].push(time);
        var diff = (time - this.throttle[name][0]) / 1000.0;
        // Twice might be an accident, more than that is probably spam
        if(this.throttle[name].length > 2) {
            var rate = this.throttle[name].length / diff;
            this.throttle[name] = [time];
            if(rate > hz) {
                this.flooded[name] = time + 5000;
                this.socket.emit("noflood", {
                    action: name,
                    msg: "Stop doing that so fast!  Cooldown: 5s"
                });
                return true;
            }
            return false;
        }
    }
}

User.prototype.initCallbacks = function() {
    const cmodevents = [
        "queue",
        "setTemp",
        "delete",
        "moveMedia"
    ];

    cmodevents.forEach(function (ev) {
        this.socket.on(ev, function (data) {
            if(this.channel !== null)
                this.channel.onUserEvent(ev)(this, data);
        }.bind(this));
    }.bind(this));

    this.socket.on("disconnect", function() {
        if(this.channel != null)
            this.channel.userLeave(this);
    }.bind(this));

    this.socket.on("joinChannel", function(data) {
        if(this.channel != null)
            return;
        if(typeof data.name != "string")
            return;
        if(!data.name.match(/^[a-zA-Z0-9-_]+$/))
            return;
        if(data.name.length > 100)
            return;
        data.name = data.name.toLowerCase();
        this.channel = Server.getOrCreateChannel(data.name);
        if(this.loggedIn) {
            var chanrank = this.channel.getRank(this.name);
            if(chanrank > this.rank) {
                this.rank = chanrank;
            }
        }
        this.channel.userJoin(this);
    }.bind(this));

    this.socket.on("login", function(data) {
        var name = data.name || "";
        var pw = data.pw || "";
        var session = data.session || "";
        if(pw.length > 100)
            pw = pw.substring(0, 100);
        if(this.name == "")
            this.login(name, pw, session);
    }.bind(this));

    this.socket.on("register", function(data) {
        if(data.name == undefined || data.pw == undefined)
            return;
        if(data.pw.length > 100)
            data.pw = data.pw.substring(0, 100);
        this.register(data.name, data.pw);
    }.bind(this));

    this.socket.on("assignLeader", function(data) {
        if(this.channel != null) {
            this.channel.tryChangeLeader(this, data);
        }
    }.bind(this));

    this.socket.on("promote", function(data) {
        if(this.channel != null) {
            this.channel.tryPromoteUser(this, data);
        }
    }.bind(this));

    this.socket.on("demote", function(data) {
        if(this.channel != null) {
            this.channel.tryDemoteUser(this, data);
        }
    }.bind(this));

    this.socket.on("setChannelRank", function(data) {
        if(this.channel != null) {
            this.channel.trySetRank(this, data);
        }
    }.bind(this));

    this.socket.on("banName", function(data) {
        if(this.channel != null) {
            this.channel.banName(this, data.name || "");
        }
    }.bind(this));

    this.socket.on("banIP", function(data) {
        if(this.channel != null) {
            this.channel.tryIPBan(this, data);
        }
    }.bind(this));

    this.socket.on("unban", function(data) {
        if(this.channel != null) {
            this.channel.tryUnban(this, data);
        }
    }.bind(this));

    this.socket.on("chatMsg", function(data) {
        if(this.channel != null) {
            this.channel.tryChat(this, data);
        }
    }.bind(this));

    this.socket.on("newPoll", function(data) {
        if(this.channel != null) {
            this.channel.tryOpenPoll(this, data);
        }
    }.bind(this));

    this.socket.on("playerReady", function() {
        if(this.channel != null) {
            this.channel.sendMediaUpdate(this);
        }
    }.bind(this));

    this.socket.on("requestPlaylist", function() {
        if(this.channel != null) {
            this.channel.sendPlaylist(this);
        }
    }.bind(this));

    this.socket.on("uncache", function(data) {
        if(this.channel != null) {
            this.channel.tryUncache(this, data);
        }
    }.bind(this));

    this.socket.on("jumpTo", function(data) {
        if(this.channel != null) {
            this.channel.tryJumpTo(this, data);
        }
    }.bind(this));

    this.socket.on("playNext", function() {
        if(this.channel != null) {
            this.channel.tryPlayNext(this);
        }
    }.bind(this));

    this.socket.on("clearPlaylist", function() {
        if(this.channel != null) {
            this.channel.tryClearqueue(this);
        }
    }.bind(this));

    this.socket.on("shufflePlaylist", function() {
        if(this.channel != null) {
            this.channel.tryShufflequeue(this);
        }
    }.bind(this));

    this.socket.on("togglePlaylistLock", function() {
        if(this.channel != null) {
            this.channel.tryToggleLock(this);
        }
    }.bind(this));

    this.socket.on("mediaUpdate", function(data) {
        if(this.channel != null) {
            this.channel.tryUpdate(this, data);
        }
    }.bind(this));

    this.socket.on("searchMedia", function(data) {
        if(this.channel != null) {
            if(data.source == "yt") {
                var callback = function(vids) {
                    this.socket.emit("searchResults", {
                        results: vids
                    });
                }.bind(this);
                this.channel.search(data.query, callback);
            }
            else {
                this.socket.emit("searchResults", {
                    results: this.channel.search(data.query)
                });
            }
        }
    }.bind(this));

    this.socket.on("closePoll", function() {
        if(this.channel != null) {
            this.channel.tryClosePoll(this);
        }
    }.bind(this));

    this.socket.on("vote", function(data) {
        if(this.channel != null) {
            this.channel.tryVote(this, data);
        }
    }.bind(this));

    this.socket.on("registerChannel", function(data) {
        if(this.channel == null) {
            this.socket.emit("channelRegistration", {
                success: false,
                error: "You're not in any channel!"
            });
        }
        else {
            this.channel.tryRegister(this);
        }
    }.bind(this));

    this.socket.on("unregisterChannel", function() {
        if(this.channel == null) {
            return;
        }
        if(!this.channel.registered) {
            this.socket.emit("unregisterChannel", {
                success: false,
                error: "This channel is already unregistered"
            });
        }
        else if(this.rank < 10) {
            this.socket.emit("unregisterChannel", {
                success: false,
                error: "You don't have permission to unregister"
            });
        }
        else if(this.channel.unregister()) {
            this.socket.emit("unregisterChannel", {
                success: true
            });
        }
        else {
            this.socket.emit("unregisterChannel", {
                success: false,
                error: "Unregistration failed.  Please see a site admin if this continues."
            });
        }
    }.bind(this));

    this.socket.on("announce", function(data) {
        if(Rank.hasPermission(this, "announce")) {
            if(data.clear) {
                Server.announcement = null;
            }
            else {
                Server.io.sockets.emit("announcement", data);
                Server.announcement = data;
            }
        }
    }.bind(this));

    this.socket.on("setOptions", function(data) {
        if(this.channel != null) {
            this.channel.tryUpdateOptions(this, data);
        }
    }.bind(this));

    this.socket.on("setPermissions", function(data) {
        if(this.channel != null) {
            this.channel.tryUpdatePermissions(this, data);
        }
    }.bind(this));

    this.socket.on("setChannelCSS", function(data) {
        if(this.channel != null) {
            this.channel.trySetCSS(this, data);
        }
    }.bind(this));

    this.socket.on("setChannelJS", function(data) {
        if(this.channel != null) {
            this.channel.trySetJS(this, data);
        }
    }.bind(this));

    this.socket.on("updateFilter", function(data) {
        if(this.channel != null) {
            this.channel.tryUpdateFilter(this, data);
        }
    }.bind(this));

    this.socket.on("removeFilter", function(data) {
        if(this.channel != null) {
            this.channel.tryRemoveFilter(this, data);
        }
    }.bind(this));

    this.socket.on("moveFilter", function(data) {
        if(this.channel != null) {
            this.channel.tryMoveFilter(this, data);
        }
    }.bind(this));

    this.socket.on("setMotd", function(data) {
        if(this.channel != null) {
            this.channel.tryUpdateMotd(this, data);
        }
    }.bind(this));

    this.socket.on("requestLoginHistory", function() {
        if(this.channel != null) {
            this.channel.sendLoginHistory(this);
        }
    }.bind(this));

    this.socket.on("requestBanlist", function() {
        if(this.channel != null) {
            this.channel.sendBanlist(this);
        }
    }.bind(this));

    this.socket.on("requestChatFilters", function() {
        if(this.channel != null) {
            this.channel.sendChatFilters(this);
        }
    }.bind(this));

    this.socket.on("requestChannelRanks", function() {
        if(this.channel != null) {
            if(this.noflood("requestChannelRanks", 0.25))
                return;
            this.channel.sendChannelRanks(this);
        }
    }.bind(this));

    this.socket.on("voteskip", function(data) {
        if(this.channel != null) {
            this.channel.tryVoteskip(this);
        }
    }.bind(this));

    this.socket.on("setProfile", function(data) {
        if(!this.name) {
            return;
        }
        data.image = data.image || "";
        data.text = data.text || "";
        if(data.text.length > 4000) {
            data.text = data.text.substring(0, 4000);
        }
        if(Database.setProfile(this.name, data)) {
            this.profile = data;
            if(this.channel != null) {
                this.channel.broadcastUserUpdate(this);
            }
        }
    }.bind(this));

    this.socket.on("listPlaylists", function(data) {
        if(this.name == "" || this.rank < 1) {
            this.socket.emit("listPlaylists", {
                pllist: [],
                error: "You must be logged in to manage playlists"
            });
            return;
        }

        var list = Database.getUserPlaylists(this.name);
        for(var i = 0; i < list.length; i++) {
            list[i].time = formatTime(list[i].time);
        }
        this.socket.emit("listPlaylists", {
            pllist: list,
        });
    }.bind(this));

    this.socket.on("savePlaylist", function(data) {
        if(this.rank < 1) {
            socket.emit("savePlaylist", {
                success: false,
                error: "You must be logged in to manage playlists"
            });
            return;
        }

        if(this.channel == null) {
            socket.emit("savePlaylist", {
                success: false,
                error: "Not in a channel"
            });
            return;
        }

        if(typeof data.name != "string") {
            return;
        }

        var pl = this.channel.playlist.items.toArray();
        var result = Database.saveUserPlaylist(pl, this.name, data.name);
        this.socket.emit("savePlaylist", {
            success: result,
            error: result ? false : "Unknown"
        });
        var list = Database.getUserPlaylists(this.name);
        for(var i = 0; i < list.length; i++) {
            list[i].time = formatTime(list[i].time);
        }
        this.socket.emit("listPlaylists", {
            pllist: list,
        });
    }.bind(this));

    this.socket.on("queuePlaylist", function(data) {
        if(this.channel != null) {
            this.channel.tryQueuePlaylist(this, data);
        }
    }.bind(this));

    this.socket.on("deletePlaylist", function(data) {
        if(typeof data.name != "string") {
            return;
        }

        Database.deleteUserPlaylist(this.name, data.name);
        var list = Database.getUserPlaylists(this.name);
        for(var i = 0; i < list.length; i++) {
            list[i].time = formatTime(list[i].time);
        }
        this.socket.emit("listPlaylists", {
            pllist: list,
        });
    }.bind(this));

    this.socket.on("acp-init", function() {
        if(this.global_rank >= Rank.Siteadmin)
            ACP.init(this);
    }.bind(this));

    this.socket.on("borrow-rank", function(rank) {
        if(this.global_rank < 255)
            return;
        if(rank > this.global_rank)
            return;

        this.rank = rank;
        this.socket.emit("rank", rank);
        if(this.channel != null)
            this.channel.broadcastUserUpdate(this);

    }.bind(this));
}

var lastguestlogin = {};
// Attempt to login
User.prototype.login = function(name, pw, session) {
    // No password => try guest login
    if(pw == "" && session == "") {
        if(this.ip in lastguestlogin) {
            var diff = (Date.now() - lastguestlogin[this.ip])/1000;
            if(diff < Config.GUEST_LOGIN_DELAY) {
                this.socket.emit("login", {
                    success: false,
                    error: ["Guest logins are restricted to one per ",
                            Config.GUEST_LOGIN_DELAY + " seconds per IP.  ",
                            "This restriction does not apply to registered users."
                            ].join("")
                });
                return false;
            }
        }
        try {
            // Sorry bud, can't take that name
            if(Auth.isRegistered(name)) {
                this.socket.emit("login", {
                    success: false,
                    error: "That username is already taken"
                });
                return false;
            }
            // YOUR ARGUMENT IS INVALID
            else if(!Auth.validateName(name)) {
                this.socket.emit("login", {
                    success: false,
                    error: "Invalid username.  Usernames must be 1-20 characters long and consist only of alphanumeric characters and underscores"
                });
            }
            else {
                if(this.channel != null) {
                    for(var i = 0; i < this.channel.users.length; i++) {
                        if(this.channel.users[i].name == name) {
                            this.socket.emit("login", {
                                success: false,
                                error: "That name is already taken on this channel"
                            });
                            return;
                        }
                    }
                }
                lastguestlogin[this.ip] = Date.now();
                this.rank = Rank.Guest;
                Logger.syslog.log(this.ip + " signed in as " + name);
                Database.recordVisit(this.ip, name);
                this.name = name;
                this.loggedIn = false;
                this.socket.emit("login", {
                    success: true,
                    name: name
                });
                this.socket.emit("rank", this.rank);
                if(this.channel != null) {
                    this.channel.logger.log(this.ip + " signed in as " + name);
                    this.channel.broadcastNewUser(this);
                }
            }
        }
        catch(e) {
            this.socket.emit("login", {
                success: false,
                error: e
            });
        }
    }
    else {
        try {
            var row;
            if((row = Auth.login(name, pw, session))) {
                if(this.channel != null) {
                    for(var i = 0; i < this.channel.users.length; i++) {
                        if(this.channel.users[i].name == name) {
                            this.channel.kick(this.channel.users[i], "Duplicate login");
                        }
                    }
                }
                ActionLog.record(this.ip, name, "login-success");
                this.loggedIn = true;
                this.socket.emit("login", {
                    success: true,
                    session: row.session_hash,
                    name: name
                });
                Logger.syslog.log(this.ip + " logged in as " + name);
                Database.recordVisit(this.ip, name);
                this.profile = {
                    image: row.profile_image,
                    text: row.profile_text
                };
                var chanrank = (this.channel != null) ? this.channel.getRank(name)
                                                      : Rank.Guest;
                var rank = (chanrank > row.global_rank) ? chanrank
                                                         : row.global_rank;
                this.rank = (this.rank > rank) ? this.rank : rank;
                this.global_rank = row.global_rank;
                this.socket.emit("rank", this.rank);
                this.name = name;
                if(this.channel != null) {
                    this.channel.logger.log(this.ip + " logged in as " + name);
                    this.channel.broadcastNewUser(this);
                }
            }
            // Wrong password
            else {
                ActionLog.record(this.ip, this.name, "login-failure");
                this.socket.emit("login", {
                    success: false,
                    error: "Invalid session"
                });
                return false;
            }
        }
        catch(e) {
            this.socket.emit("login", {
                success: false,
                error: e
            });
        }
    }
}

// Attempt to register a user account
User.prototype.register = function(name, pw) {
    if(pw == "") {
        // Sorry bud, password required
        this.socket.emit("register", {
            success: false,
            error: "You must provide a password"
        });
        return false;
    }
    else if(Auth.isRegistered(name)) {
        this.socket.emit("register", {
            success: false,
            error: "That username is already taken"
        });
        return false;
    }
    else if(!Auth.validateName(name)) {
        this.socket.emit("register", {
            success: false,
            error: "Invalid username.  Usernames must be 1-20 characters long and consist only of alphanumeric characters and underscores"
        });
    }
    else if(Auth.register(name, pw)) {
        console.log(this.ip + " registered " + name);
        this.socket.emit("register", {
            success: true
        });
        this.login(name, pw);
    }
    else {
        this.socket.emit("register", {
            success: false,
            error: "[](/ppshrug) Registration Failed."
        });
    }
}

exports.User = User;
