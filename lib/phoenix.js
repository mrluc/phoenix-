(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
// Phoenix Channels JavaScript client
//
// ## Socket Connection
//
// A single connection is established to the server and
// channels are mulitplexed over the connection.
// Connect to the server using the `Socket` class:
//
//     let socket = new Socket("/ws")
//     socket.connect({userToken: "123"})
//
// The `Socket` constructor takes the mount point of the socket
// as well as options that can be found in the Socket docs,
// such as configuring the `LongPoll` transport, and heartbeat.
// Socket params can also be passed as an object literal to `connect`.
//
// ## Channels
//
// Channels are isolated, concurrent processes on the server that
// subscribe to topics and broker events between the client and server.
// To join a channel, you must provide the topic, and channel params for
// authorization. Here's an example chat room example where `"new_msg"`
// events are listened for, messages are pushed to the server, and
// the channel is joined with ok/error matches, and `after` hook:
//
//     let channel = socket.channel("rooms:123", {token: roomToken})
//     channel.on("new_msg", msg => console.log("Got message", msg) )
//     $input.onEnter( e => {
//       channel.push("new_msg", {body: e.target.val})
//        .receive("ok", (msg) => console.log("created message", msg) )
//        .receive("error", (reasons) => console.log("create failed", reasons) )
//        .after(10000, () => console.log("Networking issue. Still waiting...") )
//     })
//     channel.join()
//       .receive("ok", ({messages}) => console.log("catching up", messages) )
//       .receive("error", ({reason}) => console.log("failed join", reason) )
//       .after(10000, () => console.log("Networking issue. Still waiting...") )
//
//
// ## Joining
//
// Joining a channel with `channel.join(topic, params)`, binds the params to
// `channel.params`. Subsequent rejoins will send up the modified params for
// updating authorization params, or passing up last_message_id information.
// Successful joins receive an "ok" status, while unsuccessful joins
// receive "error".
//
//
// ## Pushing Messages
//
// From the previous example, we can see that pushing messages to the server
// can be done with `channel.push(eventName, payload)` and we can optionally
// receive responses from the push. Additionally, we can use
// `after(millsec, callback)` to abort waiting for our `receive` hooks and
// take action after some period of waiting.
//
//
// ## Socket Hooks
//
// Lifecycle events of the multiplexed connection can be hooked into via
// `socket.onError()` and `socket.onClose()` events, ie:
//
//     socket.onError( () => console.log("there was an error with the connection!") )
//     socket.onClose( () => console.log("the connection dropped") )
//
//
// ## Channel Hooks
//
// For each joined channel, you can bind to `onError` and `onClose` events
// to monitor the channel lifecycle, ie:
//
//     channel.onError( () => console.log("there was an error!") )
//     channel.onClose( () => console.log("the channel has gone away gracefully") )
//
// ### onError hooks
//
// `onError` hooks are invoked if the socket connection drops, or the channel
// crashes on the server. In either case, a channel rejoin is attemtped
// automatically in an exponential backoff manner.
//
// ### onClose hooks
//
// `onClose` hooks are invoked only in two cases. 1) the channel explicitly
// closed on the server, or 2). The client explicitly closed, by calling
// `channel.leave()`
//

"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var VSN = "1.0.0";
var SOCKET_STATES = { connecting: 0, open: 1, closing: 2, closed: 3 };
var CHANNEL_STATES = {
  closed: "closed",
  errored: "errored",
  joined: "joined",
  joining: "joining"
};
var CHANNEL_EVENTS = {
  close: "phx_close",
  error: "phx_error",
  join: "phx_join",
  reply: "phx_reply",
  leave: "phx_leave"
};
var TRANSPORTS = {
  longpoll: "longpoll",
  websocket: "websocket"
};

var Push = (function () {

  // Initializes the Push
  //
  // channel - The Channelnel
  // event - The event, for example `"phx_join"`
  // payload - The payload, for example `{user_id: 123}`
  //

  function Push(channel, event, payload) {
    _classCallCheck(this, Push);

    this.channel = channel;
    this.event = event;
    this.payload = payload || {};
    this.receivedResp = null;
    this.afterHook = null;
    this.recHooks = [];
    this.sent = false;
  }

  _createClass(Push, [{
    key: "send",
    value: function send() {
      var _this = this;

      var ref = this.channel.socket.makeRef();
      this.refEvent = this.channel.replyEventName(ref);
      this.receivedResp = null;
      this.sent = false;

      this.channel.on(this.refEvent, function (payload) {
        _this.receivedResp = payload;
        _this.matchReceive(payload);
        _this.cancelRefEvent();
        _this.cancelAfter();
      });

      this.startAfter();
      this.sent = true;
      this.channel.socket.push({
        topic: this.channel.topic,
        event: this.event,
        payload: this.payload,
        ref: ref
      });
    }
  }, {
    key: "receive",
    value: function receive(status, callback) {
      if (this.receivedResp && this.receivedResp.status === status) {
        callback(this.receivedResp.response);
      }

      this.recHooks.push({ status: status, callback: callback });
      return this;
    }
  }, {
    key: "after",
    value: function after(ms, callback) {
      if (this.afterHook) {
        throw "only a single after hook can be applied to a push";
      }
      var timer = null;
      if (this.sent) {
        timer = setTimeout(callback, ms);
      }
      this.afterHook = { ms: ms, callback: callback, timer: timer };
      return this;
    }

    // private

  }, {
    key: "matchReceive",
    value: function matchReceive(_ref) {
      var status = _ref.status;
      var response = _ref.response;
      var ref = _ref.ref;

      this.recHooks.filter(function (h) {
        return h.status === status;
      }).forEach(function (h) {
        return h.callback(response);
      });
    }
  }, {
    key: "cancelRefEvent",
    value: function cancelRefEvent() {
      this.channel.off(this.refEvent);
    }
  }, {
    key: "cancelAfter",
    value: function cancelAfter() {
      if (!this.afterHook) {
        return;
      }
      clearTimeout(this.afterHook.timer);
      this.afterHook.timer = null;
    }
  }, {
    key: "startAfter",
    value: function startAfter() {
      var _this2 = this;

      if (!this.afterHook) {
        return;
      }
      var callback = function callback() {
        _this2.cancelRefEvent();
        _this2.afterHook.callback();
      };
      this.afterHook.timer = setTimeout(callback, this.afterHook.ms);
    }
  }]);

  return Push;
})();

var Channel = (function () {
  function Channel(topic, params, socket) {
    var _this3 = this;

    _classCallCheck(this, Channel);

    this.state = CHANNEL_STATES.closed;
    this.topic = topic;
    this.params = params || {};
    this.socket = socket;
    this.bindings = [];
    this.joinedOnce = false;
    this.joinPush = new Push(this, CHANNEL_EVENTS.join, this.params);
    this.pushBuffer = [];
    this.rejoinTimer = new Timer(function () {
      return _this3.rejoinUntilConnected();
    }, this.socket.reconnectAfterMs);
    this.joinPush.receive("ok", function () {
      _this3.state = CHANNEL_STATES.joined;
      _this3.rejoinTimer.reset();
    });
    this.onClose(function () {
      _this3.socket.log("channel", "close " + _this3.topic);
      _this3.state = CHANNEL_STATES.closed;
      _this3.socket.remove(_this3);
    });
    this.onError(function (reason) {
      _this3.socket.log("channel", "error " + _this3.topic, reason);
      _this3.state = CHANNEL_STATES.errored;
      _this3.rejoinTimer.setTimeout();
    });
    this.on(CHANNEL_EVENTS.reply, function (payload, ref) {
      _this3.trigger(_this3.replyEventName(ref), payload);
    });
  }

  _createClass(Channel, [{
    key: "rejoinUntilConnected",
    value: function rejoinUntilConnected() {
      this.rejoinTimer.setTimeout();
      if (this.socket.isConnected()) {
        this.rejoin();
      }
    }
  }, {
    key: "join",
    value: function join() {
      if (this.joinedOnce) {
        throw "tried to join multiple times. 'join' can only be called a single time per channel instance";
      } else {
        this.joinedOnce = true;
      }
      this.sendJoin();
      return this.joinPush;
    }
  }, {
    key: "onClose",
    value: function onClose(callback) {
      this.on(CHANNEL_EVENTS.close, callback);
    }
  }, {
    key: "onError",
    value: function onError(callback) {
      this.on(CHANNEL_EVENTS.error, function (reason) {
        return callback(reason);
      });
    }
  }, {
    key: "on",
    value: function on(event, callback) {
      this.bindings.push({ event: event, callback: callback });
    }
  }, {
    key: "off",
    value: function off(event) {
      this.bindings = this.bindings.filter(function (bind) {
        return bind.event !== event;
      });
    }
  }, {
    key: "canPush",
    value: function canPush() {
      return this.socket.isConnected() && this.state === CHANNEL_STATES.joined;
    }
  }, {
    key: "push",
    value: function push(event, payload) {
      if (!this.joinedOnce) {
        throw "tried to push '" + event + "' to '" + this.topic + "' before joining. Use channel.join() before pushing events";
      }
      var pushEvent = new Push(this, event, payload);
      if (this.canPush()) {
        pushEvent.send();
      } else {
        this.pushBuffer.push(pushEvent);
      }

      return pushEvent;
    }

    // Leaves the channel
    //
    // Unsubscribes from server events, and
    // instructs channel to terminate on server
    //
    // Triggers onClose() hooks
    //
    // To receive leave acknowledgements, use the a `receive`
    // hook to bind to the server ack, ie:
    //
    //     channel.leave().receive("ok", () => alert("left!") )
    //
  }, {
    key: "leave",
    value: function leave() {
      var _this4 = this;

      return this.push(CHANNEL_EVENTS.leave).receive("ok", function () {
        _this4.socket.log("channel", "leave " + _this4.topic);
        _this4.trigger(CHANNEL_EVENTS.close, "leave");
      });
    }

    // Overridable message hook
    //
    // Receives all events for specialized message handling
  }, {
    key: "onMessage",
    value: function onMessage(event, payload, ref) {}

    // private

  }, {
    key: "isMember",
    value: function isMember(topic) {
      return this.topic === topic;
    }
  }, {
    key: "sendJoin",
    value: function sendJoin() {
      this.state = CHANNEL_STATES.joining;
      this.joinPush.send();
    }
  }, {
    key: "rejoin",
    value: function rejoin() {
      this.sendJoin();
      this.pushBuffer.forEach(function (pushEvent) {
        return pushEvent.send();
      });
      this.pushBuffer = [];
    }
  }, {
    key: "trigger",
    value: function trigger(triggerEvent, payload, ref) {
      this.onMessage(triggerEvent, payload, ref);
      this.bindings.filter(function (bind) {
        return bind.event === triggerEvent;
      }).map(function (bind) {
        return bind.callback(payload, ref);
      });
    }
  }, {
    key: "replyEventName",
    value: function replyEventName(ref) {
      return "chan_reply_" + ref;
    }
  }]);

  return Channel;
})();

exports.Channel = Channel;

var Socket = (function () {

  // Initializes the Socket
  //
  // endPoint - The string WebSocket endpoint, ie, "ws://example.com/ws",
  //                                               "wss://example.com"
  //                                               "/ws" (inherited host & protocol)
  // opts - Optional configuration
  //   transport - The Websocket Transport, for example WebSocket or Phoenix.LongPoll.
  //               Defaults to WebSocket with automatic LongPoll fallback.
  //   heartbeatIntervalMs - The millisec interval to send a heartbeat message
  //   reconnectAfterMs - The optional function that returns the millsec
  //                      reconnect interval. Defaults to stepped backoff of:
  //
  //     function(tries){
  //       return [1000, 5000, 10000][tries - 1] || 10000
  //     }
  //
  //   logger - The optional function for specialized logging, ie:
  //     `logger: (kind, msg, data) => { console.log(`${kind}: ${msg}`, data) }
  //
  //   longpollerTimeout - The maximum timeout of a long poll AJAX request.
  //                        Defaults to 20s (double the server long poll timer).
  //
  // For IE8 support use an ES5-shim (https://github.com/es-shims/es5-shim)
  //

  function Socket(endPoint) {
    var _this5 = this;

    var opts = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

    _classCallCheck(this, Socket);

    this.stateChangeCallbacks = { open: [], close: [], error: [], message: [] };
    this.channels = [];
    this.sendBuffer = [];
    this.ref = 0;
    this.transport = opts.transport || window.WebSocket || LongPoll;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs || 30000;
    this.reconnectAfterMs = opts.reconnectAfterMs || function (tries) {
      return [1000, 5000, 10000][tries - 1] || 10000;
    };
    this.logger = opts.logger || function () {}; // noop
    this.longpollerTimeout = opts.longpollerTimeout || 20000;
    this.params = {};
    this.reconnectTimer = new Timer(function () {
      return _this5.connect(_this5.params);
    }, this.reconnectAfterMs);
    this.endPoint = endPoint + "/" + TRANSPORTS.websocket;
  }

  _createClass(Socket, [{
    key: "protocol",
    value: function protocol() {
      return location.protocol.match(/^https/) ? "wss" : "ws";
    }
  }, {
    key: "endPointURL",
    value: function endPointURL() {
      var uri = Ajax.appendParams(Ajax.appendParams(this.endPoint, this.params), { vsn: VSN });
      if (uri.charAt(0) !== "/") {
        return uri;
      }
      if (uri.charAt(1) === "/") {
        return this.protocol() + ":" + uri;
      }

      return this.protocol() + "://" + location.host + uri;
    }
  }, {
    key: "disconnect",
    value: function disconnect(callback, code, reason) {
      if (this.conn) {
        this.conn.onclose = function () {}; // noop
        if (code) {
          this.conn.close(code, reason || "");
        } else {
          this.conn.close();
        }
        this.conn = null;
      }
      callback && callback();
    }

    // params - The params to send when connecting, for example `{user_id: userToken}`
  }, {
    key: "connect",
    value: function connect() {
      var _this6 = this;

      var params = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];
      this.params = params;
      this.disconnect(function () {
        _this6.conn = new _this6.transport(_this6.endPointURL());
        _this6.conn.timeout = _this6.longpollerTimeout;
        _this6.conn.onopen = function () {
          return _this6.onConnOpen();
        };
        _this6.conn.onerror = function (error) {
          return _this6.onConnError(error);
        };
        _this6.conn.onmessage = function (event) {
          return _this6.onConnMessage(event);
        };
        _this6.conn.onclose = function (event) {
          return _this6.onConnClose(event);
        };
      });
    }

    // Logs the message. Override `this.logger` for specialized logging. noops by default
  }, {
    key: "log",
    value: function log(kind, msg, data) {
      this.logger(kind, msg, data);
    }

    // Registers callbacks for connection state change events
    //
    // Examples
    //
    //    socket.onError(function(error){ alert("An error occurred") })
    //
  }, {
    key: "onOpen",
    value: function onOpen(callback) {
      this.stateChangeCallbacks.open.push(callback);
    }
  }, {
    key: "onClose",
    value: function onClose(callback) {
      this.stateChangeCallbacks.close.push(callback);
    }
  }, {
    key: "onError",
    value: function onError(callback) {
      this.stateChangeCallbacks.error.push(callback);
    }
  }, {
    key: "onMessage",
    value: function onMessage(callback) {
      this.stateChangeCallbacks.message.push(callback);
    }
  }, {
    key: "onConnOpen",
    value: function onConnOpen() {
      var _this7 = this;

      this.log("transport", "connected to " + this.endPointURL(), this.transport.prototype);
      this.flushSendBuffer();
      this.reconnectTimer.reset();
      if (!this.conn.skipHeartbeat) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(function () {
          return _this7.sendHeartbeat();
        }, this.heartbeatIntervalMs);
      }
      this.stateChangeCallbacks.open.forEach(function (callback) {
        return callback();
      });
    }
  }, {
    key: "onConnClose",
    value: function onConnClose(event) {
      this.log("transport", "close", event);
      this.triggerChanError();
      clearInterval(this.heartbeatTimer);
      this.reconnectTimer.setTimeout();
      this.stateChangeCallbacks.close.forEach(function (callback) {
        return callback(event);
      });
    }
  }, {
    key: "onConnError",
    value: function onConnError(error) {
      this.log("transport", error);
      this.triggerChanError();
      this.stateChangeCallbacks.error.forEach(function (callback) {
        return callback(error);
      });
    }
  }, {
    key: "triggerChanError",
    value: function triggerChanError() {
      this.channels.forEach(function (channel) {
        return channel.trigger(CHANNEL_EVENTS.error);
      });
    }
  }, {
    key: "connectionState",
    value: function connectionState() {
      switch (this.conn && this.conn.readyState) {
        case SOCKET_STATES.connecting:
          return "connecting";
        case SOCKET_STATES.open:
          return "open";
        case SOCKET_STATES.closing:
          return "closing";
        default:
          return "closed";
      }
    }
  }, {
    key: "isConnected",
    value: function isConnected() {
      return this.connectionState() === "open";
    }
  }, {
    key: "remove",
    value: function remove(channel) {
      this.channels = this.channels.filter(function (c) {
        return !c.isMember(channel.topic);
      });
    }
  }, {
    key: "channel",
    value: function channel(topic) {
      var chanParams = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

      var channel = new Channel(topic, chanParams, this);
      this.channels.push(channel);
      return channel;
    }
  }, {
    key: "push",
    value: function push(data) {
      var _this8 = this;

      var topic = data.topic;
      var event = data.event;
      var payload = data.payload;
      var ref = data.ref;

      var callback = function callback() {
        return _this8.conn.send(JSON.stringify(data));
      };
      this.log("push", topic + " " + event + " (" + ref + ")", payload);
      if (this.isConnected()) {
        callback();
      } else {
        this.sendBuffer.push(callback);
      }
    }

    // Return the next message ref, accounting for overflows
  }, {
    key: "makeRef",
    value: function makeRef() {
      var newRef = this.ref + 1;
      if (newRef === this.ref) {
        this.ref = 0;
      } else {
        this.ref = newRef;
      }

      return this.ref.toString();
    }
  }, {
    key: "sendHeartbeat",
    value: function sendHeartbeat() {
      this.push({ topic: "phoenix", event: "heartbeat", payload: {}, ref: this.makeRef() });
    }
  }, {
    key: "flushSendBuffer",
    value: function flushSendBuffer() {
      if (this.isConnected() && this.sendBuffer.length > 0) {
        this.sendBuffer.forEach(function (callback) {
          return callback();
        });
        this.sendBuffer = [];
      }
    }
  }, {
    key: "onConnMessage",
    value: function onConnMessage(rawMessage) {
      var msg = JSON.parse(rawMessage.data);
      var topic = msg.topic;
      var event = msg.event;
      var payload = msg.payload;
      var ref = msg.ref;

      this.log("receive", (payload.status || "") + " " + topic + " " + event + " " + (ref && "(" + ref + ")" || ""), payload);
      this.channels.filter(function (channel) {
        return channel.isMember(topic);
      }).forEach(function (channel) {
        return channel.trigger(event, payload, ref);
      });
      this.stateChangeCallbacks.message.forEach(function (callback) {
        return callback(msg);
      });
    }
  }]);

  return Socket;
})();

