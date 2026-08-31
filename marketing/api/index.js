/* The Vercel entry point — see ../../api/index.js for why the app itself
   never listens on a socket here. No `ready` promise needed: unlike the
   product app, this one builds its route table synchronously. */

const app = require('../server');

module.exports = (req, res) => app(req, res);
