// standalone express webtask executor for nodejs
// how to use:
// 1. make secrets.json with secrets
// 2. use Webtask.__ctx in your code
// 3. save webtask as webtask.js
// 4. run as `node standalone-runner`

const WebtaskTools = {
  __ctx: {
    secrets: require('./secrets.json')
  },
  fromExpress(app) {
    return app;
  }
}

const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(...args) {
  if (args[0] == 'webtask-tools') return WebtaskTools;
  return originalRequire.apply(this, args);
};

require('./webtask').listen(3000, () => console.log(`App listening on port 3000!`));
