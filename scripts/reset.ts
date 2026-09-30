/** npm run reset — deletes local workflow state, cycles and lab evidence (per aqe.config.json); the audit log records the reset. */
import { loadConfig } from '../src/platform/config';
import { Store } from '../src/platform/store';
import { resetWorkspace } from '../src/platform/retention';

const store = new Store();
const actor = process.env.AQE_USER || process.env.USER || 'local operator';
const { removed } = resetWorkspace(store, loadConfig(), actor);
console.log(`Reset ${store.home}: removed ${removed.length ? removed.join(', ') : 'nothing'} (audit log kept).`);
