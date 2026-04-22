import { CRM } from '../../src/core/business/index.js';

const start = Date.now();
try {
  const crm = new CRM('data/test-business.db');
  const contact = crm.addContact({ name: 'Frank', email: 'frank@test.com', tags: ['owner'], notes: 'Project founder' });
  crm.logInteraction({ contactId: contact.id, type: 'meeting', summary: 'Discussed SUDO-AI v3 launch' });
  const history = crm.getHistory(contact.id);
  console.log('Contact:', contact.name, 'Interactions:', history.length);
  const stats = crm.getStats();
  console.log('CRM Stats:', JSON.stringify(stats));
  if (contact.name === 'Frank' && history.length > 0 && stats.totalContacts > 0) {
    console.log(`TEST 14 BUSINESS CRM: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 14 BUSINESS CRM: FAIL');
    process.exit(1);
  }
  crm.close();
} catch (err) {
  console.error('TEST 14 BUSINESS CRM: FAIL', err);
  process.exit(1);
}
