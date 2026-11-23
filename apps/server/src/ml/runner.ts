import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { trainRegression, MlError, type TrainOptions, type TrainResult } from './automl';

type Row = Record<string, unknown>;

export interface MlTasks {
  train: { input: { rows: Row[]; columns: string[]; options: TrainOptions }; output: TrainResult };
}

export function runTaskInline<K extends keyof MlTasks>(task: K, input: MlTasks[K]['input']): MlTasks[K]['output'] {
  switch (task) {
    case 'train':
      return trainRegression(input.rows, input.columns, input.options);
  }
  throw new Error(`Unknown ML task ${String(task)}`);
}

const isTs = __filename.endsWith('.ts');
const workerFile = path.join(__dirname, isTs ? 'worker.ts' : 'worker.js');

/**
 * Runs CPU-heavy training in a worker thread so the API event loop stays responsive.
 * Falls back to inline execution if the worker cannot start (e.g. unusual TS loaders in dev).
 */
export function runTask<K extends keyof MlTasks>(task: K, input: MlTasks[K]['input'], timeoutMs = 120_000): Promise<MlTasks[K]['output']> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(workerFile, {
        workerData: { task, input },
        execArgv: isTs && !process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv, '--import', 'tsx'] : process.execArgv,
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
      });
    } catch {
      return inline();
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new MlError(`Training exceeded ${Math.round(timeoutMs / 1000)} s — reduce rows, features or models`));
    }, timeoutMs);
    worker.once('message', (msg: { ok: true; result: MlTasks[K]['output'] } | { ok: false; error: string; userError: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (msg.ok) resolve(msg.result);
      else reject(msg.userError ? new MlError(msg.error) : new Error(msg.error));
    });
    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Loader / startup failures: run inline rather than failing the request
      if (/ERR_UNKNOWN_FILE_EXTENSION|Cannot find module|ERR_MODULE_NOT_FOUND/.test(String((err as NodeJS.ErrnoException).code ?? err.message))) inline();
      else reject(err);
    });

    function inline() {
      try {
        resolve(runTaskInline(task, input));
      } catch (e) {
        reject(e);
      }
    }
  });
}
