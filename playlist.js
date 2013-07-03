var ULList = require("./ullist").ULList;
var Media = require("./media").Media;
var InfoGetter = require("./get-info");

function PlaylistItem(media, uid) {
    this.media = media;
    this.uid = uid;
    this.temp = false;
    this.queueby = "";
    this.prev = null;
    this.next = null;
}

PlaylistItem.prototype.pack = function() {
    return {
        media: this.media.pack(),
        uid: this.uid,
        temp: this.temp,
        queueby: this.queueby
    };
}

function Playlist(chan) {
    this.items = new ULList();
    this.next_uid = 0;
    this._leadInterval = false;
    this._lastUpdate = 0;
    this._counter = 0;
    this.leading = true;
    this.callbacks = {
        "changeMedia": [],
        "mediaUpdate": [],
        "remove": [],
    };
    this.lock = false;
    this.alter_queue = [];
    this._qaInterval = false;

    if(chan) {
        var pl = this;
        this.on("mediaUpdate", function(m) {
            chan.sendAll("mediaUpdate", m.timeupdate());
        });
        this.on("changeMedia", function(m) {
            chan.sendAll("setCurrent", pl.current.uid);
            chan.sendAll("changeMedia", m.fullupdate());
        });
        this.on("remove", function(item) {
            chan.sendAll("delete", {
                uid: item.uid
            });
        });
    }
}

Playlist.prototype.queueAction = function(data) {
    this.alter_queue.push(data);
    if(this._qaInterval)
        return;
    var pl = this;
    this._qaInterval = setInterval(function() {
        if(!pl.lock) {
            var data = pl.alter_queue.shift();
            if(data.waiting) {
                if(!("expire" in data))
                    data.expire = Date.now() + 5000;
                if(Date.now() < data.expire)
                    pl.alter_queue.unshift(data);
                return;
            }
            data.fn();
            if(pl.alter_queue.length == 0) {
                clearInterval(pl._qaInterval);
                pl._qaInterval = false;
            }
        }
    }, 100);
}

Playlist.prototype.dump = function() {
    var arr = this.items.toArray();
    var pos = 0;
    for(var i in arr) {
        if(this.current && arr[i].uid == this.current.uid) {
            pos = i;
            break;
        }
    }

    var time = 0;
    if(this.current)
        time = this.current.media.currentTime;

    return {
        pl: arr,
        pos: pos,
        time: time
    };
}

Playlist.prototype.load = function(data, callback) {
    this.clear();
    for(var i in data.pl) {
        var e = data.pl[i].media;
        var m = new Media(e.id, e.title, e.seconds, e.type);
        var it = this.makeItem(m);
        it.temp = data.pl[i].temp;
        it.queueby = data.pl[i].queueby;
        this.items.append(it);
        if(i == parseInt(data.pos)) {
            this.current = it;
            this.startPlayback(data.time);
        }
    }

    if(callback)
        callback();
}

Playlist.prototype.on = function(ev, fn) {
    if(typeof fn === "undefined") {
        var pl = this;
        return function() {
            for(var i = 0; i < pl.callbacks[ev].length; i++) {
                pl.callbacks[ev][i].apply(this, arguments);
            }
        }
    }
    else if(typeof fn === "function") {
        this.callbacks[ev].push(fn);
    }
}

Playlist.prototype.makeItem = function(media) {
    return new PlaylistItem(media, this.next_uid++);
}

Playlist.prototype.add = function(item, pos) {
    var success;
    if(pos == "append")
        success = this.items.append(item);
    else if(pos == "prepend")
        success = this.items.prepend(item);
    else
        success = this.items.insertAfter(item, pos);

    if(success && this.items.length == 1) {
        this.current = item;
        this.startPlayback();
    }

    return success;
}

Playlist.prototype.addMedia = function(data, callback) {

    if(data.type == "yp") {
        this.addYouTubePlaylist(data, callback);
        return;
    }

    var pos = "append";
    if(data.pos == "next") {
        if(!this.current)
            pos = "prepend";
        else
            pos = this.current.uid;
    }

    var it = this.makeItem(null);
    var pl = this;
    var action = {
        fn: function() {
            if(pl.add(it, pos))
                callback(false, it);
        },
        waiting: true
    };
    this.queueAction(action);

    InfoGetter.getMedia(data.id, data.type, function(err, media) {
        if(err) {
            action.expire = 0;
            callback(err, null);
            return;
        }

        it.media = media;
        it.temp = data.temp;
        it.queueby = data.queueby;
        action.waiting = false;
    });
}

