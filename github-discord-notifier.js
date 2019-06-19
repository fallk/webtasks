const unirest = require('unirest');
const lzma = require('lzma');
const base85 = require('base85');
const limiter = require('simple-rate-limiter');

/* globals Promise */

/* Add support for Promises https://github.com/xavi-/node-simple-rate-limiter/pull/10 */
function limitPromise(promise) {
  var res = null;
  var rej = null;
  var lim = limiter(options => {
    promise(options)
      .then(res)
      .catch(rej);
  });
  var promiseWrapper = new Promise((resolve, reject) => {
    res = resolve;
    rej = reject;
  });
  // return value
  var self = function(options) {
    lim(options);
    return promiseWrapper;
  };
  self.to = function(to) {
    lim.to(to);
    return self;
  };
  self.per = function(per) {
    lim.per(per);
    return self;
  };
  return self;
}

function reqEnd(req) {
  return new Promise((resolve, reject) => {
    req.end(res => {
      if (res.error) reject({res, error: res.error});
      else resolve(res);
    });
  });
}
const ratelimitedRequest = limitPromise(reqEnd).to(5).per(5001);

// get data => data.f => decode => decompress => parse and return array
function parseReadNotifs(context) {
  return new Promise((resolve, reject) => {
    context.storage.get((error, data) => {
      if (error) reject(error);
      else if (!data || !data.f) resolve([]);
      else lzma.decompress(base85.decode(`<~${data.f}~>`, 'ascii85'), (result, error2) => {
        if (error2) reject(error2);
        else resolve(JSON.parse(result));
      });
    });
  });
}

// stringify array => compress => encode => set {f: array} in storage
function writeReadNotifs(context, data) {
  return new Promise((resolve, reject) => {
    lzma.compress(JSON.stringify(data), 9, (result, error) => {
      console.log('Buffer.from(result)', Buffer.from(result));
      console.log('base85.encode(Buffer.from(result))', base85.encode(Buffer.from(result), 'ascii85'));
      if (error) reject(error);
      else context.storage.set({
        f: base85.encode(Buffer.from(result), 'ascii85').slice(2, -2)
      }, error2 => {
        if (error2) reject(error2);
        else resolve();
      });
    });
  });
}

/**
* @param context {WebtaskContext}
*/
module.exports = function(context, cb) {
  (async () => {
    const req = unirest('GET', 'https://api.github.com/notifications');

    req.headers({
      'Cache-Control': 'no-cache',
      'Authorization': 'token ' + context.secrets.gh_token,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'uwx-hansen-crawler'
    });

    const { raw_body: body } = await reqEnd(req);
    const notifs = JSON.parse(body);
    let readNotifs = await parseReadNotifs(context);
    const outNotifs = []; // remove already dismissed notifications that are not in the payload body
    const resBodies = [];
    const subjects = [];

    console.log(notifs);
    for (let notif of notifs) {
      outNotifs.push(notif.id);
      if (readNotifs.includes(notif.id)) continue;

      const req2 = unirest('GET', notif.subject.latest_comment_url);

      req2.headers({
        'Cache-Control': 'no-cache',
        'Authorization': 'token ' + context.secrets.gh_token,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'uwx-hansen-crawler'
      });

      const { raw_body: body2 } = await reqEnd(req2);
      const subject = JSON.parse(body2);

      subjects.push(subject);

      const webhookBody = {
        'embeds': [{
          'title': notif.subject.title,
          'description': subject.body,
          'url': subject.html_url,
          'timestamp': subject.updated_at, //notif.updated_at,
          'footer': {
            'text': notif.subject.type + ' comment to ' + notif.repository.full_name
          },
          'thumbnail': {
            'url': subject.user.avatar_url
          },
          'author': {
            'name': subject.user.login + ' [' + subject.author_association + ']',
            'url': subject.user.html_url
          }
        }]
      };

      const req3 = unirest.post('https://canary.discordapp.com/api/webhooks/367855225446334465/' + context.secrets.webhook_token)
        .headers({'Accept': 'application/json', 'Content-Type': 'application/json'})
        .send(webhookBody);

      const { raw_body: body3 } = await ratelimitedRequest(req3);
      try {
        resBodies.push(JSON.parse(body3));
      } catch (e) {
        console.error('during json parse' + e);
        resBodies.push(body3);
      }
    }

    await writeReadNotifs(context, outNotifs);

    return { notifs, outNotifs, resBodies };
  })().then(data => cb(null, data)).catch(o => {
    const {res, error: err} = o;
    if (err) {
      console.error('a', res.raw_body, err);
      cb(err);
    } else {
      console.error('b', o);
      cb(o);
    }
  });
};