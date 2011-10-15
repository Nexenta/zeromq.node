
/**
 * Module dependencies.
 */

var EventEmitter = require('events').EventEmitter
  , IOWatcher = process.binding('io_watcher').IOWatcher
  , zmq = require('./build/default/binding')
  , util = require('util');

/**
 * Expose bindings as the module.
 */

exports = module.exports = zmq;

/**
 * Map of socket types.
 */

var types = exports.types = {
    pub: zmq.ZMQ_PUB
  , sub: zmq.ZMQ_SUB
  , req: zmq.ZMQ_REQ
  , xreq: zmq.ZMQ_XREQ
  , rep: zmq.ZMQ_REP
  , xrep: zmq.ZMQ_XREP
  , push: zmq.ZMQ_PUSH
  , pull: zmq.ZMQ_PULL
  , dealer: zmq.ZMQ_DEALER
  , router: zmq.ZMQ_ROUTER
  , pair: zmq.ZMQ_PAIR
};

/**
 * Map of socket options.
 */

var opts = exports.options = {
    _fd: zmq.ZMQ_FD
  , _ioevents: zmq.ZMQ_EVENTS
  , _receiveMore: zmq.ZMQ_RCVMORE
  , _subscribe: zmq.ZMQ_SUBSCRIBE
  , _unsubscribe: zmq.ZMQ_UNSUBSCRIBE
  , ioThreadAffinity: zmq.ZMQ_AFFINITY
  , backlog: zmq.ZMQ_BACKLOG
  , highWaterMark: zmq.ZMQ_HWM
  , identity: zmq.ZMQ_IDENTITY
  , lingerPeriod: zmq.ZMQ_LINGER
  , multicastLoop: zmq.ZMQ_MCAST_LOOP
  , multicastDateRate: zmq.ZMQ_RATE
  , receiveBufferSize: zmq.ZMQ_RCVBUF
  , reconnectInterval: zmq.ZMQ_RECONNECT_IVL
  , multicastRecovery: zmq.ZMQ_RECOVERY_IVL
  , sendBufferSize: zmq.ZMQ_SNDBUF
  , diskOffloadSize: zmq.ZMQ_SWAP
};

// Context management happens here. We lazily initialize a default context,
// and use that everywhere. Also cleans up on exit.
var context_ = null;
var defaultContext = function() {
  if (context_ !== null) {
    return context_;
  }

  var io_threads = 1;
  if (process.env.ZMQ_IO_THREADS) {
    io_threads = parseInt(process.env.ZMQ_IO_THREADS, 10);
    if (!io_threads || io_threads < 1) {
      util.error('Invalid number in ZMQ_IO_THREADS, using 1 IO thread.');
      io_threads = 1;
    }
  }

  context_ = new zmq.Context(io_threads);
  process.on('exit', function() {
    // context_.close();
    context_ = null;
  });

  return context_;
};

/**
 * Create a new socket of the given `type`.
 *
 * @param {String|Number} type
 * @api public
 */

function Socket(type) {
  this.type = type;
  this._zmq = new zmq.Socket(defaultContext(), types[type]);
  this._outgoing = [];
  this._watcher = new IOWatcher;
  this._watcher.callback = this._flush.bind(this);
  this._watcher.set(this._fd, true, false);
  this._watcher.start();
  this._inFlush = false;
};

/**
 * Inherit from `EventEmitter.prototype`.
 */

Socket.prototype.__proto__ = EventEmitter.prototype;

/**
 * Set `opt` to `val`.
 *
 * @param {Number} opt
 * @param {Mixed} val
 * @return {Socket} for chaining
 * @api public
 */

Socket.prototype.setsockopt = function(opt, val){
  this._zmq.setsockopt(opt, val);
  return this;
};

/**
 * Get socket `opt`.
 *
 * @return {Mixed}
 * @api public
 */

Socket.prototype.getsockopt = function(opt){
  return this._zmq.getsockopt(opt);
};

// set / get opt accessors

