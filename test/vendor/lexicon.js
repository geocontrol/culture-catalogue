/* Minimal Lexicon validator — a port of string/app/lexicon.py.
 *
 * Local-first clients have to know whether a record is well-formed before
 * anything is queued, so validation cannot live only on the server. This is
 * that same validator, in the browser, checked against the Python one by a
 * shared fixture suite (tests/fixtures/lexicon-cases.json).
 *
 * Environment-neutral by design: it never touches the filesystem or the
 * network. Callers hand it already-parsed lexicon documents — Node reads
 * them from disk, a browser fetches them, a bundler inlines them.
 *
 * CANONICAL COPY. Apps carry copies; copy outward from here.
 */

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
// ATProto DID syntax; the same pattern as string/app/lexicon.py DID_RE and
// both strips. An explicit class, not `.+`, whose meaning differs by language.
const DID_RE = /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/;

/* Python's len() counts code points; JS's .length counts UTF-16 code units,
 * so "🎭".length is 2 where len("🎭") is 1. maxGraphemes is an approximation
 * in both validators (neither segments real graphemes), but the two have to
 * approximate it identically or a record valid on the desk is invalid on the
 * phone. Counting code points is the cheap way to agree with Python. */
export function codePointLength(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export class LexiconError extends Error {}

export class LexiconRegistry {
  constructor() {
    this.docs = {};
  }

  /* Add lexicon documents. Accepts one parsed doc, an array of them, or an
   * object keyed by anything (the NSID is read from each doc's own `id`). */
  load(docs) {
    const list = Array.isArray(docs) ? docs
      : (docs && docs.id ? [docs] : Object.values(docs || {}));
    for (const doc of list) {
      if (doc && doc.id && doc.defs) this.docs[doc.id] = doc;
    }
    return this;
  }

  recordTypes() {
    return Object.entries(this.docs)
      .filter(([, doc]) => doc.defs.main && doc.defs.main.type === 'record')
      .map(([nsid]) => nsid);
  }

  _resolve(ref, currentNsid) {
    let nsid, frag;
    if (ref.startsWith('#')) { nsid = currentNsid; frag = ref.slice(1); }
    else if (ref.includes('#')) { [nsid, frag] = ref.split(/#(.*)/s); }
    else { nsid = ref; frag = 'main'; }
    const doc = this.docs[nsid];
    if (doc === undefined) throw new LexiconError(`unknown lexicon: ${nsid}`);
    const schema = doc.defs[frag];
    if (schema === undefined) throw new LexiconError(`unknown def: ${nsid}#${frag}`);
    return schema;
  }

  /* Returns an array of problems; empty means valid. */
  validateRecord(nsid, body) {
    const doc = this.docs[nsid];
    if (doc === undefined) return [`unknown record type: ${nsid}`];
    const main = doc.defs.main || {};
    if (main.type !== 'record') return [`${nsid} is not a record lexicon`];
    const problems = [];
    this._check(main.record, body, nsid, '$', problems);
    return problems;
  }

  _check(schema, value, nsid, path, problems) {
    const t = schema.type;

    if (t === 'ref') {
      let target;
      try { target = this._resolve(schema.ref, nsid); }
      catch (e) { problems.push(`${path}: ${e.message}`); return false; }
      const tnsid = (schema.ref.includes('#') && !schema.ref.startsWith('#'))
        ? schema.ref.split('#')[0] : nsid;
      return this._check(target, value, tnsid, path, problems);
    }

    if (t === 'union') {
      for (const ref of (schema.refs || [])) {
        const trial = [];
        let target;
        try { target = this._resolve(ref, nsid); }
        catch { continue; }
        const tnsid = (ref.includes('#') && !ref.startsWith('#')) ? ref.split('#')[0] : nsid;
        if (this._check(target, value, tnsid, path, trial) && trial.length === 0) return true;
      }
      problems.push(`${path}: does not match any union variant ${repr(schema.refs)}`);
      return false;
    }

    if (t === 'object') {
      if (!isPlainObject(value)) { problems.push(`${path}: expected object`); return false; }
      let ok = true;
      for (const req of (schema.required || [])) {
        if (!(req in value)) { problems.push(`${path}.${req}: required field missing`); ok = false; }
      }
      const props = schema.properties || {};
      for (const [k, v] of Object.entries(value)) {
        if (k === '$type') continue;
        const sub = props[k];
        if (sub === undefined) continue;      // unknown fields tolerated (forward compat)
        if (!this._check(sub, v, nsid, `${path}.${k}`, problems)) ok = false;
      }
      return ok;
    }

    if (t === 'array') {
      if (!Array.isArray(value)) { problems.push(`${path}: expected array`); return false; }
      const maxlen = schema.maxLength;
      if (maxlen !== undefined && value.length > maxlen) {
        problems.push(`${path}: exceeds maxLength ${maxlen}`);
        return false;
      }
      let ok = true;
      value.forEach((item, i) => {
        if (schema.items && !this._check(schema.items, item, nsid, `${path}[${i}]`, problems)) ok = false;
      });
      return ok;
    }

    if (t === 'string') {
      if (typeof value !== 'string') { problems.push(`${path}: expected string`); return false; }
      if (schema.format === 'datetime' && !DATETIME_RE.test(value)) {
        problems.push(`${path}: not an ISO 8601 datetime: ${repr(value)}`);
        return false;
      }
      if (schema.format === 'did' && !DID_RE.test(value)) {
        problems.push(`${path}: not a DID: ${repr(value)}`);
        return false;
      }
      const maxg = schema.maxGraphemes;
      if (maxg !== undefined && codePointLength(value) > maxg) {
        problems.push(`${path}: exceeds maxGraphemes ${maxg}`);
        return false;
      }
      // knownValues are advisory in Lexicon: unknown values allowed.
      return true;
    }

    if (t === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        problems.push(`${path}: expected integer`); return false;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        problems.push(`${path}: below minimum ${schema.minimum}`); return false;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        problems.push(`${path}: above maximum ${schema.maximum}`); return false;
      }
      return true;
    }

    if (t === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`${path}: expected number`); return false;
      }
      return true;
    }

    if (t === 'boolean') {
      if (typeof value !== 'boolean') { problems.push(`${path}: expected boolean`); return false; }
      return true;
    }

    if (t === 'blob') {
      // blob fields are populated by the PDS at publish time; locally we
      // accept the standard blob object shape without deep checks.
      if (!isPlainObject(value)) { problems.push(`${path}: expected blob object`); return false; }
      return true;
    }

    if (t === 'unknown') return true;

    problems.push(`${path}: unsupported schema type ${repr(t)}`);
    return false;
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* Python renders values in problem messages with repr(); the parity fixtures
 * compare messages verbatim, so reproduce repr() for the shapes that reach a
 * message: strings and the list of union refs. Like Python, a string holding
 * a single quote and no double quote is wrapped in double quotes, and control
 * characters are escaped. */
const REPR_ESCAPES = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

function repr(v) {
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v.replace(/[\\\x00-\x1f\x7f]/g, (c) => REPR_ESCAPES[c]
      ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
    return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
  }
  if (Array.isArray(v)) return `[${v.map(repr).join(', ')}]`;
  if (v === undefined || v === null) return 'None';
  return String(v);
}
