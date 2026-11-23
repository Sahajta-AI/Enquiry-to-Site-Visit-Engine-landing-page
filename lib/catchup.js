// Go-live catch-up, run once by hand on go-live day (Notion "Go-live: never disturb what's already queued").
// Started from scripts/odoo-catchup.js. preview() only reads; apply() writes only the leads named in it, and only
// what the preview showed for them (it plans again first and finds nothing new to do on a lead that's done).
// Never touched: [TEST] leads, Won leads, leads for another service, leads from before the website, and the leads
// Shubhang set up by hand (HAND_SET, his message of 23 Nov). Nothing is ever removed, marked Done or renamed by hand.
const odoo = require('./odoo');
const ol = require('./odooleads');
const cal = require('./cal');

const SITE_START = '2026-11-18 00:00:00'; // the website's first day on production (UTC, Odoo's format)
const HAND_SET = Array.from({ length: 13 }, (_, i) => 121 + i); // 121 to 133: set up by hand, nothing written
const CALL_STAGES = ['Call Scheduled', 'Qualified', 'Proposal Sent'];
const FIELDS = ['id', 'name', 'stage_id', 'partner_id', 'partner_name', 'contact_name', 'email_from', 'phone', 'user_id',
  'expected_revenue', 'recurring_revenue', 'create_date', odoo.SERVICE_FIELD];

const mask = (e) => (e ? String(e).replace(/^(.).*(@.*)$/, '$1***$2') : '(no email)');
const m2o = (v) => (Array.isArray(v) ? v[0] : v) || null;
const m2oName = (v) => (Array.isArray(v) ? v[1] : '');
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// The title the old code gave a lead: "{Company} ({Name})", or the name alone
const oldTitle = (l) => (tidy(l.partner_name) ? `${tidy(l.partner_name)} (${tidy(l.contact_name)})` : tidy(l.contact_name));