Object.keys(opts).forEach(function(name){
  Socket.prototype.__defineGetter__(name, function() {
    return this._zmq.getsockopt(opts[name]);
  });

  Socket.prototype.__defineSetter__(name, function(val) {
    if ('string' == typeof val) val = new Buffer(val, 'utf8');
    return this._zmq.setsockopt(opts[name], val);
  });
});

// `bind` and `connect` map directly to our binding.
Socket.prototype.bind = function(addr, cb) {
  var self = this;
  self._watcher.stop();
  self._zmq.bind(addr, function(err) {
    self._watcher.start();
    cb(err);
  });
};

Socket.prototype.bindSync = function(addr) {
  var self = this;
  self._watcher.stop();
  try {
    self._zmq.bindSync(addr);
  } catch (e) {
    self._watcher.start();
    throw e;
  }
  self._watcher.start();
};

Socket.prototype.connect = function(addr) {
  this._zmq.connect(addr);
};

// `subscribe` and `unsubcribe` are exposed as methods.
// The binding expects a setsockopt call for these, though.
Socket.prototype.subscribe = function(filter) {
  this._subscribe = filter;
};

Socket.prototype.unsubscribe = function(filter) {
  this._unsubscribe = filter;
};

// Queue a message. Each arguments is a multipart message part.
// It is assumed that strings should be send in UTF-8 encoding.
Socket.prototype.send = function() {
  var i, part, flags,
      length = arguments.length,
      parts = [];
  for (i = 0; i < length; i++) {
    part = arguments[i];
    // We only send Buffers, but if you give us a type that can
    // easily be converted, we'll do that for you.
    if (!(part instanceof Buffer)) {
      part = new Buffer(part, 'utf-8');
    }
    flags = 0;
    if (i !== length-1) {
      flags |= zmq.ZMQ_SNDMORE;
    }
    parts.push([part, flags]);
  }
  this._outgoing = this._outgoing.concat(parts);
  this._flush();
};

Socket.prototype.currentSendBacklog = function() {
  return this._outgoing.length;
};

// The workhorse that does actual send and receive operations.
// This helper is called from `send` above, and in response to
// the watcher noticing the signaller fd is readable.
Socket.prototype._flush = function() {

  // Don't allow recursive flush invocation as it can lead to stack
  // exhaustion and write starvation
  if (this._inFlush === true) { return; }

  this._inFlush = true;

  try {
    while (true) {
      var emitArgs, sendArgs,
        flags = this._ioevents;
      if (this._outgoing.length === 0) {
        flags &= ~zmq.ZMQ_POLLOUT;
      }
      if (!flags) {
        break;
      }

      if (flags & zmq.ZMQ_POLLIN) {
          emitArgs = ['message'];
          do {
            emitArgs.push(new Buffer(this._zmq.recv()));
          } while (this._receiveMore);

          this.emit.apply(this, emitArgs);
          if (this._zmq.state != zmq.STATE_READY) {
            this._inFlush = false;
            return;
          }
      }

      // We send as much as possible in one burst so that we don't
      // starve sends if we receive more than one message for each
      // one sent.
      while ((flags & zmq.ZMQ_POLLOUT) && (this._outgoing.length !== 0)) {
        sendArgs = this._outgoing.shift();
        this._zmq.send.apply(this._zmq, sendArgs);
        flags = this._ioevents;
      }
    }
  }
  catch (e) {
    e.flags = flags;
    e.outgoing = util.inspect(this._outgoing);
    try {
      this.emit('error', e);
    } catch (e2) {
      this._inFlush = false;
      throw e2;
    }
  }

  this._inFlush = false;
};

// Clean up the socket.
Socket.prototype.close = function() {
  this._watcher.stop();
  this._watcher = undefined;
  this._zmq.close();
};

// The main function of the library.
exports.createSocket = function(typename, options) {
  var key,
    sock = new Socket(typename);

  if (typeof(options) === 'object') {
    for (key in options) {
      if (options.hasOwnProperty(key)) {
        sock[key] = options[key];
      }
    }
  }

  return sock;
};
