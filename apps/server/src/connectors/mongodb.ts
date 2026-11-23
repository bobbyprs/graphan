import type { MongoClient, Db, Document } from 'mongodb';
import type { ConnectionConfig, Connector, DbObject, QueryOptions, QueryResult, TableDetails } from './types';
import { buildResult, loadDriver, now } from './util';

type MongoModule = typeof import('mongodb');

/**
 * MongoDB queries are JSON documents (Extended JSON is supported):
 *   { "collection": "orders", "aggregate": [ { "$match": { ... } }, { "$group": { ... } } ] }
 *   { "collection": "orders", "find": { "status": "paid" }, "projection": {...}, "sort": {...}, "limit": 100 }
 * Macros such as $__timeFrom are substituted as {"$date": "..."} before parsing.
 */
export interface MongoQuery {
  collection: string;
  aggregate?: Document[];
  find?: Document;
  projection?: Document;
  sort?: Document;
  limit?: number;
  skip?: number;
}

const WRITE_STAGES = new Set(['$out', '$merge']);

export class MongoConnector implements Connector {
  readonly dialect = 'mongodb' as const;
  private client?: MongoClient;
  private mongo?: MongoModule;

  constructor(private readonly cfg: ConnectionConfig) {}

  async connect() {
    if (this.client) return;
    this.mongo = loadDriver<MongoModule>('mongodb');
    const o = this.cfg.options;
    const uri =
      this.cfg.connectionString ??
      `mongodb://${this.cfg.username ? `${encodeURIComponent(this.cfg.username)}:${encodeURIComponent(this.cfg.password ?? '')}@` : ''}${this.cfg.host ?? 'localhost'}:${this.cfg.port ?? 27017}/${this.cfg.database ?? ''}`;
    this.client = new this.mongo.MongoClient(uri, {
      maxPoolSize: o.poolMax ?? 10,
      minPoolSize: o.poolMin ?? 0,
      maxIdleTimeMS: o.idleTimeoutMs ?? 30_000,
      serverSelectionTimeoutMS: 10_000,
      tls: o.ssl,
      authSource: o.authSource,
      appName: 'graphan',
    });
    await this.client.connect();
  }

  private db(): Db {
    return this.client!.db(this.cfg.database ?? undefined);
  }

  async close() {
    await this.client?.close();
    this.client = undefined;
  }

  async ping() {
    await this.connect();
    const t = now();
    await this.db().command({ ping: 1 });
    return Math.round(performance.now() - t);
  }

  placeholder(i: number) {
    // Params are spliced into the JSON document as EJSON literals by the query builder
    return `__param_${i}__`;
  }

  timeGroupExpr(col: string, s: number) {
    return JSON.stringify({ $dateTrunc: { date: `$${col}`, unit: 'second', binSize: s } });
  }

  quoteIdent(name: string) {
    return name;
  }

  async query(text: string, params: unknown[], opts: QueryOptions): Promise<QueryResult> {
    await this.connect();
    const start = now();
    let body = text;
    params.forEach((p, i) => {
      const lit = p instanceof Date ? JSON.stringify({ $date: p.toISOString() }) : JSON.stringify(p);
      body = body.split(`"__param_${i + 1}__"`).join(lit).split(`__param_${i + 1}__`).join(lit);
    });
    const q = this.mongo!.BSON.EJSON.parse(body, { relaxed: true }) as MongoQuery;
    if (!q.collection) throw new Error('MongoDB query must include "collection"');
    const coll = this.db().collection(q.collection);
    let docs: Document[];
    if (q.aggregate) {
      if (this.cfg.readOnly && q.aggregate.some((st) => Object.keys(st).some((k) => WRITE_STAGES.has(k)))) {
        throw new Error('$out/$merge stages are not permitted on a read-only data source');
      }
      docs = await coll
        .aggregate([...q.aggregate, { $limit: opts.maxRows + 1 }], { maxTimeMS: opts.timeoutMs, allowDiskUse: true })
        .toArray();
    } else {
      docs = await coll
        .find(q.find ?? {}, { projection: q.projection, sort: q.sort, skip: q.skip, maxTimeMS: opts.timeoutMs })
        .limit(Math.min(q.limit ?? opts.maxRows + 1, opts.maxRows + 1))
        .toArray();
    }
    return buildResult(docs as Record<string, unknown>[], opts.maxRows, start);
  }

  async listSchemas() {
    return [this.cfg.database ?? 'test'];
  }

  async listObjects(schema = this.cfg.database ?? 'test'): Promise<DbObject[]> {
    await this.connect();
    const cols = await this.db().listCollections({}, { nameOnly: false }).toArray();
    return cols
      .filter((c) => !c.name.startsWith('system.'))
      .map((c) => ({ schema, name: c.name, kind: (c.type === 'view' ? 'view' : 'collection') as DbObject['kind'] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeTable(schema: string, name: string): Promise<TableDetails> {
    await this.connect();
    const coll = this.db().collection(name);
    const [sample, indexes, count, stats] = await Promise.all([
      coll.aggregate([{ $sample: { size: 100 } }]).toArray(),
      coll.indexes().catch(() => []),
      coll.estimatedDocumentCount(),
      this.db().command({ collStats: name }).catch(() => ({}) as Document),
    ]);
    const fields = new Map<string, Set<string>>();
    for (const d of sample) {
      for (const [k, v] of Object.entries(d)) {
        const t = v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof Date ? 'date' : (v as object)?.constructor?.name === 'ObjectId' ? 'objectId' : typeof v;
        if (!fields.has(k)) fields.set(k, new Set());
        fields.get(k)!.add(t);
      }
    }
    return {
      schema,
      name,
      columns: [...fields.entries()].map(([k, types], i) => ({
        name: k, dataType: [...types].join(' | '), nullable: types.has('null'),
        isPrimaryKey: k === '_id', ordinal: i + 1,
      })),
      indexes: indexes.map((i) => ({
        name: String(i.name), columns: Object.keys(i.key), unique: !!i.unique, primary: i.name === '_id_',
      })),
      foreignKeys: [],
      referencedBy: [],
      stats: { rowCount: count, totalBytes: (stats as Document).size ?? null },
    };
  }

  previewTable(_schema: string, table: string, limit: number, offset: number, opts: QueryOptions) {
    return this.query(JSON.stringify({ collection: table, find: {}, skip: offset, limit }), [], { ...opts, maxRows: limit });
  }

  async completionCatalog(schema?: string) {
    const objs = await this.listObjects(schema);
    const out = [];
    for (const o of objs.slice(0, 200)) {
      const doc = await this.db().collection(o.name).findOne({});
      out.push({ schema: o.schema, table: o.name, columns: doc ? Object.keys(doc) : [] });
    }
    return out;
  }
}
