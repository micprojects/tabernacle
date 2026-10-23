import { runSynthetic } from './synthetic.js';

try {
  const [sourceRoot, tabs, windows] = process.argv.slice(2);
  const result = await runSynthetic({
    sourceRoot,
    tabs: Number(tabs),
    windows: Number(windows),
    readers: 2,
  });
  await new Promise((resolve, reject) =>
    process.send({ type: 'result', result }, (error) => (error ? reject(error) : resolve())),
  );
} catch (error) {
  process.send({ type: 'failure', error: error.stack });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
