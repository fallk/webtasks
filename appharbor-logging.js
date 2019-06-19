const unirest = require('unirest');
const express = require('express');
const Webtask = require('webtask-tools');
const util = require('util');
const Gists = require('gists');
const app = express();
let gists;

//
function makeOrUpdateGist(appendContent) {
  appendContent = appendContent || `<received message with no content at ${new Date()}>`;
  
  function pad(n, width, z) {
    z = z || '0';
    n = n + '';
    return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
  }

  function formatDate(date) {
    var day = pad(date.getUTCDate(), 2);
    var month = pad(date.getUTCMonth() + 1, 2);
    var year = pad(date.getUTCFullYear(), 4);

    return `${year}-${month}-${day}`;
  }

  const today = new Date();
  const todayLogFilename = `${formatDate(today)}.log`;
  const todayLogDesc = `RayBot Log for ${formatDate(today)}`; // used for identity

  return (async () => {
    const gistList = (await gists.all()).pages.flatMap(e => e.body);

    //console.log(gistList);

    let existingGist = gistList.find(gist => gist.description === todayLogDesc);
    if (!existingGist) {
      await gists.create({
        description: todayLogDesc,
        public: false,
        files: {
          [todayLogFilename]: {
            content: appendContent
          },
        }
      });
    } else {
      existingGist = (await gists.get(existingGist.id)).body;
      await gists.edit(existingGist.id, {
        files: {
          [todayLogFilename]: {
            content: existingGist.files[todayLogFilename].content + '\n' + appendContent
          },
        }
      });
    }
  })();
}
//

// Express allows arrays-of-middleware to act as a "single" middleware.
const logplexMiddleware = [
  // First, read the message body into `req.body`, making sure it only
  // accepts logplex "documents".
  require('body-parser').raw({ type: 'application/logplex-1' }),
  // Next, split `req.body` into separate lines and parse each one using
  // the `glossy` syslog parser.
  function(req, res, next) {
    const buf = req.body || Buffer.alloc(0);
    let index = 0;

    function isWhitespace(ch) {
      return /[ \f\n\r\t\v\u00A0\u2028\u2029]/.test(ch);
    }

    function readInt() {
      const number = [];
      let val;
      while (!isWhitespace(val = String.fromCharCode(buf[index]))) {
        number.push(val);
        index++;
      }
      return parseInt(number.join(''), 10);
    }
    function readChar() {
      return String.fromCharCode(buf[index++]);
    }
    function readMessage(length, encoding = 'utf8') {
      return buf.toString(encoding, index, (index += length));
    }

    const messages = [];

    while (index < buf.length) {
      const length = readInt();
      const space = readChar();
      if (!isWhitespace(space)) {
        throw new Error('invalid input format: ' + space);
      }
      messages.push(readMessage(length).trim());
    }

    console.log(messages);

    req.body = messages;
    next();
  }
];

// https://github.com/squeeks/glossy/blob/master/lib/glossy/parse.js
const FACILITY = [
  'kern',     // kernel messages
  'user',     // user-level messages
  'mail',     // mail system
  'daemon',   // system daemons
  'auth',     // security/authorization messages
  'syslog',   // messages generated internally by syslogd
  'lpr',      // line printer subsystem
  'news',     // network news subsystem
  'uucp',     // UUCP subsystem
  'clock',    // clock daemon
  'sec',      // security/authorization messages
  'ftp',      // FTP daemon
  'ntp',      // NTP subsystem
  'audit',    // log audit
  'alert',    // log alert
  'clock',    // clock daemon (note 2)
  'local0',   // local use 0  (local0)
  'local1',   // local use 1  (local1)
  'local2',   // local use 2  (local2)
  'local3',   // local use 3  (local3)
  'local4',   // local use 4  (local4)
  'local5',   // local use 5  (local5)
  'local6',   // local use 6  (local6)
  'local7'    // local use 7  (local7)
];

const SEVERITY = [
  'emerg',    // Emergency: system is unusable
  'alert',    // Alert: action must be taken immediately
  'crit',     // Critical: critical conditions
  'err',      // Error: error conditions
  'warn',     // Warning: warning conditions
  'notice',   // Notice: normal but significant condition
  'info',     // Informational: informational messages
  'debug'     // Debug: debug-level messages
];

// flatMap polyfill
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flatMap
if (!Array.prototype.flatMap) {
  /* eslint no-extend-native: 0 */
  Object.defineProperty(Array.prototype, 'flatMap', {
    value: function(callback, thisArg) {
      var self = thisArg || this;
      if (self === null) {
        throw new TypeError('Array.prototype.flatMap called on null or undefined');
      }
      if (typeof callback !== 'function') {
        throw new TypeError(callback + ' is not a function');
      }

      var list = [];

      // 1. Let O be ? ToObject(this value).
      var o = Object(self);

      // 2. Let len be ? ToLength(? Get(O, "length")).
      var len = o.length >>> 0;

      for (var k = 0; k < len; ++k) {
        if (k in o) {
          var part_list = callback.call(self, o[k], k, o);
          list = list.concat(part_list);
        }
      }

      return list;
    }
  });
}

/* global Promise */