async function openActs(ids) {
  if (!ids.length) return [];
  return (await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', 'in', ids]], ['id', 'res_id', 'summary', 'date_deadline'], { limit: 2000 })) || [];
}

function haveLines(l, acts, tag) {
  return [
    `tag: ${odoo.tagIdsOf(l).includes(tag) ? 'yes' : 'no'}`,
    `Contact: ${m2oName(l.partner_id) || (m2o(l.partner_id) ? 'yes' : 'none')}`,
    `revenue ${Number(l.expected_revenue) || 0} / MRR ${Number(l.recurring_revenue) || 0}`,
    acts.length ? `${acts.length} open reminder(s): ${acts.map(a => `"${a.summary}" ${a.date_deadline}`).join(', ')}` : 'no open reminder'
  ];
}

function warningsFor(acts) {
  const w = [];
  const notOurs = acts.filter(a => !odoo.OUR_REMINDERS.includes(a.summary)).map(a => `"${a.summary}"`);
  if (notOurs.length) w.push(`reminder titles our code doesn't know: ${notOurs.join(', ')}. After go-live a moved or cancelled call won't move or remove these, and adds ours next to them.`);
  if (!acts.length) w.push('no open reminder: from go-live, the 8 am safety net adds "Next step: plan what\'s next for this lead" (unless it\'s in the nudges).');
  return w;
}

// What would change on one lead (reads only). Each step is skipped when the lead already has it.
async function planLead(l, acts, tag, now) {
  const steps = [];
  const warnings = warningsFor(acts);
  if (!odoo.tagIdsOf(l).includes(tag)) steps.push({ kind: 'tag', text: 'add the Warm-Chain System tag' });
  const prefix = String(l.name || '').startsWith(ol.TEST_PREFIX) ? ol.TEST_PREFIX : '';
  if (oldTitle(l) && tidy(l.name) === tidy(prefix + oldTitle(l))) {
    const to = prefix + (tidy(l.partner_name) || tidy(l.contact_name)) + ' – ' + odoo.WARM_CHAIN;
    steps.push({ kind: 'title', to, text: `title "${l.name}" -> "${to}"` });
  }
  if (!m2o(l.partner_id)) steps.push({ kind: 'contact', text: 'link a Contact (an existing one with the same email or phone is used; only a missing one is made)' });

  let call = null;
  if (!acts.length && l.email_from) {
    try {
      const list = await cal.bookingsForEmail(String(l.email_from).trim().toLowerCase());
      call = list.filter(b => b.status === 'accepted' && b.start > now.getTime()).sort((a, b) => a.start - b.start)[0] || null;
    } catch (err) { warnings.push(`couldn't check Cal.com (${err.message}): no call reminders planned`); }
  }
  const stage = m2oName(l.stage_id);
  if (CALL_STAGES.includes(stage) || call) {
    const rev = [];
    if (!(Number(l.expected_revenue) > 0)) rev.push('Expected Revenue 99,000');
    if (!(Number(l.recurring_revenue) > 0)) rev.push('MRR 99,000 Monthly');
    if (rev.length) steps.push({ kind: 'revenue', text: rev.join(' + ') + ' (only while 0)' });
  }
  if (call) steps.push({ kind: 'reminders', start: call.start, text: `the 3 call reminders for the call on ${new Date(call.start).toISOString().slice(0, 16).replace('T', ' ')} UTC` });
  return { id: l.id, name: l.name, email: mask(l.email_from), stage, have: haveLines(l, acts, tag), steps, warnings };
}

// opts.tests: "[TEST] " leads only (for the tests); opts.handSet: override the hand-set list (tests)
async function preview(opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const handSet = o.handSet || HAND_SET;
  const tag = await odoo.warmChainTagId();
  if (!tag) throw new Error('The "Warm-Chain System" tag was not found in Odoo');
  const won = await odoo.stageId(ol.STAGES.won);
  const rows = (await odoo.searchRead('crm.lead', [['name', o.tests ? '=like' : 'not like', o.tests ? ol.TEST_PREFIX + '%' : ol.TEST_PREFIX]], FIELDS, { limit: 1000, order: 'id asc' })) || [];
  const open = rows.filter(l => m2o(l.stage_id) !== won && (o.tests ? String(l.name).startsWith(ol.TEST_PREFIX) : !String(l.name).startsWith(ol.TEST_PREFIX)));
  const acts = await openActs(open.map(l => l.id));
  const actsOf = (id) => acts.filter(a => a.res_id === id);

  const out = { handSet: [], toDo: [], nothingToDo: [], otherService: 0, beforeSite: 0 };
  for (const l of open) {
    const tags = odoo.tagIdsOf(l);
    if (handSet.includes(l.id)) {
      out.handSet.push({ id: l.id, name: l.name, email: mask(l.email_from), stage: m2oName(l.stage_id), have: haveLines(l, actsOf(l.id), tag), warnings: warningsFor(actsOf(l.id)) });
      continue;
    }
    if (tags.some(x => x !== tag)) { out.otherService++; continue; }
    if (!tags.includes(tag) && String(l.create_date || '') < SITE_START) { out.beforeSite++; continue; }
    const p = await planLead(l, actsOf(l.id), tag, now);
    (p.steps.length ? out.toDo : out.nothingToDo).push(p);
  }
  const missing = handSet.filter(id => !open.some(l => l.id === id));
  if (missing.length) out.handSetNotOpen = missing;
  return out;
}

// Writes only the leads named in ids, only the steps a fresh preview still shows. A hand-set lead is refused.
async function apply(ids, opts) {
  const o = opts || {};
  const handSet = o.handSet || HAND_SET;
  const log = [];
  const refused = ids.filter(id => handSet.includes(id));
  if (refused.length) throw new Error('Set up by hand, never written: ' + refused.join(', '));
  const now = o.now || new Date();
  const plan = await preview(o);
  const tag = await odoo.warmChainTagId();
  for (const id of ids) {
    const p = plan.toDo.find(x => x.id === id);
    if (!p) { log.push(`${id}: nothing to do (or not a website lead), skipped`); continue; }
    try {
      const lead = (await odoo.searchRead('crm.lead', [['id', '=', id]], FIELDS, { limit: 1 }))[0];
      const vals = {};
      for (const s of p.steps) {
        if (s.kind === 'tag') vals[odoo.SERVICE_FIELD] = [[4, tag]];
        if (s.kind === 'title') vals.name = s.to;
        if (s.kind === 'contact') {
          vals.partner_id = await ol.ensureContacts({ name: tidy(lead.contact_name) || tidy(lead.partner_name), email: lead.email_from, phone: lead.phone, company: lead.partner_name, test: !!o.tests });
        }
        if (s.kind === 'revenue') {
          if (!(Number(lead.expected_revenue) > 0)) vals.expected_revenue = ol.REVENUE;
          if (!(Number(lead.recurring_revenue) > 0)) {
            vals.recurring_revenue = ol.REVENUE;
            const plan = await odoo.recurringPlanId('Monthly');
            if (plan) vals.recurring_plan = plan;
          }
        }
      }
      if (Object.keys(vals).length) await odoo.write('crm.lead', [id], vals);
      const r = p.steps.find(s => s.kind === 'reminders');
      if (r) await ol._ensureCallReminders({ id, user_id: lead.user_id }, new Date(r.start), now);
      log.push(`${id}: done (${p.steps.map(s => s.kind).join(', ')})`);
    } catch (err) { log.push(`${id}: FAILED (${err.message}); run the preview again before retrying`); }
  }
  return log;
}

module.exports = { preview, apply, HAND_SET, SITE_START };