exports.Socket = Socket;

var LongPoll = (function () {
  function LongPoll(endPoint) {
    _classCallCheck(this, LongPoll);

    this.endPoint = null;
    this.token = null;
    this.skipHeartbeat = true;
    this.onopen = function () {}; // noop
    this.onerror = function () {}; // noop
    this.onmessage = function () {}; // noop
    this.onclose = function () {}; // noop
    this.pollEndpoint = this.normalizeEndpoint(endPoint);
    this.readyState = SOCKET_STATES.connecting;

    this.poll();
  }

  _createClass(LongPoll, [{
    key: "normalizeEndpoint",
    value: function normalizeEndpoint(endPoint) {
      return endPoint.replace("ws://", "http://").replace("wss://", "https://").replace(new RegExp("(.*)\/" + TRANSPORTS.websocket), "$1/" + TRANSPORTS.longpoll);
    }
  }, {
    key: "endpointURL",
    value: function endpointURL() {
      return Ajax.appendParams(this.pollEndpoint, { token: this.token });
    }
  }, {
    key: "closeAndRetry",
    value: function closeAndRetry() {
      this.close();
      this.readyState = SOCKET_STATES.connecting;
    }
  }, {
    key: "ontimeout",
    value: function ontimeout() {
      this.onerror("timeout");
      this.closeAndRetry();
    }
  }, {
    key: "poll",
    value: function poll() {
      var _this9 = this;

      if (!(this.readyState === SOCKET_STATES.open || this.readyState === SOCKET_STATES.connecting)) {
        return;
      }

      Ajax.request("GET", this.endpointURL(), "application/json", null, this.timeout, this.ontimeout.bind(this), function (resp) {
        if (resp) {
          var status = resp.status;
          var token = resp.token;
          var messages = resp.messages;

          _this9.token = token;
        } else {
          var status = 0;
        }

        switch (status) {
          case 200:
            messages.forEach(function (msg) {
              return _this9.onmessage({ data: JSON.stringify(msg) });
            });
            _this9.poll();
            break;
          case 204:
            _this9.poll();
            break;
          case 410:
            _this9.readyState = SOCKET_STATES.open;
            _this9.onopen();
            _this9.poll();
            break;
          case 0:
          case 500:
            _this9.onerror();
            _this9.closeAndRetry();
            break;
          default:
            throw "unhandled poll status " + status;
        }
      });
    }
  }, {
    key: "send",
    value: function send(body) {
      var _this10 = this;

      Ajax.request("POST", this.endpointURL(), "application/json", body, this.timeout, this.onerror.bind(this, "timeout"), function (resp) {
        if (!resp || resp.status !== 200) {
          _this10.onerror(status);
          _this10.closeAndRetry();
        }
      });
    }
  }, {
    key: "close",
    value: function close(code, reason) {
      this.readyState = SOCKET_STATES.closed;
      this.onclose();
    }
  }]);

  return LongPoll;
})();

exports.LongPoll = LongPoll;

var Ajax = (function () {
  function Ajax() {
    _classCallCheck(this, Ajax);
  }

  _createClass(Ajax, null, [{
    key: "request",
    value: function request(method, endPoint, accept, body, timeout, ontimeout, callback) {
      if (window.XDomainRequest) {
        var req = new XDomainRequest(); // IE8, IE9
        this.xdomainRequest(req, method, endPoint, body, timeout, ontimeout, callback);
      } else {
        var req = window.XMLHttpRequest ? new XMLHttpRequest() : // IE7+, Firefox, Chrome, Opera, Safari
        new ActiveXObject("Microsoft.XMLHTTP"); // IE6, IE5
        this.xhrRequest(req, method, endPoint, accept, body, timeout, ontimeout, callback);
      }
    }
  }, {
    key: "xdomainRequest",
    value: function xdomainRequest(req, method, endPoint, body, timeout, ontimeout, callback) {
      var _this11 = this;

      req.timeout = timeout;
      req.open(method, endPoint);
      req.onload = function () {
        var response = _this11.parseJSON(req.responseText);
        callback && callback(response);
      };
      if (ontimeout) {
        req.ontimeout = ontimeout;
      }

      // Work around bug in IE9 that requires an attached onprogress handler
      req.onprogress = function () {};

      req.send(body);
    }
  }, {
    key: "xhrRequest",
    value: function xhrRequest(req, method, endPoint, accept, body, timeout, ontimeout, callback) {
      var _this12 = this;

      req.timeout = timeout;
      req.open(method, endPoint, true);
      req.setRequestHeader("Content-Type", accept);
      req.onerror = function () {
        callback && callback(null);
      };
      req.onreadystatechange = function () {
        if (req.readyState === _this12.states.complete && callback) {
          var response = _this12.parseJSON(req.responseText);
          callback(response);
        }
      };
      if (ontimeout) {
        req.ontimeout = ontimeout;
      }

      req.send(body);
    }
  }, {
    key: "parseJSON",
    value: function parseJSON(resp) {
      return resp && resp !== "" ? JSON.parse(resp) : null;
    }
  }, {
    key: "serialize",
    value: function serialize(obj, parentKey) {
      var queryStr = [];
      for (var key in obj) {
        if (!obj.hasOwnProperty(key)) {
          continue;
        }
        var paramKey = parentKey ? parentKey + "[" + key + "]" : key;
        var paramVal = obj[key];
        if (typeof paramVal === "object") {
          queryStr.push(this.serialize(paramVal, paramKey));
        } else {
          queryStr.push(encodeURIComponent(paramKey) + "=" + encodeURIComponent(paramVal));
        }
      }
      return queryStr.join("&");
    }
  }, {
    key: "appendParams",
    value: function appendParams(url, params) {
      if (Object.keys(params).length === 0) {
        return url;
      }

      var prefix = url.match(/\?/) ? "&" : "?";
      return "" + url + prefix + this.serialize(params);
    }
  }]);

  return Ajax;
})();

