/**
 * Safe arithmetic expression engine for custom calculated metrics.
 * No `eval` / `Function`: expressions are tokenised, parsed into an AST and interpreted.
 *
 * Grammar:
 *   expr    := or
 *   or      := and ( '||' and )*
 *   and     := cmp ( '&&' cmp )*
 *   cmp     := add ( ('=='|'!='|'>'|'>='|'<'|'<=') add )?
 *   add     := mul ( ('+'|'-') mul )*
 *   mul     := unary ( ('*'|'/'|'%') unary )*
 *   unary   := ('-'|'!') unary | pow
 *   pow     := primary ( '^' unary )?
 *   primary := number | string | ident | [quoted ident] | func '(' args ')' | '(' expr ')'
 */

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ref'; name: string }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] };

type Token = { t: 'num' | 'str' | 'id' | 'op' | 'lp' | 'rp' | 'comma'; v: string };

const FUNCS: Record<string, (...a: unknown[]) => unknown> = {
  abs: (x) => Math.abs(num(x)),
  round: (x, d = 0) => {
    const p = 10 ** num(d);
    return Math.round(num(x) * p) / p;
  },
  floor: (x) => Math.floor(num(x)),
  ceil: (x) => Math.ceil(num(x)),
  sqrt: (x) => Math.sqrt(num(x)),
  log: (x) => Math.log(num(x)),
  log10: (x) => Math.log10(num(x)),
  exp: (x) => Math.exp(num(x)),
  min: (...a) => Math.min(...a.map(num)),
  max: (...a) => Math.max(...a.map(num)),
  if: (c, a, b) => (c ? a : b),
  coalesce: (...a) => a.find((x) => x !== null && x !== undefined && !(typeof x === 'number' && Number.isNaN(x))) ?? null,
  pct: (a, b) => (num(b) === 0 ? null : (num(a) / num(b)) * 100),
  safediv: (a, b) => (num(b) === 0 ? null : num(a) / num(b)),
  upper: (s) => String(s ?? '').toUpperCase(),
  lower: (s) => String(s ?? '').toLowerCase(),
  concat: (...a) => a.map((x) => String(x ?? '')).join(''),
  year: (d) => new Date(String(d)).getUTCFullYear(),
  month: (d) => new Date(String(d)).getUTCMonth() + 1,
  day: (d) => new Date(String(d)).getUTCDate(),
};

function num(x: unknown): number {
  if (typeof x === 'number') return x;
  if (x === null || x === undefined || x === '') return NaN;
  return Number(x);
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new Error(`Invalid number at ${i}`);
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w.]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if (c === '[') {
      const end = src.indexOf(']', i);
      if (end < 0) throw new Error('Unclosed [');
      out.push({ t: 'id', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error('Unclosed string');
      out.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (c === '(') {
      out.push({ t: 'lp', v: c });
      i++;
    } else if (c === ')') {
      out.push({ t: 'rp', v: c });
      i++;
    } else if (c === ',') {
      out.push({ t: 'comma', v: c });
      i++;
    } else {
      const two = src.slice(i, i + 2);
      if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
        out.push({ t: 'op', v: two });
        i += 2;
      } else if ('+-*/%^<>!'.includes(c)) {
        out.push({ t: 'op', v: c });
        i++;
      } else throw new Error(`Unexpected character "${c}"`);
    }
  }
  return out;
}

