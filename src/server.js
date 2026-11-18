import { createApp } from './app.js';
import { config, checkConfig } from './config.js';

const problems = checkConfig();
if (problems.length) {
  console.error('The app is not configured yet:\n- ' + problems.join('\n- '));
  process.exit(1);
}
if (config.allowTestLogin) {
  console.warn('WARNING: test login is ON. Anyone with the link can sign in as anyone. Turn it off before real data goes in.');
}

// Log instead of crashing if a stray promise fails.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

createApp().listen(config.port, '0.0.0.0', () => {
  console.log(`R3 Performance Review running on port ${config.port}`);
});
