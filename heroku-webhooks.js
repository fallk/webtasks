const crypto = require('crypto');
const unirest = require('unirest');

function reqEnd(req) {
  return new Promise((resolve, reject) => {
    req.end(res => {
      if (res.error) reject({res, error: res.error});
      else resolve(res);
    });
  });
}

/**
* @param context {WebtaskContext}
*/
module.exports = function(context, cb) {
  //heroku-webhook-hmac-sha256
  const hmac = context.headers['heroku-webhook-hmac-sha256'];

  if (!hmac) {
    console.log('Missing signature');
    return cb('Missing signature');
  }

  try {
    var calculated = crypto
      .createHmac('SHA256', context.secrets.secret)
      .update(context.body_raw)
      .digest();
    console.log('digest', calculated);
  } catch(e) {
    console.log('Invalid signature');
    return cb('Invalid signature');
  }

  const b = typeof context.body === 'object'
    ? context.body
    : JSON.parse(context.body_raw);

  const webhookBody = {
    "embeds": [
      {
        "title": `${b.data.app.name} - ${b.action}`,
        "description": b.data.description,
        "timestamp": b.data.updated_at || b.data.created_at,
        "footer": {
          "text": `version ${b.data.version}`
        },
        "author": {
          "name": b.data.user && b.data.user.email ? b.data.user.email : b.actor.email
        },
      }
    ]
  };

  if (b.data.slug) {
    webhookBody.embeds[0].fields = [
      {
        "name": `Latest commit: ${b.data.slug.commit.slice(0, 8)}`,
        "value": b.data.slug.commit_description
      }
    ];
  }

  reqEnd(unirest.post(context.secrets.webhook_url)
    .headers({'Accept': 'application/json', 'Content-Type': 'application/json'})
    .send(webhookBody)
  )
    .then(() => cb(null, 'success1'))
    .catch(err => cb(err));

  return undefined;
};