class Parser {
  private p = 0;
  constructor(private readonly toks: Token[]) {}
  parse(): Node {
    const n = this.or();
    if (this.p < this.toks.length) throw new Error(`Unexpected token "${this.toks[this.p].v}"`);
    return n;
  }
  private peek(v?: string) {
    const t = this.toks[this.p];
    return t && (v === undefined || t.v === v) ? t : undefined;
  }
  private eatOp(...ops: string[]) {
    const t = this.toks[this.p];
    if (t?.t === 'op' && ops.includes(t.v)) {
      this.p++;
      return t.v;
    }
    return undefined;
  }
  private or(): Node {
    let a = this.and();
    for (let op; (op = this.eatOp('||')); ) a = { k: 'bin', op, a, b: this.and() };
    return a;
  }
  private and(): Node {
    let a = this.cmp();
    for (let op; (op = this.eatOp('&&')); ) a = { k: 'bin', op, a, b: this.cmp() };
    return a;
  }
  private cmp(): Node {
    const a = this.add();
    const op = this.eatOp('==', '!=', '>', '>=', '<', '<=');
    return op ? { k: 'bin', op, a, b: this.add() } : a;
  }
  private add(): Node {
    let a = this.mul();
    for (let op; (op = this.eatOp('+', '-')); ) a = { k: 'bin', op, a, b: this.mul() };
    return a;
  }
  private mul(): Node {
    let a = this.unary();
    for (let op; (op = this.eatOp('*', '/', '%')); ) a = { k: 'bin', op, a, b: this.unary() };
    return a;
  }
  private unary(): Node {
    const op = this.eatOp('-', '!');
    if (op) return { k: 'un', op, a: this.unary() };
    return this.pow();
  }
  private pow(): Node {
    const a = this.primary();
    const op = this.eatOp('^');
    return op ? { k: 'bin', op, a, b: this.unary() } : a;
  }
  private primary(): Node {
    const t = this.toks[this.p++];
    if (!t) throw new Error('Unexpected end of expression');
    if (t.t === 'num') return { k: 'num', v: Number(t.v) };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'lp') {
      const e = this.or();
      if (!this.peek(')')) throw new Error('Expected )');
      this.p++;
      return e;
    }
    if (t.t === 'id') {
      if (this.peek('(')) {
        const fn = t.v.toLowerCase();
        if (!FUNCS[fn]) throw new Error(`Unknown function "${t.v}"`);
        this.p++;
        const args: Node[] = [];
        if (!this.peek(')')) {
          do args.push(this.or());
          while (this.toks[this.p]?.t === 'comma' && ++this.p);
        }
        if (!this.peek(')')) throw new Error('Expected ) after arguments');
        this.p++;
        return { k: 'call', fn, args };
      }
      if (t.v === 'true' || t.v === 'false') return { k: 'num', v: t.v === 'true' ? 1 : 0 };
      if (t.v === 'null') return { k: 'str', v: '' };
      return { k: 'ref', name: t.v };
    }
    throw new Error(`Unexpected token "${t.v}"`);
  }
}

function evalNode(n: Node, row: Record<string, unknown>): unknown {
  switch (n.k) {
    case 'num':
    case 'str':
      return n.v;
    case 'ref':
      return row[n.name] ?? null;
    case 'un': {
      const a = evalNode(n.a, row);
      return n.op === '-' ? -num(a) : !a;
    }
    case 'call':
      return FUNCS[n.fn](...n.args.map((x) => evalNode(x, row)));
    case 'bin': {
      if (n.op === '&&') return evalNode(n.a, row) && evalNode(n.b, row);
      if (n.op === '||') return evalNode(n.a, row) || evalNode(n.b, row);
      const a = evalNode(n.a, row);
      const b = evalNode(n.b, row);
      switch (n.op) {
        case '+':
          return typeof a === 'string' || typeof b === 'string' ? `${a ?? ''}${b ?? ''}` : num(a) + num(b);
        case '-': return num(a) - num(b);
        case '*': return num(a) * num(b);
        case '/': return num(b) === 0 ? null : num(a) / num(b);
        case '%': return num(a) % num(b);
        case '^': return num(a) ** num(b);
        // eslint-disable-next-line eqeqeq
        case '==': return a == b;
        // eslint-disable-next-line eqeqeq
        case '!=': return a != b;
        case '>': return num(a) > num(b);
        case '>=': return num(a) >= num(b);
        case '<': return num(a) < num(b);
        case '<=': return num(a) <= num(b);
      }
    }
  }
  throw new Error('Invalid expression node');
}

export interface CompiledExpression {
  evaluate(row: Record<string, unknown>): unknown;
  references: string[];
}

export function compileExpression(src: string): CompiledExpression {
  if (src.length > 2000) throw new Error('Expression too long');
  const ast = new Parser(tokenize(src)).parse();
  const refs = new Set<string>();
  const walk = (n: Node) => {
    if (n.k === 'ref') refs.add(n.name);
    if (n.k === 'un') walk(n.a);
    if (n.k === 'bin') {
      walk(n.a);
      walk(n.b);
    }
    if (n.k === 'call') n.args.forEach(walk);
  };
  walk(ast);
  return {
    references: [...refs],
    evaluate: (row) => {
      const v = evalNode(ast, row);
      return typeof v === 'number' && !Number.isFinite(v) ? null : v;
    },
  };
}
