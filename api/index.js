/* The Vercel entry point.
 *
 * A serverless function is handed a request and a response; it does not own a
 * socket, so nothing here listens. `server.js` builds the app — registering one
 * route per screen from the repository, which is asynchronous — and exports the
 * promise of it. That promise resolves once per instance and is reused for
 * every request that instance goes on to serve, so the route table is built on
 * a cold start and not per invocation.
 */

const { ready } = require('../server');

module.exports = async (req, res) => {
  const app = await ready;
  return app(req, res);
};