function promisePost(url) {
  const obj = unirest.post(url);
  const oldEnd = obj.end;
  obj.end = () => {
    return new Promise((resolve, reject) => {
      oldEnd.call(obj, res => {
        if (res.error) {
          const err = Object.assign({}, res.error);
          err.res = res;
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }
  return obj;
}

// call get on the parent class of Gists
function gistsGetRequest(...args) {
  return Object.getPrototypeOf(Object.getPrototypeOf(gists)).get.apply(gists, args);
}

function get(ctx) {
  return new Promise((resolve, reject) => {
    ctx.storage.get((error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function set(ctx, data, force = false) {
  return new Promise((resolve, reject) => {
    ctx.storage.set(data, { force: force ? 1 : undefined }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function repeatGetData(ctx) {
  do {
    try {
      return await get(ctx);
    } catch (e) { console.error('GETTING DATA: ' + e); }
  } while (true);
}

async function repeatSetData(ctx, data) {
  do {
    try {
      await set(ctx, data, true);
      return;
    } catch (e) { console.error('SETTING DATA: ' + e); }
  } while (true);
}

// settings
const keepProcessInMessage = true;

function handler(req, res) {
  const ctx = Webtask.__ctx || req.webtaskContext;
  
  if (!gists) {
    gists = new Gists({
      token: ctx.secrets.gh_token
    });
  }

  const promises = [];

  promises[promises.length] = promisePost(ctx.secrets.logurl)
    .headers({/*'Accept': 'application/json', */'Content-Type': 'application/json'})
    .send(req.body.flatMap(str => {
      const comp = str.split(' ');

      const headerPri = comp.shift();

      const priority = Number(headerPri.slice(headerPri.indexOf('<') + 1, headerPri.lastIndexOf('>')));
      const version = Number(headerPri.slice(headerPri.lastIndexOf('>') + 1));

      if (version !== 1) {
        console.warn('! unsupported RFC 5424 version !');
      }

      const ret = {
        priority,
        timestamp: new Date(comp.shift()).toISOString(), // ISO is the only format that loggly will parse
        host: comp.shift(),
        appName: comp.shift(), // or heroku.source
        dyno: comp.shift(), // or procId
      };

      ret.facilityCode = priority >> 3;
      ret.facility = FACILITY[ret.facilityCode] || '?';
      ret.severityCode = priority & 7;
      ret.severity = SEVERITY[ret.severityCode] || '?';

      if (comp[0] === '-') comp.shift(); // discard dash

      if (comp[0] && comp[0].endsWith(':')) { // RayTech.RayBot.AppHarbor.exe:
        ret.process = comp.shift().slice(0, -1);
      }

      let message = comp.join(' ');

      if (keepProcessInMessage && ret.process) {
        message = `[${ret.process}] ${message}`;
      }

      if (message.includes('\n')) {
        // append part number and json data after each line
        return message.split('\n').map((line, part) => {
          if (line.endsWith('\r')) {
            line = line.slice(0, -1); // strip carriage return for consistency
          }

          const retClone = Object.assign({ part }, ret);
          return `${line} ${JSON.stringify(retClone)}`;
        });
      }

      // else just return a single message and json data
      return [`${message} ${JSON.stringify(ret)}`];
    }).join('\n'))
    .end()
    .then(e => e.raw_body);
    
  ///*
  promises[promises.length] = gistsGetRequest('/rate_limit').then(e => {
    const ratelimits = e.body;
    console.log('Rate limits: ' + util.inspect(ratelimits));
    return ratelimits;
  });
  //*/
  
  promises[promises.length] = (async () => {
    const data = await repeatGetData(ctx);
    
    if (!data) data = { d: '' };
    if (!data.d) data.d = '';
    data.d += '\n' + (req.body ? req.body.join('\n') : `<saved message with no content at ${new Date()}>`);
    
    if (data.d.length > 200000) { // 200k
      makeOrUpdateGist(data.d) // asynchronously dispatch gist write
        .then(() => console.log('GIST updated'))
        .catch(err => console.error('GIST failed: ' + err));
      data.d = '';
    }
    
    await repeatSetData(ctx, data);
  })();

  //res.status(200).end('Hi: ' + util.inspect(req.body));

  Promise.all(promises)
    .then(results => {
      console.log('REQ finished ' + util.inspect(results));
      res.status(200).end('Hi: ' + util.inspect(req.body));
    })
    .catch(err => {
      console.error('REQ errored ' + err);
      res.status(500).end(err.toString() + '\n' + util.inspect(err) + '\n' + util.inspect(err.res && err.res.body));
    });
}

app.post('/', logplexMiddleware, handler);
if (Webtask.__ctx) app.get('/', logplexMiddleware, handler);

app.get('/flush', (req, res) => {
  const ctx = Webtask.__ctx || req.webtaskContext;
  
  if (!gists) {
    gists = new Gists({
      token: ctx.secrets.gh_token
    });
  }

  //const password = req.originalUrl.slice(req.originalUrl.indexOf('?') + 1);
  (async () => {
    //if (password !== ctx.secrets.flush_password) return false;
    const data = await repeatGetData(ctx);
    if (!data || !data.d) return false;

    const oldValue = data.d;
    data.d = '';

    await Promise.all([repeatSetData(ctx, data), makeOrUpdateGist(oldValue)]);
    return true;
  })()
    .then(result => {
      console.log('FLUSH-GIST updated: ' + result);
      res.status(200).end('FLUSH-GIST: ' + result + ',' + util.inspect(req.body));
    })
    .catch(err => {
      console.error('FLUSH-GIST failed: ' + err);
      res.status(500).end(err.toString() + '\n' + util.inspect(err) + '\n' + util.inspect(err.res && err.res.body));
    });
});

module.exports = Webtask.fromExpress(app);
