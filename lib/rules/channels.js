/* Where a fired rule goes.
 *
 * Phase 8. The exit criterion says a rule must fire *end-to-end to its
 * configured channel*, and the design configures email, Slack and WhatsApp.
 * None of those can be written here: there is no SMTP host, no Slack workspace,
 * no WhatsApp Business account and no credentials for any of them.
 *
 * So the arrangement is the one this codebase already uses twice — for ingest
 * transports and for the reasoner. `log` delivers for real, to a place you can
 * read; the rest throw with their reason. A rule that fires is *recorded as
 * fired* either way, because whether a notification reached somebody and
 * whether the condition was met are two different facts and collapsing them
 * would lose the more important one.
 *
 * The delivery result is stored on the fire, so "the rule fired but nobody was
 * told" is a state the product can show rather than a silence.
 */

const NOT_CONFIGURED = (channel, needs) => () => {
  throw new Error(`${channel} is not configured: ${needs}. The rule still fired and is recorded.`);
};

function logChannel({ sink = console } = {}) {
  return {
    name: 'log',
    configured: true,
    deliver(fire) {
      sink.log(`ALERT [${fire.severity}] ${fire.rule}: ${fire.reason} → ${fire.to.join(', ')}`);
      return { channel: 'log', delivered: true, at: fire.at };
    },
  };
}

const CHANNELS = {
  log: logChannel,
  email: () => ({ name: 'email', configured: false, deliver: NOT_CONFIGURED('email', 'no SMTP host or sender identity') }),
  slack: () => ({ name: 'slack', configured: false, deliver: NOT_CONFIGURED('slack', 'no workspace token') }),
  whatsapp: () => ({ name: 'whatsapp', configured: false, deliver: NOT_CONFIGURED('whatsapp', 'no Business API account') }),
};

function createChannel(name, options) {
  const make = CHANNELS[name];
  if (!make) throw new Error(`unknown channel "${name}" — have ${Object.keys(CHANNELS).join(', ')}`);
  return make(options);
}

/* Attempts every configured channel and reports each outcome separately. One
   channel being unavailable must not stop the others, and must not be silently
   dropped either.
 *
 * `log` is always attempted, whatever the rule configured. None of the design's
 * channels can be reached from here, and a rule that fired where nobody could
 * see it would satisfy the letter of "fires end-to-end" while failing the
 * point of it. So every fire lands somewhere readable, and the channels the
 * rule actually wanted are attempted in addition and reported honestly. */
function deliver(fire, channels = [], options) {
  const attempted = channels.includes('log') ? channels : ['log', ...channels];
  return attempted.map((name) => {
    try {
      return createChannel(name, options).deliver(fire);
    } catch (err) {
      return { channel: name, delivered: false, error: err.message };
    }
  });
}

module.exports = { createChannel, deliver, CHANNELS, logChannel };
