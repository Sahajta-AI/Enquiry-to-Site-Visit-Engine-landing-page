#!/usr/bin/env node
/**
 * Go-live catch-up of the open website leads in Odoo. Run once, by hand, on go-live day.
 *
 *   node --env-file=.env scripts/odoo-catchup.js                  preview: reads only, writes nothing
 *   node --env-file=.env scripts/odoo-catchup.js --write --ids=119 writes only those leads, after Shubhang's OK
 *
 * Leads 121 to 133 were set up by hand (Shubhang, 23 Nov): shown in the preview, never written.
 * Guard: in preview, every Odoo call except search_read and every non-GET Cal.com call is blocked; in both modes
 * nothing but Odoo and Cal.com can be reached (no email, no queue, no Redis), Cal.com is only read, and nothing in
 * Odoo can be deleted.
 */
const args = process.argv.slice(2);
const write = args.includes('--write');
const idsArg = (args.find(a => a.startsWith('--ids=')) || '').slice(6);
const ids = idsArg ? idsArg.split(',').map(s => Number(s.trim())).filter(Number.isInteger) : [];
if (write && !ids.length) { console.error('--write needs --ids=1,2,3 (the leads Shubhang approved in the preview)'); process.exit(1); }
if (!process.env.ODOO_API_KEY) { console.error('No ODOO_API_KEY: run with node --env-file=.env'); process.exit(1); }

// Nothing but Odoo and Cal.com; the store stays in memory (never the live Redis)
for (const k of Object.keys(process.env)) if (/^(UPSTASH|KV_|QSTASH|GOOGLE_|RESEND|META_)/.test(k)) delete process.env[k];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  const odooM = u.match(/\/json\/2\/([^/]+)\/([^/?]+)/);
  if (odooM) {
    if (odooM[2] === 'unlink') throw new Error('blocked: nothing is ever deleted by the catch-up');
    if (!write && odooM[2] !== 'search_read') throw new Error(`blocked in preview: ${odooM[1]}/${odooM[2]}`);
    return realFetch(url, opts);
  }
  if (u.startsWith('https://api.cal.com/') && method === 'GET') return realFetch(url, opts);
  throw new Error('blocked: ' + method + ' ' + u.replace(/\?.*/, ''));
};

const catchup = require('../lib/catchup');

(async () => {
  if (!write) {
    const p = await catchup.preview();
    console.log(`CATCH-UP PREVIEW (nothing written) ${new Date().toISOString()}\n`);
    console.log(`Set up by hand, nothing will be written (${p.handSet.length}):`);
    for (const l of p.handSet) {
      console.log(`  #${l.id} ${l.name} | ${l.stage} | ${l.email}`);
      l.have.forEach(h => console.log('     has ' + h));
      l.warnings.forEach(w => console.log('     ! ' + w));
    }
    if (p.handSetNotOpen) console.log(`  (not open any more: ${p.handSetNotOpen.join(', ')})`);
    console.log(`\nWould change (${p.toDo.length}):`);
    for (const l of p.toDo) {
      console.log(`  #${l.id} ${l.name} | ${l.stage} | ${l.email}`);
      l.have.forEach(h => console.log('     has ' + h));
      l.steps.forEach(s => console.log('     + ' + s.text));
      l.warnings.forEach(w => console.log('     ! ' + w));
    }
    console.log(`\nAlready set up, nothing to do (${p.nothingToDo.length}): ${p.nothingToDo.map(l => '#' + l.id).join(', ') || '-'}`);
    p.nothingToDo.forEach(l => l.warnings.forEach(w => console.log(`  #${l.id} ! ${w}`)));
    console.log(`Never touched: ${p.otherService} lead(s) for another service, ${p.beforeSite} from before the website.`);
    return;
  }
  console.log(`CATCH-UP WRITE for ${ids.join(', ')}`);
  (await catchup.apply(ids)).forEach(l => console.log('  ' + l));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