Playlist.prototype.addMediaList = function(data, callback) {
    if(data.pos == "next")
        data.list = data.list.reverse();

    var pl = this;
    data.list.forEach(function(x) {
        x.pos = data.pos;
        pl.addMedia(x, callback);
    });
}

Playlist.prototype.addYouTubePlaylist = function(data, callback) {
    var pos = "append";
    if(data.pos == "next") {
        if(!this.current)
            pos = "prepend";
        else
            pos = this.current.uid;
    }

    var pl = this;
    InfoGetter.getMedia(data.id, data.type, function(err, vids) {
        console.log(vids.length);
        if(err) {
            callback(err, null);
            return;
        }

        vids.forEach(function(media) {
            var it = pl.makeItem(media);
            it.temp = data.temp;
            it.queueby = data.queueby;
            pl.queueAction({
                fn: function() {
                    if(pl.add(it, pos))
                        callback(false, it);
                },
            });
        });
    });
}

Playlist.prototype.remove = function(uid, callback) {
    var pl = this;
    this.queueAction({
        fn: function() {
            var item = pl.items.find(uid);
            if(pl.items.remove(uid)) {
                if(item == pl.current)
                    pl._next();
                if(callback)
                    callback();
            }
        },
        waiting: false
    });
}

Playlist.prototype.move = function(from, after, callback) {
    var pl = this;
    this.queueAction({
        fn: function() {
            pl._move(from, after, callback);
        },
        waiting: false
    });
}

Playlist.prototype._move = function(from, after, callback) {
    var it = this.items.find(from);
    if(!this.items.remove(from))
        return;

    if(after === "prepend") {
        if(!this.items.prepend(it))
            return;
    }

    else if(after === "append") {
        if(!this.items.append(it))
            return;
    }

    else if(!this.items.insertAfter(it, after))
        return;

    callback();
}

Playlist.prototype.next = function() {
    if(!this.current)
        return;

    var it = this.current;
    this._next();

    if(it.temp) {
        var pl = this;
        this.remove(it.uid, function() {
            pl.on("remove")(it);
        });
    }

    return this.current;
}

Playlist.prototype._next = function() {
    if(!this.current)
        return;
    this.current = this.current.next;
    if(this.current === null && this.items.first !== null)
        this.current = this.items.first;

    if(this.current) {
        this.startPlayback();
    }
}

Playlist.prototype.jump = function(uid) {
    if(!this.current)
        return false;

    var jmp = this.items.find(uid);
    if(!jmp)
        return false;

    var it = this.current;

    this.current = jmp;

    if(this.current) {
        this.startPlayback();
    }

    if(it.temp) {
        this.remove(it.uid);
    }

    return this.current;
}

Playlist.prototype.clear = function() {
    this.items.clear();
    this.next_uid = 0;
    clearInterval(this._leadInterval);
}

Playlist.prototype.lead = function(lead) {
    this.leading = lead;
    var pl = this;
    if(!this.leading && this._leadInterval) {
        clearInterval(this._leadInterval);
        this._leadInterval = false;
    }
    else if(this.leading && !this._leadInterval) {
        this._leadInterval = setInterval(function() {
            pl._leadLoop();
        }, 1000);
    }
}

Playlist.prototype.startPlayback = function(time) {
    if(this.current.media === "loading") {
        setTimeout(function() {
            this.startPlayback(time);
        }.bind(this), 100);
        return;
    }
    this.current.media.paused = false;
    this.current.media.currentTime = time || -1;
    var pl = this;
    if(this.leading && !this._leadInterval && !isLive(this.current.media.type)) {
        this._lastUpdate = Date.now();
        this._leadInterval = setInterval(function() {
            pl._leadLoop();
        }, 1000);
    }
    else if(!this.leading && this._leadInterval) {
        clearInterval(this._leadInterval);
        this._leadInterval = false;
    }
    this.on("changeMedia")(this.current.media);
}

function isLive(type) {
    return type == "li" // Livestream.com
        || type == "tw" // Twitch.tv
        || type == "jt" // Justin.tv
        || type == "rt" // RTMP
        || type == "jw" // JWPlayer
        || type == "us" // Ustream.tv
        || type == "im";// Imgur album
}

const UPDATE_INTERVAL = 5;

Playlist.prototype._leadLoop = function() {
    if(this.current == null)
        return;

    this.current.media.currentTime += (Date.now() - this._lastUpdate) / 1000.0;
    this._lastUpdate = Date.now();
    this._counter++;

    if(this.current.media.currentTime >= this.current.media.seconds + 2) {
        this.next();
    }
    else if(this._counter % UPDATE_INTERVAL == 0) {
        this.on("mediaUpdate")(this.current.media);
    }
}

module.exports = Playlist;