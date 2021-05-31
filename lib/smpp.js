const net = require('net');
const tls = require('tls');
const parse = require('url').parse;
const defs = require('./defs');
const {PDU} = require('./pdu');
const EventEmitter = require('events');
const assert = require('assert');

class Session extends EventEmitter {
  constructor(options) {
    super();
    this.options = options || {};
    let transport = net;
    this.sequence = 0;
    this.paused = false;
    this._busy = false;
    this._callbacks = [];
    this._interval = 0;
    this._command_length = null;
    if (options.socket) {
      this.socket = options.socket;
    } else {
      const {host, port} = options;
      if (options.tls) {
        transport = tls;
      }
      this.socket = transport.connect(port, host);
      this.socket.on('connect', () => {
        this.emit('connect');
      });
      this.socket.on('secureConnect', () => {
        this.emit('secureConnect');
      });
    }
    this.socket.on('readable', this._extractPDUs.bind(this));
    this.socket.on('close', () => {
      this.emit('close');
      if (this._interval) {
        clearInterval(this._interval);
        this._interval = 0;
      }
    });
    this.socket.on('error', (e) => {
      this.emit('error', e);
      if (this._interval) {
        clearInterval(this._interval);
        this._interval = 0;
      }
    });
  }

  set auto_enquire_link_period(val) {
    if (this._interval) clearInterval(this._interval);
    this._interval = setInterval(() => {
      this.enquire_link()
        .catch((err) => {
          console.error({err}, 'Error sending enquire_Link');
        });
    }, val);
  }

  connect() {
    this.sequence = 0;
    this.paused = false;
    this._busy = false;
    this._callbacks = [];
    this.socket.connect(this.options);
  }

  _extractPDUs() {
    if (this._busy) {
      return;
    }
    this._busy = true;
    let pdu;
    while (!this.paused) {
      try {
        if (!this._command_length) {
          this._command_length = PDU.commandLength(this.socket);
          if (!this._command_length) {
            break;
          }
        }
        if (!(pdu = PDU.fromStream(this.socket, this._command_length))) {
          break;
        }
      } catch (e) {
        this.emit('error', e);
        return;
      }
      this._command_length = null;
      this.emit('pdu', pdu);
      this.emit(pdu.command, pdu);
      if (pdu.isResponse() && this._callbacks[pdu.sequence_number]) {
        this._callbacks[pdu.sequence_number](pdu);
        delete this._callbacks[pdu.sequence_number];
      }
    }
    this._busy = false;
  }

  send(pdu, sendCallback) {
    if (!this.socket.writable) {
      return false;
    }

    return new Promise((resolve, reject) => {
      if (!pdu.isResponse()) {
        // when server/session pair is used to proxy smpp
        // traffic, the sequence_number will be provided by
        // client otherwise we generate it automatically
        if (!pdu.sequence_number) {
          if (this.sequence == 0x7FFFFFFF) {
            this.sequence = 0;
          }
          pdu.sequence_number = ++this.sequence;
        }

        this._callbacks[pdu.sequence_number] = resolve;
      }
      this.socket.write(pdu.toBuffer(), () => {
        this.emit('send', pdu);
        if (sendCallback) sendCallback(pdu);
      });
    });
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this._extractPDUs();
  }

  close(callback) {
    if (callback) {
      this.socket.once('close', callback);
    }
    this.socket.end();
  }

  destroy(callback) {
    if (callback) {
      this.socket.once('close', callback);
    }
    this.socket.destroy();
  }
}

const createShortcut = (command) => {
  return function(options, sendCallback) {
    if (typeof options == 'function') {
      sendCallback = options;
      options = {};
    }
    const pdu = new PDU(command, options);
    return this.send(pdu, sendCallback);
  };
};

for (const command in defs.commands) {
  Session.prototype[command] = createShortcut(command);
}

class Server extends net.Server {
  constructor(options, listener) {
    super(options, (socket) => {
      const session = new Session({socket: socket});
      session.server = this;
      this.sessions.push(session);
      socket.on('close', () => {
        this.sessions.splice(this.sessions.indexOf(session), 1);
      });
      if (listener) listener(session);
      this.emit('session', session);
    });
    this.sessions = [];
  }

  listen(opts, callback) {
    if (typeof opts === 'function' || typeof opts === 'undefined') {
      callback = opts;
      opts = {port: 2775};
    }
    else assert.ok(typeof opts === 'object', 'listen: must pass object');
    return net.Server.prototype.listen.call(this, opts, callback);
  }
}

class SecureServer extends tls.Server {
  constructor(options, listener) {
    super(options, (socket) => {
      const session = new Session({socket: socket});
      session.server = this;
      this.sessions.push(session);
      socket.on('close', () => {
        this.sessions.splice(this.sessions.indexOf(session), 1);
      });
      if (listener) listener(session);
      this.emit('session', session);
    });
    this.sessions = [];
  }

  listen(opts, callback) {
    if (typeof opts === 'function' || typeof opts === 'undefined') {
      callback = opts;
      opts = {port: 3550};
    }
    else assert.ok(typeof opts === 'object', 'listen: must pass object');
    return tls.Server.prototype.listen.call(this, opts, callback);
  }
}

const createServer = (options, listener) => {
  if (typeof options == 'function') {
    listener = options;
    options = {};
  } else {
    options = options || {};
  }

  if (options.key && options.cert) {
    return new SecureServer(options, listener);
  }

  return new Server(options, listener);
};

const connect = async(url) => {
  assert.ok(typeof url === 'string', 'connect(): url is required');
  assert.ok(url.startsWith('smpp://') || url.startsWith('ssmpp://'), 'url scheme must be smpp or ssmpp');

  const u = parse(url);
  const opts = {
    host: u.hostname,
    port: u.port,
    tls: u.protocol === 'ssmpp:'
  };
  opts.port = opts.port || (opts.tls ? 3550 : 2775);

  return new Promise((resolve, reject) => {
    const session = new Session(opts);
    session.on('error', (err) => reject(err));
    session.on(opts.tls ? 'secureConnect' : 'connect', () => {
      session.removeAllListeners('error');
      resolve(session);
    });
  });
};

const addCommand = (command, options) => {
  options.command = command;
  defs.commands[command] = options;
  defs.commandsById[options.id] = options;
  Session.prototype[command] = createShortcut(command);
};

const addTLV = (tag, options) => {
  options.tag = tag;
  defs.tlvs[tag] = options;
  defs.tlvsById[options.id] = options;
};

module.exports = {
  createServer,
  connect,
  createSession: connect,
  addCommand,
  addTLV,
  Session,
  Server,
  PDU,
  ...defs,
  ...defs.errors,
  ...defs.consts
};