exports.Ajax = Ajax;

Ajax.states = { complete: 4 };

// Creates a timer that accepts a `timerCalc` function to perform
// calculated timeout retries, such as exponential backoff.
//
// ## Examples
//
//    let reconnectTimer = new Timer(() => this.connect(), function(tries){
//      return [1000, 5000, 10000][tries - 1] || 10000
//    })
//    reconnectTimer.setTimeout() // fires after 1000
//    reconnectTimer.setTimeout() // fires after 5000
//    reconnectTimer.reset()
//    reconnectTimer.setTimeout() // fires after 1000
//

var Timer = (function () {
  function Timer(callback, timerCalc) {
    _classCallCheck(this, Timer);

    this.callback = callback;
    this.timerCalc = timerCalc;
    this.timer = null;
    this.tries = 0;
  }

  _createClass(Timer, [{
    key: "reset",
    value: function reset() {
      this.tries = 0;
      clearTimeout(this.timer);
    }

    // Cancels any previous setTimeout and schedules callback
  }, {
    key: "setTimeout",
    value: (function (_setTimeout) {
      function setTimeout() {
        return _setTimeout.apply(this, arguments);
      }

      setTimeout.toString = function () {
        return _setTimeout.toString();
      };

      return setTimeout;
    })(function () {
      var _this13 = this;

      clearTimeout(this.timer);

      this.timer = setTimeout(function () {
        _this13.tries = _this13.tries + 1;
        _this13.callback();
      }, this.timerCalc(this.tries + 1));
    })
  }]);

  return Timer;
})();

},{}]},{},[1])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIvVXNlcnMvbXJsdWMvcHJvamVjdHMvbWluZS9lbGl4aXIvcGhvZW5peC1qcy1kZXJwL3NyYy9waG9lbml4LmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQ3VGQSxJQUFNLEdBQUcsR0FBRyxPQUFPLENBQUE7QUFDbkIsSUFBTSxhQUFhLEdBQUcsRUFBQyxVQUFVLEVBQUUsQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLEVBQUUsT0FBTyxFQUFFLENBQUMsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFDLENBQUE7QUFDckUsSUFBTSxjQUFjLEdBQUc7QUFDckIsUUFBTSxFQUFFLFFBQVE7QUFDaEIsU0FBTyxFQUFFLFNBQVM7QUFDbEIsUUFBTSxFQUFFLFFBQVE7QUFDaEIsU0FBTyxFQUFFLFNBQVM7Q0FDbkIsQ0FBQTtBQUNELElBQU0sY0FBYyxHQUFHO0FBQ3JCLE9BQUssRUFBRSxXQUFXO0FBQ2xCLE9BQUssRUFBRSxXQUFXO0FBQ2xCLE1BQUksRUFBRSxVQUFVO0FBQ2hCLE9BQUssRUFBRSxXQUFXO0FBQ2xCLE9BQUssRUFBRSxXQUFXO0NBQ25CLENBQUE7QUFDRCxJQUFNLFVBQVUsR0FBRztBQUNqQixVQUFRLEVBQUUsVUFBVTtBQUNwQixXQUFTLEVBQUUsV0FBVztDQUN2QixDQUFBOztJQUVLLElBQUk7Ozs7Ozs7OztBQVFHLFdBUlAsSUFBSSxDQVFJLE9BQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFDOzBCQVJoQyxJQUFJOztBQVNOLFFBQUksQ0FBQyxPQUFPLEdBQVEsT0FBTyxDQUFBO0FBQzNCLFFBQUksQ0FBQyxLQUFLLEdBQVUsS0FBSyxDQUFB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Q25DOzs7U0FyQkcsS0FBSyIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCIvLyBQaG9lbml4IENoYW5uZWxzIEphdmFTY3JpcHQgY2xpZW50XG4vL1xuLy8gIyMgU29ja2V0IENvbm5lY3Rpb25cbi8vXG4vLyBBIHNpbmdsZSBjb25uZWN0aW9uIGlzIGVzdGFibGlzaGVkIHRvIHRoZSBzZXJ2ZXIgYW5kXG4vLyBjaGFubmVscyBhcmUgbXVsaXRwbGV4ZWQgb3ZlciB0aGUgY29ubmVjdGlvbi5cbi8vIENvbm5lY3QgdG8gdGhlIHNlcnZlciB1c2luZyB0aGUgYFNvY2tldGAgY2xhc3M6XG4vL1xuLy8gICAgIGxldCBzb2NrZXQgPSBuZXcgU29ja2V0KFwiL3dzXCIpXG4vLyAgICAgc29ja2V0LmNvbm5lY3Qoe3VzZXJUb2tlbjogXCIxMjNcIn0pXG4vL1xuLy8gVGhlIGBTb2NrZXRgIGNvbnN0cnVjdG9yIHRha2VzIHRoZSBtb3VudCBwb2ludCBvZiB0aGUgc29ja2V0XG4vLyBhcyB3ZWxsIGFzIG9wdGlvbnMgdGhhdCBjYW4gYmUgZm91bmQgaW4gdGhlIFNvY2tldCBkb2NzLFxuLy8gc3VjaCBhcyBjb25maWd1cmluZyB0aGUgYExvbmdQb2xsYCB0cmFuc3BvcnQsIGFuZCBoZWFydGJlYXQuXG4vLyBTb2NrZXQgcGFyYW1zIGNhbiBhbHNvIGJlIHBhc3NlZCBhcyBhbiBvYmplY3QgbGl0ZXJhbCB0byBgY29ubmVjdGAuXG4vL1xuLy8gIyMgQ2hhbm5lbHNcbi8vXG4vLyBDaGFubmVscyBhcmUgaXNvbGF0ZWQsIGNvbmN1cnJlbnQgcHJvY2Vzc2VzIG9uIHRoZSBzZXJ2ZXIgdGhhdFxuLy8gc3Vic2NyaWJlIHRvIHRvcGljcyBhbmQgYnJva2VyIGV2ZW50cyBiZXR3ZWVuIHRoZSBjbGllbnQgYW5kIHNlcnZlci5cbi8vIFRvIGpvaW4gYSBjaGFubmVsLCB5b3UgbXVzdCBwcm92aWRlIHRoZSB0b3BpYywgYW5kIGNoYW5uZWwgcGFyYW1zIGZvclxuLy8gYXV0aG9yaXphdGlvbi4gSGVyZSdzIGFuIGV4YW1wbGUgY2hhdCByb29tIGV4YW1wbGUgd2hlcmUgYFwibmV3X21zZ1wiYFxuLy8gZXZlbnRzIGFyZSBsaXN0ZW5lZCBmb3IsIG1lc3NhZ2VzIGFyZSBwdXNoZWQgdG8gdGhlIHNlcnZlciwgYW5kXG4vLyB0aGUgY2hhbm5lbCBpcyBqb2luZWQgd2l0aCBvay9lcnJvciBtYXRjaGVzLCBhbmQgYGFmdGVyYCBob29rOlxuLy9cbi8vICAgICBsZXQgY2hhbm5lbCA9IHNvY2tldC5jaGFubmVsKFwicm9vbXM6MTIzXCIsIHt0b2tlbjogcm9vbVRva2VufSlcbi8vICAgICBjaGFubmVsLm9uKFwibmV3X21zZ1wiLCBtc2cgPT4gY29uc29sZS5sb2coXCJHb3QgbWVzc2FnZVwiLCBtc2cpIClcbi8vICAgICAkaW5wdXQub25FbnRlciggZSA9PiB7XG4vLyAgICAgICBjaGFubmVsLnB1c2goXCJuZXdfbXNnXCIsIHtib2R5OiBlLnRhcmdldC52YWx9KVxuLy8gICAgICAgIC5yZWNlaXZlKFwib2tcIiwgKG1zZykgPT4gY29uc29sZS5sb2coXCJjcmVhdGVkIG1lc3NhZ2VcIiwgbXNnKSApXG4vLyAgICAgICAgLnJlY2VpdmUoXCJlcnJvclwiLCAocmVhc29ucykgPT4gY29uc29sZS5sb2coXCJjcmVhdGUgZmFpbGVkXCIsIHJlYXNvbnMpIClcbi8vICAgICAgICAuYWZ0ZXIoMTAwMDAsICgpID0+IGNvbnNvbGUubG9nKFwiTmV0d29ya2luZyBpc3N1ZS4gU3RpbGwgd2FpdGluZy4uLlwiKSApXG4vLyAgICAgfSlcbi8vICAgICBjaGFubmVsLmpvaW4oKVxuLy8gICAgICAgLnJlY2VpdmUoXCJva1wiLCAoe21lc3NhZ2VzfSkgPT4gY29uc29sZS5sb2coXCJjYXRjaGluZyB1cFwiLCBtZXNzYWdlcykgKVxuLy8gICAgICAgLnJlY2VpdmUoXCJlcnJvclwiLCAoe3JlYXNvbn0pID0+IGNvbnNvbGUubG9nKFwiZmFpbGVkIGpvaW5cIiwgcmVhc29uKSApXG4vLyAgICAgICAuYWZ0ZXIoMTAwMDAsICgpID0+IGNvbnNvbGUubG9nKFwiTmV0d29ya2luZyBpc3N1ZS4gU3RpbGwgd2FpdGluZy4uLlwiKSApXG4vL1xuLy9cbi8vICMjIEpvaW5pbmdcbi8vXG4vLyBKb2luaW5nIGEgY2hhbm5lbCB3aXRoIGBjaGFubmVsLmpvaW4odG9waWMsIHBhcmFtcylgLCBiaW5kcyB0aGUgcGFyYW1zIHRvXG4vLyBgY2hhbm5lbC5wYXJhbXNgLiBTdWJzZXF1ZW50IHJlam9pbnMgd2lsbCBzZW5kIHVwIHRoZSBtb2RpZmllZCBwYXJhbXMgZm9yXG4vLyB1cGRhdGluZyBhdXRob3JpemF0aW9uIHBhcmFtcywgb3IgcGFzc2luZyB1cCBsYXN0X21lc3NhZ2VfaWQgaW5mb3JtYXRpb24uXG4vLyBTdWNjZXNzZnVsIGpvaW5zIHJlY2VpdmUgYW4gXCJva1wiIHN0YXR1cywgd2hpbGUgdW5zdWNjZXNzZnVsIGpvaW5zXG4vLyByZWNlaXZlIFwiZXJyb3JcIi5cbi8vXG4vL1xuLy8gIyMgUHVzaGluZyBNZXNzYWdlc1xuLy9cbi8vIEZyb20gdGhlIHByZXZpb3VzIGV4YW1wbGUsIHdlIGNhbiBzZWUgdGhhdCBwdXNoaW5nIG1lc3NhZ2VzIHRvIHRoZSBzZXJ2ZXJcbi8vIGNhbiBiZSBkb25lIHdpdGggYGNoYW5uZWwucHVzaChldmVudE5hbWUsIHBheWxvYWQpYCBhbmQgd2UgY2FuIG9wdGlvbmFsbHlcbi8vIHJlY2VpdmUgcmVzcG9uc2VzIGZyb20gdGhlIHB1c2guIEFkZGl0aW9uYWxseSwgd2UgY2FuIHVzZVxuLy8gYGFmdGVyKG1pbGxzZWMsIGNhbGxiYWNrKWAgdG8gYWJvcnQgd2FpdGluZyBmb3Igb3VyIGByZWNlaXZlYCBob29rcyBhbmRcbi8vIHRha2UgYWN0aW9uIGFmdGVyIHNvbWUgcGVyaW9kIG9mIHdhaXRpbmcuXG4vL1xuLy9cbi8vICMjIFNvY2tldCBIb29rc1xuLy9cbi8vIExpZmVjeWNsZSBldmVudHMgb2YgdGhlIG11bHRpcGxleGVkIGNvbm5lY3Rpb24gY2FuIGJlIGhvb2tlZCBpbnRvIHZpYVxuLy8gYHNvY2tldC5vbkVycm9yKClgIGFuZCBgc29ja2V0Lm9uQ2xvc2UoKWAgZXZlbnRzLCBpZTpcbi8vXG4vLyAgICAgc29ja2V0Lm9uRXJyb3IoICgpID0+IGNvbnNvbGUubG9nKFwidGhlcmUgd2FzIGFuIGVycm9yIHdpdGggdGhlIGNvbm5lY3Rpb24hXCIpIClcbi8vICAgICBzb2NrZXQub25DbG9zZSggKCkgPT4gY29uc29sZS5sb2coXCJ0aGUgY29ubmVjdGlvbiBkcm9wcGVkXCIpIClcbi8vXG4vL1xuLy8gIyMgQ2hhbm5lbCBIb29rc1xuLy9cbi8vIEZvciBlYWNoIGpvaW5lZCBjaGFubmVsLCB5b3UgY2FuIGJpbmQgdG8gYG9uRXJyb3JgIGFuZCBgb25DbG9zZWAgZXZlbnRzXG4vLyB0byBtb25pdG9yIHRoZSBjaGFubmVsIGxpZmVjeWNsZSwgaWU6XG4vL1xuLy8gICAgIGNoYW5uZWwub25FcnJvciggKCkgPT4gY29uc29sZS5sb2coXCJ0aGVyZSB3YXMgYW4gZXJyb3IhXCIpIClcbi8vICAgICBjaGFubmVsLm9uQ2xvc2UoICgpID0+IGNvbnNvbGUubG9nKFwidGhlIGNoYW5uZWwgaGFzIGdvbmUgYXdheSBncmFjZWZ1bGx5XCIpIClcbi8vXG4vLyAjIyMgb25FcnJvciBob29rc1xuLy9cbi8vIGBvbkVycm9yYCBob29rcyBhcmUgaW52b2tlZCBpZiB0aGUgc29ja2V0IGNvbm5lY3Rpb24gZHJvcHMsIG9yIHRoZSBjaGFubmVsXG4vLyBjcmFzaGVzIG9uIHRoZSBzZXJ2ZXIuIEluIGVpdGhlciBjYXNlLCBhIGNoYW5uZWwgcmVqb2luIGlzIGF0dGVtdHBlZFxuLy8gYXV0b21hdGljYWxseSBpbiBhbiBleHBvbmVudGlhbCBiYWNrb2ZmIG1hbm5lci5cbi8vXG4vLyAjIyMgb25DbG9zZSBob29rc1xuLy9cbi8vIGBvbkNsb3NlYCBob29rcyBhcmUgaW52b2tlZCBvbmx5IGluIHR3byBjYXNlcy4gMSkgdGhlIGNoYW5uZWwgZXhwbGljaXRseVxuLy8gY2xvc2VkIG9uIHRoZSBzZXJ2ZXIsIG9yIDIpLiBUaGUgY2xpZW50IGV4cGxpY2l0bHkgY2xvc2VkLCBieSBjYWxsaW5nXG4vLyBgY2hhbm5lbC5sZWF2ZSgpYFxuLy9cblxuY29uc3QgVlNOID0gXCIxLjAuMFwiXG5jb25zdCBTT0NLRVRfU1RBVEVTID0ge2Nvbm5lY3Rpbmc6IDAsIG9wZW46IDEsIGNsb3Npbmc6IDIsIGNsb3NlZDogM31cbmNvbnN0IENIQU5ORUxfU1RBVEVTID0ge1xuICBjbG9zZWQ6IFwiY2xvc2VkXCIsXG4gIGVycm9yZWQ6IFwiZXJyb3JlZFwiLFxuICBqb2luZWQ6IFwiam9pbmVkXCIsXG4gIGpvaW5pbmc6IFwiam9pbmluZ1wiLFxufVxuY29uc3QgQ0hBTk5FTF9FVkVOVFMgPSB7XG4gIGNsb3NlOiBcInBoeF9jbG9zZVwiLFxuICBlcnJvcjogXCJwaHhfZXJyb3JcIixcbiAgam9pbjogXCJwaHhfam9pblwiLFxuICByZXBseTogXCJwaHhfcmVwbHlcIixcbiAgbGVhdmU6IFwicGh4X2xlYXZlXCJcbn1cbmNvbnN0IFRSQU5TUE9SVFMgPSB7XG4gIGxvbmdwb2xsOiBcImxvbmdwb2xsXCIsXG4gIHdlYnNvY2tldDogXCJ3ZWJzb2NrZXRcIlxufVxuXG5jbGFzcyBQdXNoIHtcblxuICAvLyBJbml0aWFsaXplcyB0aGUgUHVzaFxuICAvL1xuICAvLyBjaGFubmVsIC0gVGhlIENoYW5uZWxuZWxcbiAgLy8gZXZlbnQgLSBUaGUgZXZlbnQsIGZvciBleGFtcGxlIGBcInBoeF9qb2luXCJgXG4gIC8vIHBheWxvYWQgLSBUaGUgcGF5bG9hZCwgZm9yIGV4YW1wbGUgYHt1c2VyX2lkOiAxMjN9YFxuICAvL1xuICBjb25zdHJ1Y3RvcihjaGFubmVsLCBldmVudCwgcGF5bG9hZCl7XG4gICAgdGhpcy5jaGFubmVsICAgICAgPSBjaGFubmVsXG4gICAgdGhpcy5ldmVudCAgICAgICAgPSBldmVudFxuICAgIHRoaXMucGF5bG9hZCAgICAgID0gcGF5bG9hZCB8fCB7fVxuICAgIHRoaXMucmVjZWl2ZWRSZXNwID0gbnVsbFxuICAgIHRoaXMuYWZ0ZXJIb29rICAgID0gbnVsbFxuICAgIHRoaXMucmVjSG9va3MgICAgID0gW11cbiAgICB0aGlzLnNlbnQgICAgICAgICA9IGZhbHNlXG4gIH1cblxuICBzZW5kKCl7XG4gICAgY29uc3QgcmVmICAgICAgICAgPSB0aGlzLmNoYW5uZWwuc29ja2V0Lm1ha2VSZWYoKVxuICAgIHRoaXMucmVmRXZlbnQgICAgID0gdGhpcy5jaGFubmVsLnJlcGx5RXZlbnROYW1lKHJlZilcbiAgICB0aGlzLnJlY2VpdmVkUmVzcCA9IG51bGxcbiAgICB0aGlzLnNlbnQgICAgICAgICA9IGZhbHNlXG5cbiAgICB0aGlzLmNoYW5uZWwub24odGhpcy5yZWZFdmVudCwgcGF5bG9hZCA9PiB7XG4gICAgICB0aGlzLnJlY2VpdmVkUmVzcCA9IHBheWxvYWRcbiAgICAgIHRoaXMubWF0Y2hSZWNlaXZlKHBheWxvYWQpXG4gICAgICB0aGlzLmNhbmNlbFJlZkV2ZW50KClcbiAgICAgIHRoaXMuY2FuY2VsQWZ0ZXIoKVxuICAgIH0pXG5cbiAgICB0aGlzLnN0YXJ0QWZ0ZXIoKVxuICAgIHRoaXMuc2VudCA9IHRydWVcbiAgICB0aGlzLmNoYW5uZWwuc29ja2V0LnB1c2goe1xuICAgICAgdG9waWM6IHRoaXMuY2hhbm5lbC50b3BpYyxcbiAgICAgIGV2ZW50OiB0aGlzLmV2ZW50LFxuICAgICAgcGF5bG9hZDogdGhpcy5wYXlsb2FkLFxuICAgICAgcmVmOiByZWZcbiAgICB9KVxuICB9XG5cbiAgcmVjZWl2ZShzdGF0dXMsIGNhbGxiYWNrKXtcbiAgICBpZih0aGlzLnJlY2VpdmVkUmVzcCAmJiB0aGlzLnJlY2VpdmVkUmVzcC5zdGF0dXMgPT09IHN0YXR1cyl7XG4gICAgICBjYWxsYmFjayh0aGlzLnJlY2VpdmVkUmVzcC5yZXNwb25zZSlcbiAgICB9XG5cbiAgICB0aGlzLnJlY0hvb2tzLnB1c2goe3N0YXR1cywgY2FsbGJhY2t9KVxuICAgIHJldHVybiB0aGlzXG4gIH1cblxuICBhZnRlcihtcywgY2FsbGJhY2spe1xuICAgIGlmKHRoaXMuYWZ0ZXJIb29rKXsgdGhyb3coYG9ubHkgYSBzaW5nbGUgYWZ0ZXIgaG9vayBjYW4gYmUgYXBwbGllZCB0byBhIHB1c2hgKSB9XG4gICAgbGV0IHRpbWVyID0gbnVsbFxuICAgIGlmKHRoaXMuc2VudCl7IHRpbWVyID0gc2V0VGltZW91dChjYWxsYmFjaywgbXMpIH1cbiAgICB0aGlzLmFmdGVySG9vayA9IHttczogbXMsIGNhbGxiYWNrOiBjYWxsYmFjaywgdGltZXI6IHRpbWVyfVxuICAgIHJldHVybiB0aGlzXG4gIH1cblxuXG4gIC8vIHByaXZhdGVcblxuICBtYXRjaFJlY2VpdmUoe3N0YXR1cywgcmVzcG9uc2UsIHJlZn0pe1xuICAgIHRoaXMucmVjSG9va3MuZmlsdGVyKCBoID0+IGguc3RhdHVzID09PSBzdGF0dXMgKVxuICAgICAgICAgICAgICAgICAuZm9yRWFjaCggaCA9PiBoLmNhbGxiYWNrKHJlc3BvbnNlKSApXG4gIH1cblxuICBjYW5jZWxSZWZFdmVudCgpeyB0aGlzLmNoYW5uZWwub2ZmKHRoaXMucmVmRXZlbnQpIH1cblxuICBjYW5jZWxBZnRlcigpeyBpZighdGhpcy5hZnRlckhvb2speyByZXR1cm4gfVxuICAgIGNsZWFyVGltZW91dCh0aGlzLmFmdGVySG9vay50aW1lcilcbiAgICB0aGlzLmFmdGVySG9vay50aW1lciA9IG51bGxcbiAgfVxuXG4gIHN0YXJ0QWZ0ZXIoKXsgaWYoIXRoaXMuYWZ0ZXJIb29rKXsgcmV0dXJuIH1cbiAgICBsZXQgY2FsbGJhY2sgPSAoKSA9PiB7XG4gICAgICB0aGlzLmNhbmNlbFJlZkV2ZW50KClcbiAgICAgIHRoaXMuYWZ0ZXJIb29rLmNhbGxiYWNrKClcbiAgICB9XG4gICAgdGhpcy5hZnRlckhvb2sudGltZXIgPSBzZXRUaW1lb3V0KGNhbGxiYWNrLCB0aGlzLmFmdGVySG9vay5tcylcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgQ2hhbm5lbCB7XG4gIGNvbnN0cnVjdG9yKHRvcGljLCBwYXJhbXMsIHNvY2tldCkge1xuICAgIHRoaXMuc3RhdGUgICAgICAgPSBDSEFOTkVMX1NUQVRFUy5jbG9zZWRcbiAgICB0aGlzLnRvcGljICAgICAgID0gdG9waWNcbiAgICB0aGlzLnBhcmFtcyAgICAgID0gcGFyYW1zIHx8IHt9XG4gICAgdGhpcy5zb2NrZXQgICAgICA9IHNvY2tldFxuICAgIHRoaXMuYmluZGluZ3MgICAgPSBbXVxuICAgIHRoaXMuam9pbmVkT25jZSAgPSBmYWxzZVxuICAgIHRoaXMuam9pblB1c2ggICAgPSBuZXcgUHVzaCh0aGlzLCBDSEFOTkVMX0VWRU5UUy5qb2luLCB0aGlzLnBhcmFtcylcbiAgICB0aGlzLnB1c2hCdWZmZXIgID0gW11cbiAgICB0aGlzLnJlam9pblRpbWVyICA9IG5ldyBUaW1lcihcbiAgICAgICgpID0+IHRoaXMucmVqb2luVW50aWxDb25uZWN0ZWQoKSxcbiAgICAgIHRoaXMuc29ja2V0LnJlY29ubmVjdEFmdGVyTXNcbiAgICApXG4gICAgdGhpcy5qb2luUHVzaC5yZWNlaXZlKFwib2tcIiwgKCkgPT4ge1xuICAgICAgdGhpcy5zdGF0ZSA9IENIQU5ORUxfU1RBVEVTLmpvaW5lZFxuICAgICAgdGhpcy5yZWpvaW5UaW1lci5yZXNldCgpXG4gICAgfSlcbiAgICB0aGlzLm9uQ2xvc2UoICgpID0+IHtcbiAgICAgIHRoaXMuc29ja2V0LmxvZyhcImNoYW5uZWxcIiwgYGNsb3NlICR7dGhpcy50b3BpY31gKVxuICAgICAgdGhpcy5zdGF0ZSA9IENIQU5ORUxfU1RBVEVTLmNsb3NlZFxuICAgICAgdGhpcy5zb2NrZXQucmVtb3ZlKHRoaXMpXG4gICAgfSlcbiAgICB0aGlzLm9uRXJyb3IoIHJlYXNvbiA9PiB7XG4gICAgICB0aGlzLnNvY2tldC5sb2coXCJjaGFubmVsXCIsIGBlcnJvciAke3RoaXMudG9waWN9YCwgcmVhc29uKVxuICAgICAgdGhpcy5zdGF0ZSA9IENIQU5ORUxfU1RBVEVTLmVycm9yZWRcbiAgICAgIHRoaXMucmVqb2luVGltZXIuc2V0VGltZW91dCgpXG4gICAgfSlcbiAgICB0aGlzLm9uKENIQU5ORUxfRVZFTlRTLnJlcGx5LCAocGF5bG9hZCwgcmVmKSA9PiB7XG4gICAgICB0aGlzLnRyaWdnZXIodGhpcy5yZXBseUV2ZW50TmFtZShyZWYpLCBwYXlsb2FkKVxuICAgIH0pXG4gIH1cblxuICByZWpvaW5VbnRpbENvbm5lY3RlZCgpe1xuICAgIHRoaXMucmVqb2luVGltZXIuc2V0VGltZW91dCgpXG4gICAgaWYodGhpcy5zb2NrZXQuaXNDb25uZWN0ZWQoKSl7XG4gICAgICB0aGlzLnJlam9pbigpXG4gICAgfVxuICB9XG5cbiAgam9pbigpe1xuICAgIGlmKHRoaXMuam9pbmVkT25jZSl7XG4gICAgICB0aHJvdyhgdHJpZWQgdG8gam9pbiBtdWx0aXBsZSB0aW1lcy4gJ2pvaW4nIGNhbiBvbmx5IGJlIGNhbGxlZCBhIHNpbmdsZSB0aW1lIHBlciBjaGFubmVsIGluc3RhbmNlYClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5qb2luZWRPbmNlID0gdHJ1ZVxuICAgIH1cbiAgICB0aGlzLnNlbmRKb2luKClcbiAgICByZXR1cm4gdGhpcy5qb2luUHVzaFxuICB9XG5cbiAgb25DbG9zZShjYWxsYmFjayl7IHRoaXMub24oQ0hBTk5FTF9FVkVOVFMuY2xvc2UsIGNhbGxiYWNrKSB9XG5cbiAgb25FcnJvcihjYWxsYmFjayl7XG4gICAgdGhpcy5vbihDSEFOTkVMX0VWRU5UUy5lcnJvciwgcmVhc29uID0+IGNhbGxiYWNrKHJlYXNvbikgKVxuICB9XG5cbiAgb24oZXZlbnQsIGNhbGxiYWNrKXsgdGhpcy5iaW5kaW5ncy5wdXNoKHtldmVudCwgY2FsbGJhY2t9KSB9XG5cbiAgb2ZmKGV2ZW50KXsgdGhpcy5iaW5kaW5ncyA9IHRoaXMuYmluZGluZ3MuZmlsdGVyKCBiaW5kID0+IGJpbmQuZXZlbnQgIT09IGV2ZW50ICkgfVxuXG4gIGNhblB1c2goKXsgcmV0dXJuIHRoaXMuc29ja2V0LmlzQ29ubmVjdGVkKCkgJiYgdGhpcy5zdGF0ZSA9PT0gQ0hBTk5FTF9TVEFURVMuam9pbmVkIH1cblxuICBwdXNoKGV2ZW50LCBwYXlsb2FkKXtcbiAgICBpZighdGhpcy5qb2luZWRPbmNlKXtcbiAgICAgIHRocm93KGB0cmllZCB0byBwdXNoICcke2V2ZW50fScgdG8gJyR7dGhpcy50b3BpY30nIGJlZm9yZSBqb2luaW5nLiBVc2UgY2hhbm5lbC5qb2luKCkgYmVmb3JlIHB1c2hpbmcgZXZlbnRzYClcbiAgICB9XG4gICAgbGV0IHB1c2hFdmVudCA9IG5ldyBQdXNoKHRoaXMsIGV2ZW50LCBwYXlsb2FkKVxuICAgIGlmKHRoaXMuY2FuUHVzaCgpKXtcbiAgICAgIHB1c2hFdmVudC5zZW5kKClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5wdXNoQnVmZmVyLnB1c2gocHVzaEV2ZW50KVxuICAgIH1cblxuICAgIHJldHVybiBwdXNoRXZlbnRcbiAgfVxuXG4gIC8vIExlYXZlcyB0aGUgY2hhbm5lbFxuICAvL1xuICAvLyBVbnN1YnNjcmliZXMgZnJvbSBzZXJ2ZXIgZXZlbnRzLCBhbmRcbiAgLy8gaW5zdHJ1Y3RzIGNoYW5uZWwgdG8gdGVybWluYXRlIG9uIHNlcnZlclxuICAvL1xuICAvLyBUcmlnZ2VycyBvbkNsb3NlKCkgaG9va3NcbiAgLy9cbiAgLy8gVG8gcmVjZWl2ZSBsZWF2ZSBhY2tub3dsZWRnZW1lbnRzLCB1c2UgdGhlIGEgYHJlY2VpdmVgXG4gIC8vIGhvb2sgdG8gYmluZCB0byB0aGUgc2VydmVyIGFjaywgaWU6XG4gIC8vXG4gIC8vICAgICBjaGFubmVsLmxlYXZlKCkucmVjZWl2ZShcIm9rXCIsICgpID0+IGFsZXJ0KFwibGVmdCFcIikgKVxuICAvL1xuICBsZWF2ZSgpe1xuICAgIHJldHVybiB0aGlzLnB1c2goQ0hBTk5FTF9FVkVOVFMubGVhdmUpLnJlY2VpdmUoXCJva1wiLCAoKSA9PiB7XG4gICAgICB0aGlzLnNvY2tldC5sb2coXCJjaGFubmVsXCIsIGBsZWF2ZSAke3RoaXMudG9waWN9YClcbiAgICAgIHRoaXMudHJpZ2dlcihDSEFOTkVMX0VWRU5UUy5jbG9zZSwgXCJsZWF2ZVwiKVxuICAgIH0pXG4gIH1cblxuICAvLyBPdmVycmlkYWJsZSBtZXNzYWdlIGhvb2tcbiAgLy9cbiAgLy8gUmVjZWl2ZXMgYWxsIGV2ZW50cyBmb3Igc3BlY2lhbGl6ZWQgbWVzc2FnZSBoYW5kbGluZ1xuICBvbk1lc3NhZ2UoZXZlbnQsIHBheWxvYWQsIHJlZil7fVxuXG4gIC8vIHByaXZhdGVcblxuICBpc01lbWJlcih0b3BpYyl7IHJldHVybiB0aGlzLnRvcGljID09PSB0b3BpYyB9XG5cbiAgc2VuZEpvaW4oKXtcbiAgICB0aGlzLnN0YXRlID0gQ0hBTk5FTF9TVEFURVMuam9pbmluZ1xuICAgIHRoaXMuam9pblB1c2guc2VuZCgpXG4gIH1cblxuICByZWpvaW4oKXtcbiAgICB0aGlzLnNlbmRKb2luKClcbiAgICB0aGlzLnB1c2hCdWZmZXIuZm9yRWFjaCggcHVzaEV2ZW50ID0+IHB1c2hFdmVudC5zZW5kKCkgKVxuICAgIHRoaXMucHVzaEJ1ZmZlciA9IFtdXG4gIH1cblxuICB0cmlnZ2VyKHRyaWdnZXJFdmVudCwgcGF5bG9hZCwgcmVmKXtcbiAgICB0aGlzLm9uTWVzc2FnZSh0cmlnZ2VyRXZlbnQsIHBheWxvYWQsIHJlZilcbiAgICB0aGlzLmJpbmRpbmdzLmZpbHRlciggYmluZCA9PiBiaW5kLmV2ZW50ID09PSB0cmlnZ2VyRXZlbnQgKVxuICAgICAgICAgICAgICAgICAubWFwKCBiaW5kID0+IGJpbmQuY2FsbGJhY2socGF5bG9hZCwgcmVmKSApXG4gIH1cblxuICByZXBseUV2ZW50TmFtZShyZWYpeyByZXR1cm4gYGNoYW5fcmVwbHlfJHtyZWZ9YCB9XG59XG5cbmV4cG9ydCBjbGFzcyBTb2NrZXQge1xuXG4gIC8vIEluaXRpYWxpemVzIHRoZSBTb2NrZXRcbiAgLy9cbiAgLy8gZW5kUG9pbnQgLSBUaGUgc3RyaW5nIFdlYlNvY2tldCBlbmRwb2ludCwgaWUsIFwid3M6Ly9leGFtcGxlLmNvbS93c1wiLFxuICAvLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJ3c3M6Ly9leGFtcGxlLmNvbVwiXG4gIC8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIi93c1wiIChpbmhlcml0ZWQgaG9zdCAmIHByb3RvY29sKVxuICAvLyBvcHRzIC0gT3B0aW9uYWwgY29uZmlndXJhdGlvblxuICAvLyAgIHRyYW5zcG9ydCAtIFRoZSBXZWJzb2NrZXQgVHJhbnNwb3J0LCBmb3IgZXhhbXBsZSBXZWJTb2NrZXQgb3IgUGhvZW5peC5Mb25nUG9sbC5cbiAgLy8gICAgICAgICAgICAgICBEZWZhdWx0cyB0byBXZWJTb2NrZXQgd2l0aCBhdXRvbWF0aWMgTG9uZ1BvbGwgZmFsbGJhY2suXG4gIC8vICAgaGVhcnRiZWF0SW50ZXJ2YWxNcyAtIFRoZSBtaWxsaXNlYyBpbnRlcnZhbCB0byBzZW5kIGEgaGVhcnRiZWF0IG1lc3NhZ2VcbiAgLy8gICByZWNvbm5lY3RBZnRlck1zIC0gVGhlIG9wdGlvbmFsIGZ1bmN0aW9uIHRoYXQgcmV0dXJucyB0aGUgbWlsbHNlY1xuICAvLyAgICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3QgaW50ZXJ2YWwuIERlZmF1bHRzIHRvIHN0ZXBwZWQgYmFja29mZiBvZjpcbiAgLy9cbiAgLy8gICAgIGZ1bmN0aW9uKHRyaWVzKXtcbiAgLy8gICAgICAgcmV0dXJuIFsxMDAwLCA1MDAwLCAxMDAwMF1bdHJpZXMgLSAxXSB8fCAxMDAwMFxuICAvLyAgICAgfVxuICAvL1xuICAvLyAgIGxvZ2dlciAtIFRoZSBvcHRpb25hbCBmdW5jdGlvbiBmb3Igc3BlY2lhbGl6ZWQgbG9nZ2luZywgaWU6XG4gIC8vICAgICBgbG9nZ2VyOiAoa2luZCwgbXNnLCBkYXRhKSA9PiB7IGNvbnNvbGUubG9nKGAke2tpbmR9OiAke21zZ31gLCBkYXRhKSB9XG4gIC8vXG4gIC8vICAgbG9uZ3BvbGxlclRpbWVvdXQgLSBUaGUgbWF4aW11bSB0aW1lb3V0IG9mIGEgbG9uZyBwb2xsIEFKQVggcmVxdWVzdC5cbiAgLy8gICAgICAgICAgICAgICAgICAgICAgICBEZWZhdWx0cyB0byAyMHMgKGRvdWJsZSB0aGUgc2VydmVyIGxvbmcgcG9sbCB0aW1lcikuXG4gIC8vXG4gIC8vIEZvciBJRTggc3VwcG9ydCB1c2UgYW4gRVM1LXNoaW0gKGh0dHBzOi8vZ2l0aHViLmNvbS9lcy1zaGltcy9lczUtc2hpbSlcbiAgLy9cbiAgY29uc3RydWN0b3IoZW5kUG9pbnQsIG9wdHMgPSB7fSl7XG4gICAgdGhpcy5zdGF0ZUNoYW5nZUNhbGxiYWNrcyA9IHtvcGVuOiBbXSwgY2xvc2U6IFtdLCBlcnJvcjogW10sIG1lc3NhZ2U6IFtdfVxuICAgIHRoaXMuY2hhbm5lbHMgICAgICAgICAgICAgPSBbXVxuICAgIHRoaXMuc2VuZEJ1ZmZlciAgICAgICAgICAgPSBbXVxuICAgIHRoaXMucmVmICAgICAgICAgICAgICAgICAgPSAwXG4gICAgdGhpcy50cmFuc3BvcnQgICAgICAgICAgICA9IG9wdHMudHJhbnNwb3J0IHx8IHdpbmRvdy5XZWJTb2NrZXQgfHwgTG9uZ1BvbGxcbiAgICB0aGlzLmhlYXJ0YmVhdEludGVydmFsTXMgID0gb3B0cy5oZWFydGJlYXRJbnRlcnZhbE1zIHx8IDMwMDAwXG4gICAgdGhpcy5yZWNvbm5lY3RBZnRlck1zICAgICA9IG9wdHMucmVjb25uZWN0QWZ0ZXJNcyB8fCBmdW5jdGlvbih0cmllcyl7XG4gICAgICByZXR1cm4gWzEwMDAsIDUwMDAsIDEwMDAwXVt0cmllcyAtIDFdIHx8IDEwMDAwXG4gICAgfVxuICAgIHRoaXMubG9nZ2VyICAgICAgICAgICAgICAgPSBvcHRzLmxvZ2dlciB8fCBmdW5jdGlvbigpe30gLy8gbm9vcFxuICAgIHRoaXMubG9uZ3BvbGxlclRpbWVvdXQgICAgPSBvcHRzLmxvbmdwb2xsZXJUaW1lb3V0IHx8IDIwMDAwXG4gICAgdGhpcy5wYXJhbXMgICAgICAgICAgICAgICA9IHt9XG4gICAgdGhpcy5yZWNvbm5lY3RUaW1lciAgICAgICA9IG5ldyBUaW1lcigoKSA9PiB0aGlzLmNvbm5lY3QodGhpcy5wYXJhbXMpLCB0aGlzLnJlY29ubmVjdEFmdGVyTXMpXG4gICAgdGhpcy5lbmRQb2ludCAgICAgICAgICAgICA9IGAke2VuZFBvaW50fS8ke1RSQU5TUE9SVFMud2Vic29ja2V0fWBcbiAgfVxuXG4gIHByb3RvY29sKCl7IHJldHVybiBsb2NhdGlvbi5wcm90b2NvbC5tYXRjaCgvXmh0dHBzLykgPyBcIndzc1wiIDogXCJ3c1wiIH1cblxuICBlbmRQb2ludFVSTCgpe1xuICAgIGxldCB1cmkgPSBBamF4LmFwcGVuZFBhcmFtcyhcbiAgICAgIEFqYXguYXBwZW5kUGFyYW1zKHRoaXMuZW5kUG9pbnQsIHRoaXMucGFyYW1zKSwge3ZzbjogVlNOfSlcbiAgICBpZih1cmkuY2hhckF0KDApICE9PSBcIi9cIil7IHJldHVybiB1cmkgfVxuICAgIGlmKHVyaS5jaGFyQXQoMSkgPT09IFwiL1wiKXsgcmV0dXJuIGAke3RoaXMucHJvdG9jb2woKX06JHt1cml9YCB9XG5cbiAgICByZXR1cm4gYCR7dGhpcy5wcm90b2NvbCgpfTovLyR7bG9jYXRpb24uaG9zdH0ke3VyaX1gXG4gIH1cblxuICBkaXNjb25uZWN0KGNhbGxiYWNrLCBjb2RlLCByZWFzb24pe1xuICAgIGlmKHRoaXMuY29ubil7XG4gICAgICB0aGlzLmNvbm4ub25jbG9zZSA9IGZ1bmN0aW9uKCl7fSAvLyBub29wXG4gICAgICBpZihjb2RlKXsgdGhpcy5jb25uLmNsb3NlKGNvZGUsIHJlYXNvbiB8fCBcIlwiKSB9IGVsc2UgeyB0aGlzLmNvbm4uY2xvc2UoKSB9XG4gICAgICB0aGlzLmNvbm4gPSBudWxsXG4gICAgfVxuICAgIGNhbGxiYWNrICYmIGNhbGxiYWNrKClcbiAgfVxuXG4gIC8vIHBhcmFtcyAtIFRoZSBwYXJhbXMgdG8gc2VuZCB3aGVuIGNvbm5lY3RpbmcsIGZvciBleGFtcGxlIGB7dXNlcl9pZDogdXNlclRva2VufWBcbiAgY29ubmVjdChwYXJhbXMgPSB7fSl7IHRoaXMucGFyYW1zID0gcGFyYW1zXG4gICAgdGhpcy5kaXNjb25uZWN0KCgpID0+IHtcbiAgICAgIHRoaXMuY29ubiA9IG5ldyB0aGlzLnRyYW5zcG9ydCh0aGlzLmVuZFBvaW50VVJMKCkpXG4gICAgICB0aGlzLmNvbm4udGltZW91dCAgID0gdGhpcy5sb25ncG9sbGVyVGltZW91dFxuICAgICAgdGhpcy5jb25uLm9ub3BlbiAgICA9ICgpID0+IHRoaXMub25Db25uT3BlbigpXG4gICAgICB0aGlzLmNvbm4ub25lcnJvciAgID0gZXJyb3IgPT4gdGhpcy5vbkNvbm5FcnJvcihlcnJvcilcbiAgICAgIHRoaXMuY29ubi5vbm1lc3NhZ2UgPSBldmVudCA9PiB0aGlzLm9uQ29ubk1lc3NhZ2UoZXZlbnQpXG4gICAgICB0aGlzLmNvbm4ub25jbG9zZSAgID0gZXZlbnQgPT4gdGhpcy5vbkNvbm5DbG9zZShldmVudClcbiAgICB9KVxuICB9XG5cbiAgLy8gTG9ncyB0aGUgbWVzc2FnZS4gT3ZlcnJpZGUgYHRoaXMubG9nZ2VyYCBmb3Igc3BlY2lhbGl6ZWQgbG9nZ2luZy4gbm9vcHMgYnkgZGVmYXVsdFxuICBsb2coa2luZCwgbXNnLCBkYXRhKXsgdGhpcy5sb2dnZXIoa2luZCwgbXNnLCBkYXRhKSB9XG5cbiAgLy8gUmVnaXN0ZXJzIGNhbGxiYWNrcyBmb3IgY29ubmVjdGlvbiBzdGF0ZSBjaGFuZ2UgZXZlbnRzXG4gIC8vXG4gIC8vIEV4YW1wbGVzXG4gIC8vXG4gIC8vICAgIHNvY2tldC5vbkVycm9yKGZ1bmN0aW9uKGVycm9yKXsgYWxlcnQoXCJBbiBlcnJvciBvY2N1cnJlZFwiKSB9KVxuICAvL1xuICBvbk9wZW4gICAgIChjYWxsYmFjayl7IHRoaXMuc3RhdGVDaGFuZ2VDYWxsYmFja3Mub3Blbi5wdXNoKGNhbGxiYWNrKSB9XG4gIG9uQ2xvc2UgICAgKGNhbGxiYWNrKXsgdGhpcy5zdGF0ZUNoYW5nZUNhbGxiYWNrcy5jbG9zZS5wdXNoKGNhbGxiYWNrKSB9XG4gIG9uRXJyb3IgICAgKGNhbGxiYWNrKXsgdGhpcy5zdGF0ZUNoYW5nZUNhbGxiYWNrcy5lcnJvci5wdXNoKGNhbGxiYWNrKSB9XG4gIG9uTWVzc2FnZSAgKGNhbGxiYWNrKXsgdGhpcy5zdGF0ZUNoYW5nZUNhbGxiYWNrcy5tZXNzYWdlLnB1c2goY2FsbGJhY2spIH1cblxuICBvbkNvbm5PcGVuKCl7XG4gICAgdGhpcy5sb2coXCJ0cmFuc3BvcnRcIiwgYGNvbm5lY3RlZCB0byAke3RoaXMuZW5kUG9pbnRVUkwoKX1gLCB0aGlzLnRyYW5zcG9ydC5wcm90b3R5cGUpXG4gICAgdGhpcy5mbHVzaFNlbmRCdWZmZXIoKVxuICAgIHRoaXMucmVjb25uZWN0VGltZXIucmVzZXQoKVxuICAgIGlmKCF0aGlzLmNvbm4uc2tpcEhlYXJ0YmVhdCl7XG4gICAgICBjbGVhckludGVydmFsKHRoaXMuaGVhcnRiZWF0VGltZXIpXG4gICAgICB0aGlzLmhlYXJ0YmVhdFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4gdGhpcy5zZW5kSGVhcnRiZWF0KCksIHRoaXMuaGVhcnRiZWF0SW50ZXJ2YWxNcylcbiAgICB9XG4gICAgdGhpcy5zdGF0ZUNoYW5nZUNhbGxiYWNrcy5vcGVuLmZvckVhY2goIGNhbGxiYWNrID0+IGNhbGxiYWNrKCkgKVxuICB9XG5cbiAgb25Db25uQ2xvc2UoZXZlbnQpe1xuICAgIHRoaXMubG9nKFwidHJhbnNwb3J0XCIsIFwiY2xvc2VcIiwgZXZlbnQpXG4gICAgdGhpcy50cmlnZ2VyQ2hhbkVycm9yKClcbiAgICBjbGVhckludGVydmFsKHRoaXMuaGVhcnRiZWF0VGltZXIpXG4gICAgdGhpcy5yZWNvbm5lY3RUaW1lci5zZXRUaW1lb3V0KClcbiAgICB0aGlzLnN0YXRlQ2hhbmdlQ2FsbGJhY2tzLmNsb3NlLmZvckVhY2goIGNhbGxiYWNrID0+IGNhbGxiYWNrKGV2ZW50KSApXG4gIH1cblxuICBvbkNvbm5FcnJvcihlcnJvcil7XG4gICAgdGhpcy5sb2coXCJ0cmFuc3BvcnRcIiwgZXJyb3IpXG4gICAgdGhpcy50cmlnZ2VyQ2hhbkVycm9yKClcbiAgICB0aGlzLnN0YXRlQ2hhbmdlQ2FsbGJhY2tzLmVycm9yLmZvckVhY2goIGNhbGxiYWNrID0+IGNhbGxiYWNrKGVycm9yKSApXG4gIH1cblxuICB0cmlnZ2VyQ2hhbkVycm9yKCl7XG4gICAgdGhpcy5jaGFubmVscy5mb3JFYWNoKCBjaGFubmVsID0+IGNoYW5uZWwudHJpZ2dlcihDSEFOTkVMX0VWRU5UUy5lcnJvcikgKVxuICB9XG5cbiAgY29ubmVjdGlvblN0YXRlKCl7XG4gICAgc3dpdGNoKHRoaXMuY29ubiAmJiB0aGlzLmNvbm4ucmVhZHlTdGF0ZSl7XG4gICAgICBjYXNlIFNPQ0tFVF9TVEFURVMuY29ubmVjdGluZzogcmV0dXJuIFwiY29ubmVjdGluZ1wiXG4gICAgICBjYXNlIFNPQ0tFVF9TVEFURVMub3BlbjogICAgICAgcmV0dXJuIFwib3BlblwiXG4gICAgICBjYXNlIFNPQ0tFVF9TVEFURVMuY2xvc2luZzogICAgcmV0dXJuIFwiY2xvc2luZ1wiXG4gICAgICBkZWZhdWx0OiAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIFwiY2xvc2VkXCJcbiAgICB9XG4gIH1cblxuICBpc0Nvbm5lY3RlZCgpeyByZXR1cm4gdGhpcy5jb25uZWN0aW9uU3RhdGUoKSA9PT0gXCJvcGVuXCIgfVxuXG4gIHJlbW92ZShjaGFubmVsKXtcbiAgICB0aGlzLmNoYW5uZWxzID0gdGhpcy5jaGFubmVscy5maWx0ZXIoIGMgPT4gIWMuaXNNZW1iZXIoY2hhbm5lbC50b3BpYykgKVxuICB9XG5cbiAgY2hhbm5lbCh0b3BpYywgY2hhblBhcmFtcyA9IHt9KXtcbiAgICBsZXQgY2hhbm5lbCA9IG5ldyBDaGFubmVsKHRvcGljLCBjaGFuUGFyYW1zLCB0aGlzKVxuICAgIHRoaXMuY2hhbm5lbHMucHVzaChjaGFubmVsKVxuICAgIHJldHVybiBjaGFubmVsXG4gIH1cblxuICBwdXNoKGRhdGEpe1xuICAgIGxldCB7dG9waWMsIGV2ZW50LCBwYXlsb2FkLCByZWZ9ID0gZGF0YVxuICAgIGxldCBjYWxsYmFjayA9ICgpID0+IHRoaXMuY29ubi5zZW5kKEpTT04uc3RyaW5naWZ5KGRhdGEpKVxuICAgIHRoaXMubG9nKFwicHVzaFwiLCBgJHt0b3BpY30gJHtldmVudH0gKCR7cmVmfSlgLCBwYXlsb2FkKVxuICAgIGlmKHRoaXMuaXNDb25uZWN0ZWQoKSl7XG4gICAgICBjYWxsYmFjaygpXG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgdGhpcy5zZW5kQnVmZmVyLnB1c2goY2FsbGJhY2spXG4gICAgfVxuICB9XG5cbiAgLy8gUmV0dXJuIHRoZSBuZXh0IG1lc3NhZ2UgcmVmLCBhY2NvdW50aW5nIGZvciBvdmVyZmxvd3NcbiAgbWFrZVJlZigpe1xuICAgIGxldCBuZXdSZWYgPSB0aGlzLnJlZiArIDFcbiAgICBpZihuZXdSZWYgPT09IHRoaXMucmVmKXsgdGhpcy5yZWYgPSAwIH0gZWxzZSB7IHRoaXMucmVmID0gbmV3UmVmIH1cblxuICAgIHJldHVybiB0aGlzLnJlZi50b1N0cmluZygpXG4gIH1cblxuICBzZW5kSGVhcnRiZWF0KCl7XG4gICAgdGhpcy5wdXNoKHt0b3BpYzogXCJwaG9lbml4XCIsIGV2ZW50OiBcImhlYXJ0YmVhdFwiLCBwYXlsb2FkOiB7fSwgcmVmOiB0aGlzLm1ha2VSZWYoKX0pXG4gIH1cblxuICBmbHVzaFNlbmRCdWZmZXIoKXtcbiAgICBpZih0aGlzLmlzQ29ubmVjdGVkKCkgJiYgdGhpcy5zZW5kQnVmZmVyLmxlbmd0aCA+IDApe1xuICAgICAgdGhpcy5zZW5kQnVmZmVyLmZvckVhY2goIGNhbGxiYWNrID0+IGNhbGxiYWNrKCkgKVxuICAgICAgdGhpcy5zZW5kQnVmZmVyID0gW11cbiAgICB9XG4gIH1cblxuICBvbkNvbm5NZXNzYWdlKHJhd01lc3NhZ2Upe1xuICAgIGxldCBtc2cgPSBKU09OLnBhcnNlKHJhd01lc3NhZ2UuZGF0YSlcbiAgICBsZXQge3RvcGljLCBldmVudCwgcGF5bG9hZCwgcmVmfSA9IG1zZ1xuICAgIHRoaXMubG9nKFwicmVjZWl2ZVwiLCBgJHtwYXlsb2FkLnN0YXR1cyB8fCBcIlwifSAke3RvcGljfSAke2V2ZW50fSAke3JlZiAmJiBcIihcIiArIHJlZiArIFwiKVwiIHx8IFwiXCJ9YCwgcGF5bG9hZClcbiAgICB0aGlzLmNoYW5uZWxzLmZpbHRlciggY2hhbm5lbCA9PiBjaGFubmVsLmlzTWVtYmVyKHRvcGljKSApXG4gICAgICAgICAgICAgICAgIC5mb3JFYWNoKCBjaGFubmVsID0+IGNoYW5uZWwudHJpZ2dlcihldmVudCwgcGF5bG9hZCwgcmVmKSApXG4gICAgdGhpcy5zdGF0ZUNoYW5nZUNhbGxiYWNrcy5tZXNzYWdlLmZvckVhY2goIGNhbGxiYWNrID0+IGNhbGxiYWNrKG1zZykgKVxuICB9XG59XG5cblxuZXhwb3J0IGNsYXNzIExvbmdQb2xsIHtcblxuICBjb25zdHJ1Y3RvcihlbmRQb2ludCl7XG4gICAgdGhpcy5lbmRQb2ludCAgICAgICAgPSBudWxsXG4gICAgdGhpcy50b2tlbiAgICAgICAgICAgPSBudWxsXG4gICAgdGhpcy5za2lwSGVhcnRiZWF0ICAgPSB0cnVlXG4gICAgdGhpcy5vbm9wZW4gICAgICAgICAgPSBmdW5jdGlvbigpe30gLy8gbm9vcFxuICAgIHRoaXMub25lcnJvciAgICAgICAgID0gZnVuY3Rpb24oKXt9IC8vIG5vb3BcbiAgICB0aGlzLm9ubWVzc2FnZSAgICAgICA9IGZ1bmN0aW9uKCl7fSAvLyBub29wXG4gICAgdGhpcy5vbmNsb3NlICAgICAgICAgPSBmdW5jdGlvbigpe30gLy8gbm9vcFxuICAgIHRoaXMucG9sbEVuZHBvaW50ICAgID0gdGhpcy5ub3JtYWxpemVFbmRwb2ludChlbmRQb2ludClcbiAgICB0aGlzLnJlYWR5U3RhdGUgICAgICA9IFNPQ0tFVF9TVEFURVMuY29ubmVjdGluZ1xuXG4gICAgdGhpcy5wb2xsKClcbiAgfVxuXG4gIG5vcm1hbGl6ZUVuZHBvaW50KGVuZFBvaW50KXtcbiAgICByZXR1cm4oZW5kUG9pbnRcbiAgICAgIC5yZXBsYWNlKFwid3M6Ly9cIiwgXCJodHRwOi8vXCIpXG4gICAgICAucmVwbGFjZShcIndzczovL1wiLCBcImh0dHBzOi8vXCIpXG4gICAgICAucmVwbGFjZShuZXcgUmVnRXhwKFwiKC4qKVxcL1wiICsgVFJBTlNQT1JUUy53ZWJzb2NrZXQpLCBcIiQxL1wiICsgVFJBTlNQT1JUUy5sb25ncG9sbCkpXG4gIH1cblxuICBlbmRwb2ludFVSTCgpe1xuICAgIHJldHVybiBBamF4LmFwcGVuZFBhcmFtcyh0aGlzLnBvbGxFbmRwb2ludCwge3Rva2VuOiB0aGlzLnRva2VufSlcbiAgfVxuXG4gIGNsb3NlQW5kUmV0cnkoKXtcbiAgICB0aGlzLmNsb3NlKClcbiAgICB0aGlzLnJlYWR5U3RhdGUgPSBTT0NLRVRfU1RBVEVTLmNvbm5lY3RpbmdcbiAgfVxuXG4gIG9udGltZW91dCgpe1xuICAgIHRoaXMub25lcnJvcihcInRpbWVvdXRcIilcbiAgICB0aGlzLmNsb3NlQW5kUmV0cnkoKVxuICB9XG5cbiAgcG9sbCgpe1xuICAgIGlmKCEodGhpcy5yZWFkeVN0YXRlID09PSBTT0NLRVRfU1RBVEVTLm9wZW4gfHwgdGhpcy5yZWFkeVN0YXRlID09PSBTT0NLRVRfU1RBVEVTLmNvbm5lY3RpbmcpKXsgcmV0dXJuIH1cblxuICAgIEFqYXgucmVxdWVzdChcIkdFVFwiLCB0aGlzLmVuZHBvaW50VVJMKCksIFwiYXBwbGljYXRpb24vanNvblwiLCBudWxsLCB0aGlzLnRpbWVvdXQsIHRoaXMub250aW1lb3V0LmJpbmQodGhpcyksIChyZXNwKSA9PiB7XG4gICAgICBpZihyZXNwKXtcbiAgICAgICAgdmFyIHtzdGF0dXMsIHRva2VuLCBtZXNzYWdlc30gPSByZXNwXG4gICAgICAgIHRoaXMudG9rZW4gPSB0b2tlblxuICAgICAgfSBlbHNle1xuICAgICAgICB2YXIgc3RhdHVzID0gMFxuICAgICAgfVxuXG4gICAgICBzd2l0Y2goc3RhdHVzKXtcbiAgICAgICAgY2FzZSAyMDA6XG4gICAgICAgICAgbWVzc2FnZXMuZm9yRWFjaCggbXNnID0+IHRoaXMub25tZXNzYWdlKHtkYXRhOiBKU09OLnN0cmluZ2lmeShtc2cpfSkgKVxuICAgICAgICAgIHRoaXMucG9sbCgpXG4gICAgICAgICAgYnJlYWtcbiAgICAgICAgY2FzZSAyMDQ6XG4gICAgICAgICAgdGhpcy5wb2xsKClcbiAgICAgICAgICBicmVha1xuICAgICAgICBjYXNlIDQxMDpcbiAgICAgICAgICB0aGlzLnJlYWR5U3RhdGUgPSBTT0NLRVRfU1RBVEVTLm9wZW5cbiAgICAgICAgICB0aGlzLm9ub3BlbigpXG4gICAgICAgICAgdGhpcy5wb2xsKClcbiAgICAgICAgICBicmVha1xuICAgICAgICBjYXNlIDA6XG4gICAgICAgIGNhc2UgNTAwOlxuICAgICAgICAgIHRoaXMub25lcnJvcigpXG4gICAgICAgICAgdGhpcy5jbG9zZUFuZFJldHJ5KClcbiAgICAgICAgICBicmVha1xuICAgICAgICBkZWZhdWx0OiB0aHJvdyhgdW5oYW5kbGVkIHBvbGwgc3RhdHVzICR7c3RhdHVzfWApXG4gICAgICB9XG4gICAgfSlcbiAgfVxuXG4gIHNlbmQoYm9keSl7XG4gICAgQWpheC5yZXF1ZXN0KFwiUE9TVFwiLCB0aGlzLmVuZHBvaW50VVJMKCksIFwiYXBwbGljYXRpb24vanNvblwiLCBib2R5LCB0aGlzLnRpbWVvdXQsIHRoaXMub25lcnJvci5iaW5kKHRoaXMsIFwidGltZW91dFwiKSwgKHJlc3ApID0+IHtcbiAgICAgIGlmKCFyZXNwIHx8IHJlc3Auc3RhdHVzICE9PSAyMDApe1xuICAgICAgICB0aGlzLm9uZXJyb3Ioc3RhdHVzKVxuICAgICAgICB0aGlzLmNsb3NlQW5kUmV0cnkoKVxuICAgICAgfVxuICAgIH0pXG4gIH1cblxuICBjbG9zZShjb2RlLCByZWFzb24pe1xuICAgIHRoaXMucmVhZHlTdGF0ZSA9IFNPQ0tFVF9TVEFURVMuY2xvc2VkXG4gICAgdGhpcy5vbmNsb3NlKClcbiAgfVxufVxuXG5cbmV4cG9ydCBjbGFzcyBBamF4IHtcblxuICBzdGF0aWMgcmVxdWVzdChtZXRob2QsIGVuZFBvaW50LCBhY2NlcHQsIGJvZHksIHRpbWVvdXQsIG9udGltZW91dCwgY2FsbGJhY2spe1xuICAgIGlmKHdpbmRvdy5YRG9tYWluUmVxdWVzdCl7XG4gICAgICBsZXQgcmVxID0gbmV3IFhEb21haW5SZXF1ZXN0KCkgLy8gSUU4LCBJRTlcbiAgICAgIHRoaXMueGRvbWFpblJlcXVlc3QocmVxLCBtZXRob2QsIGVuZFBvaW50LCBib2R5LCB0aW1lb3V0LCBvbnRpbWVvdXQsIGNhbGxiYWNrKVxuICAgIH0gZWxzZSB7XG4gICAgICBsZXQgcmVxID0gd2luZG93LlhNTEh0dHBSZXF1ZXN0ID9cbiAgICAgICAgICAgICAgICAgIG5ldyBYTUxIdHRwUmVxdWVzdCgpIDogLy8gSUU3KywgRmlyZWZveCwgQ2hyb21lLCBPcGVyYSwgU2FmYXJpXG4gICAgICAgICAgICAgICAgICBuZXcgQWN0aXZlWE9iamVjdChcIk1pY3Jvc29mdC5YTUxIVFRQXCIpIC8vIElFNiwgSUU1XG4gICAgICB0aGlzLnhoclJlcXVlc3QocmVxLCBtZXRob2QsIGVuZFBvaW50LCBhY2NlcHQsIGJvZHksIHRpbWVvdXQsIG9udGltZW91dCwgY2FsbGJhY2spXG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHhkb21haW5SZXF1ZXN0KHJlcSwgbWV0aG9kLCBlbmRQb2ludCwgYm9keSwgdGltZW91dCwgb250aW1lb3V0LCBjYWxsYmFjayl7XG4gICAgcmVxLnRpbWVvdXQgPSB0aW1lb3V0XG4gICAgcmVxLm9wZW4obWV0aG9kLCBlbmRQb2ludClcbiAgICByZXEub25sb2FkID0gKCkgPT4ge1xuICAgICAgbGV0IHJlc3BvbnNlID0gdGhpcy5wYXJzZUpTT04ocmVxLnJlc3BvbnNlVGV4dClcbiAgICAgIGNhbGxiYWNrICYmIGNhbGxiYWNrKHJlc3BvbnNlKVxuICAgIH1cbiAgICBpZihvbnRpbWVvdXQpeyByZXEub250aW1lb3V0ID0gb250aW1lb3V0IH1cblxuICAgIC8vIFdvcmsgYXJvdW5kIGJ1ZyBpbiBJRTkgdGhhdCByZXF1aXJlcyBhbiBhdHRhY2hlZCBvbnByb2dyZXNzIGhhbmRsZXJcbiAgICByZXEub25wcm9ncmVzcyA9ICgpID0+IHt9XG5cbiAgICByZXEuc2VuZChib2R5KVxuICB9XG5cbiAgc3RhdGljIHhoclJlcXVlc3QocmVxLCBtZXRob2QsIGVuZFBvaW50LCBhY2NlcHQsIGJvZHksIHRpbWVvdXQsIG9udGltZW91dCwgY2FsbGJhY2spe1xuICAgIHJlcS50aW1lb3V0ID0gdGltZW91dFxuICAgIHJlcS5vcGVuKG1ldGhvZCwgZW5kUG9pbnQsIHRydWUpXG4gICAgcmVxLnNldFJlcXVlc3RIZWFkZXIoXCJDb250ZW50LVR5cGVcIiwgYWNjZXB0KVxuICAgIHJlcS5vbmVycm9yID0gKCkgPT4geyBjYWxsYmFjayAmJiBjYWxsYmFjayhudWxsKSB9XG4gICAgcmVxLm9ucmVhZHlzdGF0ZWNoYW5nZSA9ICgpID0+IHtcbiAgICAgIGlmKHJlcS5yZWFkeVN0YXRlID09PSB0aGlzLnN0YXRlcy5jb21wbGV0ZSAmJiBjYWxsYmFjayl7XG4gICAgICAgIGxldCByZXNwb25zZSA9IHRoaXMucGFyc2VKU09OKHJlcS5yZXNwb25zZVRleHQpXG4gICAgICAgIGNhbGxiYWNrKHJlc3BvbnNlKVxuICAgICAgfVxuICAgIH1cbiAgICBpZihvbnRpbWVvdXQpeyByZXEub250aW1lb3V0ID0gb250aW1lb3V0IH1cblxuICAgIHJlcS5zZW5kKGJvZHkpXG4gIH1cblxuICBzdGF0aWMgcGFyc2VKU09OKHJlc3Ape1xuICAgIHJldHVybiAocmVzcCAmJiByZXNwICE9PSBcIlwiKSA/XG4gICAgICAgICAgICAgSlNPTi5wYXJzZShyZXNwKSA6XG4gICAgICAgICAgICAgbnVsbFxuICB9XG5cbiAgc3RhdGljIHNlcmlhbGl6ZShvYmosIHBhcmVudEtleSl7XG4gICAgbGV0IHF1ZXJ5U3RyID0gW107XG4gICAgZm9yKHZhciBrZXkgaW4gb2JqKXsgaWYoIW9iai5oYXNPd25Qcm9wZXJ0eShrZXkpKXsgY29udGludWUgfVxuICAgICAgbGV0IHBhcmFtS2V5ID0gcGFyZW50S2V5ID8gYCR7cGFyZW50S2V5fVske2tleX1dYCA6IGtleVxuICAgICAgbGV0IHBhcmFtVmFsID0gb2JqW2tleV1cbiAgICAgIGlmKHR5cGVvZiBwYXJhbVZhbCA9PT0gXCJvYmplY3RcIil7XG4gICAgICAgIHF1ZXJ5U3RyLnB1c2godGhpcy5zZXJpYWxpemUocGFyYW1WYWwsIHBhcmFtS2V5KSlcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHF1ZXJ5U3RyLnB1c2goZW5jb2RlVVJJQ29tcG9uZW50KHBhcmFtS2V5KSArIFwiPVwiICsgZW5jb2RlVVJJQ29tcG9uZW50KHBhcmFtVmFsKSlcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHF1ZXJ5U3RyLmpvaW4oXCImXCIpXG4gIH1cblxuICBzdGF0aWMgYXBwZW5kUGFyYW1zKHVybCwgcGFyYW1zKXtcbiAgICBpZihPYmplY3Qua2V5cyhwYXJhbXMpLmxlbmd0aCA9PT0gMCl7IHJldHVybiB1cmwgfVxuXG4gICAgbGV0IHByZWZpeCA9IHVybC5tYXRjaCgvXFw/LykgPyBcIiZcIiA6IFwiP1wiXG4gICAgcmV0dXJuIGAke3VybH0ke3ByZWZpeH0ke3RoaXMuc2VyaWFsaXplKHBhcmFtcyl9YFxuICB9XG59XG5cbkFqYXguc3RhdGVzID0ge2NvbXBsZXRlOiA0fVxuXG5cbi8vIENyZWF0ZXMgYSB0aW1lciB0aGF0IGFjY2VwdHMgYSBgdGltZXJDYWxjYCBmdW5jdGlvbiB0byBwZXJmb3JtXG4vLyBjYWxjdWxhdGVkIHRpbWVvdXQgcmV0cmllcywgc3VjaCBhcyBleHBvbmVudGlhbCBiYWNrb2ZmLlxuLy9cbi8vICMjIEV4YW1wbGVzXG4vL1xuLy8gICAgbGV0IHJlY29ubmVjdFRpbWVyID0gbmV3IFRpbWVyKCgpID0+IHRoaXMuY29ubmVjdCgpLCBmdW5jdGlvbih0cmllcyl7XG4vLyAgICAgIHJldHVybiBbMTAwMCwgNTAwMCwgMTAwMDBdW3RyaWVzIC0gMV0gfHwgMTAwMDBcbi8vICAgIH0pXG4vLyAgICByZWNvbm5lY3RUaW1lci5zZXRUaW1lb3V0KCkgLy8gZmlyZXMgYWZ0ZXIgMTAwMFxuLy8gICAgcmVjb25uZWN0VGltZXIuc2V0VGltZW91dCgpIC8vIGZpcmVzIGFmdGVyIDUwMDBcbi8vICAgIHJlY29ubmVjdFRpbWVyLnJlc2V0KClcbi8vICAgIHJlY29ubmVjdFRpbWVyLnNldFRpbWVvdXQoKSAvLyBmaXJlcyBhZnRlciAxMDAwXG4vL1xuY2xhc3MgVGltZXIge1xuICBjb25zdHJ1Y3RvcihjYWxsYmFjaywgdGltZXJDYWxjKXtcbiAgICB0aGlzLmNhbGxiYWNrICA9IGNhbGxiYWNrXG4gICAgdGhpcy50aW1lckNhbGMgPSB0aW1lckNhbGNcbiAgICB0aGlzLnRpbWVyICAgICA9IG51bGxcbiAgICB0aGlzLnRyaWVzICAgICA9IDBcbiAgfVxuXG4gIHJlc2V0KCl7XG4gICAgdGhpcy50cmllcyA9IDBcbiAgICBjbGVhclRpbWVvdXQodGhpcy50aW1lcilcbiAgfVxuXG4gIC8vIENhbmNlbHMgYW55IHByZXZpb3VzIHNldFRpbWVvdXQgYW5kIHNjaGVkdWxlcyBjYWxsYmFja1xuICBzZXRUaW1lb3V0KCl7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMudGltZXIpXG5cbiAgICB0aGlzLnRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLnRyaWVzID0gdGhpcy50cmllcyArIDFcbiAgICAgIHRoaXMuY2FsbGJhY2soKVxuICAgIH0sIHRoaXMudGltZXJDYWxjKHRoaXMudHJpZXMgKyAxKSlcbiAgfVxufVxuIl19
