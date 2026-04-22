import { CronScheduler, CronStore } from '../../src/core/cron/index.js';

const start = Date.now();
try {
  const store = new CronStore();
  let jobFired = false;
  const scheduler = new CronScheduler(store, async (payload, job) => {
    console.log('Job executed:', job.name);
    jobFired = true;
  });
  scheduler.start();
  const job = scheduler.addJob({
    name: 'test-job',
    schedule: { kind: 'at', datetime: new Date(Date.now() + 1500).toISOString() },
    payload: { kind: 'systemEvent', event: 'test' },
    sessionTarget: 'isolated',
    enabled: true,
  });
  console.log('Job added:', job.id);
  // Wait 3 seconds for job to fire
  await new Promise(r => setTimeout(r, 3000));
  scheduler.stop();
  if (jobFired) {
    console.log(`TEST 10 CRON SCHEDULER: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 10 CRON SCHEDULER: FAIL - job did not fire');
    process.exit(1);
  }
} catch (err) {
  console.error('TEST 10 CRON SCHEDULER: FAIL', err);
  process.exit(1);
}
