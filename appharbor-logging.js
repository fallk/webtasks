// @ts-check
const unirest = require('unirest');
const express = require('express');
const Webtask = require('webtask-tools');
const util = require('util');
const console = require('chalk-console');
const app = express();

// Express allows arrays-of-middleware to act as a "single" middleware.
const logplexMiddleware = [
  // First, read the message body into `req.body`, making sure it only
  // accepts logplex "documents".
  require('body-parser').raw({ type: 'application/logplex-1' }),
  // Next, split `req.body` into separate lines and parse each one using
  // the `glossy` syslog parser.
  (req, res, next) => {
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
// <removed>

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

  const promises = [];

  /**
   * @typedef {{
        priority: number,
        timestamp: string,
        host?: string,
        appName?: string,
        dyno?: string,
        part: number,
        facilityCode: number,
        severityCode: number,
        facility: string,
        severity: string,
        process?: string,
        message: string,
        messageFormatted: string,
      }} MsgData
   */

  /** @type {MsgData[]} */
  const prettifiedLog = req.body.flatMap(str => {
    const comp = str.split(' ');

    const headerPri = comp.shift();

    const priority = Number(headerPri.slice(headerPri.indexOf('<') + 1, headerPri.lastIndexOf('>')));
    const version = Number(headerPri.slice(headerPri.lastIndexOf('>') + 1));

    if (version !== 1) {
      console.warn('! unsupported RFC 5424 version !');
    }

    /** @type {MsgData} */
    const msgData = {
      priority,
      timestamp: new Date(comp.shift()).toISOString(), // ISO is the only format that loggly will parse
      host: comp.shift(),
      appName: comp.shift(), // or heroku.source
      dyno: comp.shift(), // or procId
      part: -1,
      facilityCode: priority >> 3,
      severityCode: priority & 7,
    };

    msgData.facility = FACILITY[msgData.facilityCode] || '?';
    msgData.severity = SEVERITY[msgData.severityCode] || '?';

    if (comp[0] === '-') { // discard dash
      comp.shift();
    }

    if (comp[0] && comp[0].endsWith(':')) { // RayTech.RayBot.AppHarbor.exe:
      msgData.process = comp.shift().slice(0, -1);
    }

    const msgDataJson = JSON.stringify(msgData); // msgData as json without message or messageFormatted
    const processPrefix = keepProcessInMessage && msgData.process ? `[${msgData.process}] ` : ``; // include process when keepProcessInMessage==true otherwise empty

    msgData.message = comp.join(' ');
    msgData.messageFormatted = `${processPrefix}${msgData.message} ${msgDataJson}`;

    if (msgData.message.includes('\n')) {
      // append part number and json data after each line
      return msgData.message.split('\n').map((line, part) => {
        if (line.endsWith('\r')) {
          line = line.slice(0, -1); // strip carriage return for consistency
        }

        return Object.assign({}, msgData, { part, message: line, messageFormatted: `${processPrefix}${line} ${msgDataJson}` });
      });
    }

    // else just return a single message and json data
    return [msgData];
  });

  // push to sematext logsense
  promises[promises.length] = promisePost('https://logsene-receiver.sematext.com/_bulk') // TODO can logsene take more fields?
    .headers({'Content-Type': 'application/json'})
    .send(
      prettifiedLog.map(({facility, timestamp, messageFormatted, severityCode}) => 
        JSON.stringify({ index: { _index: ctx.secrets.logsene_token, _type: facility } }) + '\n' +
        JSON.stringify({ '@timestamp': timestamp, message: messageFormatted, severity_numeric: severityCode })
      ).join('\n')
    )
    .end()
    .then(e => e.raw_body);

  // push to logz.io
  promises[promises.length] = promisePost(ctx.secrets.logzio_url)
    .headers({'Content-Type': 'application/json'})
    .send(
      prettifiedLog.map(data =>
        JSON.stringify(Object.assign({ '@timestamp': data.timestamp }, data))
      ).join('\n')
    )
    .end()
    .then(e => e.raw_body);

  // push to loggly
  promises[promises.length] = promisePost(ctx.secrets.logurl)
    .headers({/*'Accept': 'application/json', */'Content-Type': 'application/json'})
    .send(
      prettifiedLog.map(({messageFormatted}) => messageFormatted).join('\n')
    )
    .end()
    .then(e => e.raw_body);

  // aggregate logs in data, push when >200k
  promises[promises.length] = (async () => {
    const data = await repeatGetData(ctx);

    if (!data) data = { d: '' };
    else if (!data.d) data.d = '';

    data.d += '\n' + (req.body ? req.body.join('\n') : `<saved message with no content at ${new Date()}>`);

    if (data.d.length > 200000) { // 200k
      updateBatched(data.d) // asynchronously dispatch gist write
        .then(() => console.log('GIST updated'))
        .catch(err => console.error('GIST failed: ' + err));
      data.d = '';
    }

    await repeatSetData(ctx, data);
  })();

  //res.status(200).end('Hi: ' + util.inspect(req.body));

  Promise.all(promises)
    .then(results => {
      for (const result of results) {
        console.blue('REQ finished ' + result);
      }
      res.status(200).end('Hi: ' + util.inspect(req.body));
    })
    .catch(err => {
      console.error('REQ errored ' + err);
      res.status(500).end(err.toString() + '\n' + util.inspect(err) + '\n' + util.inspect(err.res && err.res.body));
    });
}

// push aggregate
async function updateBatched(str) {
  // ...
}

app.post('/', logplexMiddleware, handler);
if (Webtask.__ctx) app.get('/', logplexMiddleware, handler);

app.get('/flush', (req, res) => {
  const ctx = Webtask.__ctx || req.webtaskContext;

  //const password = req.originalUrl.slice(req.originalUrl.indexOf('?') + 1);
  (async () => {
    //if (password !== ctx.secrets.flush_password) return false;
    const data = await repeatGetData(ctx);
    if (!data || !data.d) return false;

    const oldValue = data.d;
    data.d = '';

    await Promise.all([repeatSetData(ctx, data), updateBatched(oldValue)]);
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

Array.prototype.flat = function() {
	var depth = isNaN(arguments[0]) ? 1 : Number(arguments[0]);

	return depth ? Array.prototype.reduce.call(this, function (acc, cur) {
		if (Array.isArray(cur)) {
			acc.push.apply(acc, Array.prototype.flat.call(cur, depth - 1));
		} else {
			acc.push(cur);
		}

		return acc;
	}, []) : Array.prototype.slice.call(this);
};

Array.prototype.flatMap = function(callback) {
	return Array.prototype.map.apply(this, arguments).flat();
};