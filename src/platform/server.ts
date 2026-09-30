import { loadConfig } from './config';
import { startPlatform } from './app';

const config = loadConfig();
startPlatform(config.platformPort, { config }).then(({ url, store }) => {
  console.log(`Agentic QE platform running at ${url}  (state: ${store.home})`);
});
