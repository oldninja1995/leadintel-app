/* Creative Intelligence. AUTHORED — see PHASES.md, Phase 1.
 * UGC video 03 is the creative the Analytics Engine page cites as taking 60%
 * of the Munnar Honeymoon ad set budget, so it leads here. */

const { UP, DOWN, WARN, NA } = require('./_tokens');

const GRAD = {
  hill: 'linear-gradient(135deg,#2b2741,#5d5294)',
  lake: 'linear-gradient(135deg,#26305e,#4c5397)',
  spice: 'linear-gradient(135deg,#3f3a2a,#7a6a45)',
  rain: 'linear-gradient(135deg,#23313a,#446070)',
  suite: 'linear-gradient(135deg,#3a2a35,#7a4f68)',
  boat: 'linear-gradient(135deg,#233a33,#3f7a63)',
};

module.exports = {
  creatives: [
    { go: '/creatives?cr=1', title: 'UGC video 03 — honeymoon walkthrough', type: 'Video', icon: 'ph-fill ph-play-circle', grad: GRAD.hill, dur: '0:34', platform: 'Meta', hook: '0:03 infinity pool reveal', hookRate: '38.2%', ctr: '3.41%', spend: '₹1.26L', bookings: '58', rev: '₹6.10L', roas: '4.8x', roasColor: UP, fatigue: '42', fatigueBg: 'rgba(120,200,150,.18)', fatigueColor: UP, winning: '78%' },
    { go: '/creatives?cr=1', title: 'Houseboat sunset — reel cut', type: 'Reel', icon: 'ph-fill ph-play-circle', grad: GRAD.boat, dur: '0:22', platform: 'Meta', hook: '0:02 deck pan', hookRate: '34.7%', ctr: '3.02%', spend: '₹0.94L', bookings: '41', rev: '₹4.20L', roas: '4.5x', roasColor: UP, fatigue: '51', fatigueBg: 'rgba(200,190,120,.18)', fatigueColor: WARN, winning: '71%' },
    { go: '/creatives?cr=1', title: 'Ayurveda retreat — carousel', type: 'Carousel', icon: 'ph-fill ph-images', grad: GRAD.spice, dur: '5 cards', platform: 'Google', hook: 'Card 1 therapy room', hookRate: '—', ctr: '2.64%', spend: '₹0.88L', bookings: '29', rev: '₹2.90L', roas: '3.3x', roasColor: NA, fatigue: '38', fatigueBg: 'rgba(120,200,150,.18)', fatigueColor: UP, winning: '62%' },
    { go: '/creatives?cr=1', title: 'Monsoon package — static', type: 'Static', icon: 'ph-fill ph-image', grad: GRAD.rain, dur: '—', platform: 'Meta', hook: 'Headline led', hookRate: '—', ctr: '1.88%', spend: '₹0.72L', bookings: '14', rev: '₹1.20L', roas: '1.7x', roasColor: DOWN, fatigue: '71', fatigueBg: 'rgba(220,140,140,.18)', fatigueColor: DOWN, winning: '28%' },
    { go: '/creatives?cr=1', title: 'Lake villa suite tour', type: 'Video', icon: 'ph-fill ph-play-circle', grad: GRAD.lake, dur: '0:41', platform: 'Meta', hook: '0:04 balcony reveal', hookRate: '29.4%', ctr: '2.71%', spend: '₹0.81L', bookings: '26', rev: '₹2.70L', roas: '3.3x', roasColor: NA, fatigue: '46', fatigueBg: 'rgba(200,190,120,.18)', fatigueColor: WARN, winning: '58%' },
    { go: '/creatives?cr=1', title: 'Anniversary suite — testimonial', type: 'Video', icon: 'ph-fill ph-play-circle', grad: GRAD.suite, dur: '0:28', platform: 'Meta', hook: '0:02 guest to camera', hookRate: '31.8%', ctr: '2.94%', spend: '₹0.58L', bookings: '22', rev: '₹2.40L', roas: '4.1x', roasColor: UP, fatigue: '33', fatigueBg: 'rgba(120,200,150,.18)', fatigueColor: UP, winning: '66%' },
  ],
};
