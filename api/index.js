/* The Vercel entry point — shared by TWO Vercel projects.
 *
 * A serverless function is handed a request and a response; it does not own a
 * socket, so nothing here listens.
 *
 * This file is read by both the product app's Vercel project and the
 * "marketing" one — both are git-connected to this same repo with Root
 * Directory left at its default (the repo root), because Vercel's CLI gives
 * no way to change that field and the dashboard field turned out not to
 * survive a save in this session. Branching on `DEPLOY_TARGET` here, set as
 * an env var per PROJECT (not per branch), was the way to still ship two
 * genuinely separate deployments without it: `marketing/server.js` reaches
 * `../lib`, `../views`, `../public` by ordinary relative paths, and since
 * Root Directory is the repo root for both, those paths resolve on disk the
 * same way `server.js`'s own do — no cross-boundary requires, no
 * `includeFiles` guesswork.
 *
 * `server.js` builds its route table from the repository asynchronously and
 * exports the promise of it, reused per warm instance; `marketing/server.js`
 * has no such step and exports the app directly. */

module.exports = async (req, res) => {
  if (process.env.DEPLOY_TARGET === 'marketing') {
    const app = require('../marketing/server');
    return app(req, res);
  }
  const { ready } = require('../server');
  const app = await ready;
  return app(req, res);
};
