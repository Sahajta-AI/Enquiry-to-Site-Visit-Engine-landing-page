// "Qualified": both answers fit (Backend and Tracking Brief, 5.5). One small function, so the rule changes with one edit.
// Never used in the browser and never part of a reply to the browser. Compare the saved values exactly.
const Q1_FIT = [
  'We run paid ads but leads go cold because follow-up is slow',
  'We run paid ads but too few leads book or attend site visits'
];
const Q2_FIT = [
  'As soon as possible',
  'Within the next 30 days'
];

// The two checks, one per answer (the Odoo Brief splits the rule the same way for its stars)
const q1Fits = (q1) => Q1_FIT.includes(q1);
const q2Fits = (q2) => Q2_FIT.includes(q2);

function isQualified(q1, q2) {
  return q1Fits(q1) && q2Fits(q2);
}

// Every value the form can save (v1.3, 6.2): the server accepts only these
const Q1_VALUES = [...Q1_FIT, 'We have an active residential project and are about to start ads', 'We are still planning or exploring'];
const Q2_VALUES = [...Q2_FIT, 'Within the next 1 to 3 months', 'I am only exploring right now'];

module.exports = { isQualified, q1Fits, q2Fits, Q1_VALUES, Q2_VALUES };
