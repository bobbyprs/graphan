import { parentPort, workerData } from 'node:worker_threads';
import { MlError } from './automl';
import { runTaskInline, type MlTasks } from './runner';

const { task, input } = workerData as { task: keyof MlTasks; input: MlTasks[keyof MlTasks]['input'] };

try {
  parentPort!.postMessage({ ok: true, result: runTaskInline(task, input) });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message, userError: e instanceof MlError });
}
