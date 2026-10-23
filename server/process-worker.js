import { prepare, validateOptions } from './printing.js';
process.once('message', async ({ files, options }) => {
  try { process.send(await prepare(files, validateOptions(options))); }
  catch (error) { process.send({ error: error.message }); }
});
