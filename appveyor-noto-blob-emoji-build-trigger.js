var unirest = require("unirest");

module.exports = function (context, req, res) {

  var nreq = unirest("POST", "https://ci.appveyor.com/api/builds");

  nreq.headers({
  "Cache-Control": "no-cache",
  "Authorization": "Bearer " + context.secrets.appv_token,
  "Content-Type": "application/json"
  });

  nreq.type("json");
  nreq.send({
    "accountName": "uwx",
    "projectSlug": "noto-blob-emoji",
    "branch": "master"
  });

  nreq.end(function (ares) {
    if (ares.error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('err ' + ares.error + '\n' + ares.body);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(JSON.stringify(ares.body));
  });

/*
mark as read

var req = unirest("PATCH", context.secrets.gh_notif_thread);
req.headers({
  "cache-control": "no-cache",
  "authorization": context.secrets.gh_notifs_auth
});
req.end(function (res) {
  if (res.error) throw new Error(res.error);

  console.log(res.body);
});

*/
};
