'use strict';
/**
 * openvibe-publishing/taxonomy — tags, terms with slugs and hierarchical categories.
 *
 *   const { createTaxonomy, slugify, schema } = require('openvibe-publishing/taxonomy');
 *   const tax = createTaxonomy(db, { prefix: 'blog' });            // blog_terms, blog_term_links
 *   const cooking = await tax.ensureTerm({ vocabulary: 'category', name: 'Cooking' });
 *   const bread = await tax.ensureTerm({ vocabulary: 'category', name: 'Bread', parentId: cooking.id });
 *   await tax.setTerms('post_1', 'tag', ['sourdough', 'Rye Bread']);      // names or term ids
 *   await tax.ancestors(bread.id);                                          // [Cooking, Bread] — breadcrumbs
 *   await tax.entitiesFor(cooking.id, { includeDescendants: true });
 *
 * Vocabularies are free-form names ('tag', 'category', 'series', …) chosen by the product. Slugs
 * are unique per vocabulary. Hierarchy is a parent pointer; cycles are refused.
 */
const { PublishingError, assertDb, sqlOf, bindHandles, lockKey, boundedLimit, toId, assertPrefix, clockOf, assertEntityId } = require('./internal');

const VOCAB_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** "Crème Brûlée & Co." → "creme-brulee-co". Throws when nothing sluggable remains. */
function slugify(text, { max = 80 } = {}) {
    const s = String(text == null ? '' : text)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max)
        .replace(/-+$/g, '');
    if (!s) throw new TypeError(`cannot make a slug from ${JSON.stringify(text)}`);
    return s;
}

function shape(row) {
    if (!row) return null;
    return { id: row.id, vocabulary: row.vocabulary, slug: row.slug, name: row.name, parentId: row.parent_id, description: row.description };
}

function cleanName(name) {
    return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** The DDL for one prefix (idempotent), for the service's migration file. */
function schema(prefix) {
    assertPrefix(prefix);
    const T = `${prefix}_terms`;
    const L = `${prefix}_term_links`;
    return `CREATE TABLE IF NOT EXISTS ${T} (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vocabulary  text NOT NULL,
    slug        text NOT NULL,
    name        text NOT NULL,
    parent_id   bigint REFERENCES ${T}(id),
    description text,
    created_at  bigint NOT NULL,
    UNIQUE (vocabulary, slug)
);
CREATE INDEX IF NOT EXISTS ${T}_parent ON ${T} (parent_id, name);
CREATE INDEX IF NOT EXISTS ${T}_vocab ON ${T} (vocabulary, name);
CREATE TABLE IF NOT EXISTS ${L} (
    entity_id   text COLLATE "C" NOT NULL,
    term_id     bigint NOT NULL REFERENCES ${T}(id),
    position    integer NOT NULL DEFAULT 0,
    created_at  bigint NOT NULL,
    PRIMARY KEY (entity_id, term_id)
);
CREATE INDEX IF NOT EXISTS ${L}_term ON ${L} (term_id, entity_id);
`;
}

function createTaxonomy(db, { prefix, now } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const sql = sqlOf(db);
    const clock = clockOf(now);
    const T = `${prefix}_terms`;
    const L = `${prefix}_term_links`;
    const t$ = sql.ident(T);
    const l$ = sql.ident(L);
    const lockTree = (t) => lockKey(t, sql, `${T}:tree`);

    function vocabOf(v) {
        if (typeof v !== 'string' || !VOCAB_RE.test(v)) throw new TypeError(`vocabulary must match ${VOCAB_RE}`);
        return v;
    }

    const byId = (h, id) => { const n = toId(id); return n == null ? null : h.maybe(sql`SELECT * FROM ${t$} WHERE id = ${n}`); };
    const bySlug = (h, vocabulary, slug) => h.maybe(sql`SELECT * FROM ${t$} WHERE vocabulary = ${vocabulary} AND slug = ${String(slug)}`);

    async function mustGet(h, id) {
        const row = await byId(h, id);
        if (!row) throw new PublishingError(404, 'term.not_found', `No term ${id}`);
        return row;
    }

    const ancestorsSql = (id) => sql`WITH RECURSIVE up(id, parent_id, depth) AS (
            SELECT id, parent_id, 0 FROM ${t$} WHERE id = ${id}
            UNION ALL SELECT t.id, t.parent_id, up.depth + 1 FROM ${t$} t JOIN up ON t.id = up.parent_id WHERE up.depth < 64)
        SELECT t.* FROM up JOIN ${t$} t ON t.id = up.id ORDER BY up.depth DESC`;
    const descendantIds = (id) => sql`WITH RECURSIVE down(id, depth) AS (
            SELECT id, 0 FROM ${t$} WHERE id = ${id}
            UNION ALL SELECT t.id, down.depth + 1 FROM ${t$} t JOIN down ON t.parent_id = down.id WHERE down.depth < 64)`;

    async function checkParent(h, termId, parentId, vocabulary) {
        if (parentId == null) return null;
        const parent = await mustGet(h, parentId);
        if (parent.vocabulary !== vocabulary) throw new PublishingError(400, 'term.parent_vocabulary', 'A parent must be in the same vocabulary');
        if (termId != null) {
            const chain = (await h.many(ancestorsSql(parent.id))).map((r) => r.id);
            if (chain.includes(Number(termId))) throw new PublishingError(400, 'term.cycle', 'That parent would create a cycle');
        }
        return parent.id;
    }

    async function termsFor(h, entityId, vocabulary, limit) {
        const only = vocabulary ? sql` AND t.vocabulary = ${vocabulary}` : sql``;
        return (await h.many(sql`SELECT t.*, l.position FROM ${l$} l JOIN ${t$} t ON t.id = l.term_id
            WHERE l.entity_id = ${entityId}${only} ORDER BY t.vocabulary, l.position, t.name LIMIT ${boundedLimit(limit)}`)).map(shape);
    }

    const impl = {
        async get(h, id) { return shape(await byId(h, id)); },
        async bySlug(h, vocabulary, slug) { return shape(await bySlug(h, vocabOf(vocabulary), slug)); },

        /** Get-or-create by slug (derived from name unless given). The existing term is returned unchanged. */
        async ensureTerm(h, { vocabulary, name, slug, parentId = null, description = null } = {}) {
            vocabOf(vocabulary);
            const label = cleanName(name);
            if (!label) throw new TypeError('name is required');
            const s = slug ? slugify(slug) : slugify(label);
            const existing = await bySlug(h, vocabulary, s);
            if (existing) return shape(existing);
            const pid = await checkParent(h, null, parentId, vocabulary);
            const row = await h.maybe(sql`INSERT INTO ${t$} (vocabulary, slug, name, parent_id, description, created_at)
                VALUES (${vocabulary}, ${s}, ${label}, ${pid}, ${description == null ? null : String(description)}, ${clock()})
                ON CONFLICT (vocabulary, slug) DO NOTHING RETURNING *`);
            return shape(row || await bySlug(h, vocabulary, s));   // a concurrent ensureTerm won: theirs is the term
        },

        async rename(h, id, name) {
            const label = cleanName(name);
            if (!label) { await mustGet(h, id); throw new TypeError('name is required'); }
            const n = toId(id);
            const row = n == null ? null : await h.maybe(sql`UPDATE ${t$} SET name = ${label} WHERE id = ${n} RETURNING *`);
            if (!row) throw new PublishingError(404, 'term.not_found', `No term ${id}`);
            return shape(row);
        },

        /** Re-parent a term. Tree changes of one taxonomy take turns, so two moves cannot make a cycle together. */
        async setParent(h, id, parentId) {
            return h.tx(async (t) => {
                await lockTree(t);
                const term = await mustGet(t, id);
                if (parentId != null && Number(parentId) === term.id) throw new PublishingError(400, 'term.cycle', 'A term cannot be its own parent');
                const pid = await checkParent(t, term.id, parentId, term.vocabulary);
                return shape(await t.one(sql`UPDATE ${t$} SET parent_id = ${pid}::bigint WHERE id = ${term.id} RETURNING *`));
            });
        },

        /** Root first, the term itself last: a breadcrumb trail. */
        async ancestors(h, id) { const n = toId(id); return n == null ? [] : (await h.many(ancestorsSql(n))).map(shape); },
        async descendants(h, id, { limit = 1000 } = {}) {
            const n = toId(id);
            if (n == null) return [];
            return (await h.many(sql`${descendantIds(n)}
                SELECT t.* FROM down JOIN ${t$} t ON t.id = down.id WHERE down.depth > 0 ORDER BY t.name, t.id LIMIT ${boundedLimit(limit)}`)).map(shape);
        },
        async children(h, id, { limit = 1000 } = {}) {
            const n = toId(id);
            if (n == null) return [];
            return (await h.many(sql`SELECT * FROM ${t$} WHERE parent_id = ${n} ORDER BY name, id LIMIT ${boundedLimit(limit)}`)).map(shape);
        },

        /** Nested tree of a vocabulary: [{ ...term, children: [...] }]. */
        async tree(h, vocabulary, { limit = 10000 } = {}) {
            const rows = (await h.many(sql`SELECT * FROM ${t$} WHERE vocabulary = ${vocabOf(vocabulary)} ORDER BY name, id LIMIT ${boundedLimit(limit, 10000, 10000)}`))
                .map((r) => ({ ...shape(r), children: [] }));
            const nodes = new Map(rows.map((r) => [r.id, r]));
            const roots = [];
            for (const r of rows) (r.parentId != null && nodes.has(r.parentId) ? nodes.get(r.parentId).children : roots).push(r);
            return roots;
        },

        /** Terms of a vocabulary by name. Keyset pages: `after` is the last term of the previous page. */
        async terms(h, vocabulary, { limit = 1000, after = null } = {}) {
            vocabOf(vocabulary);
            let cursor = sql``;
            if (after) {
                const aid = toId(after.id);
                if (aid == null || typeof after.name !== 'string') throw new TypeError('after must be a term from the previous page');
                cursor = sql` AND (name, id) > (${after.name}, ${aid}::bigint)`;
            }
            return (await h.many(sql`SELECT * FROM ${t$} WHERE vocabulary = ${vocabulary}${cursor} ORDER BY name, id LIMIT ${boundedLimit(limit)}`)).map(shape);
        },

        /**
         * Replace the entity's terms in one vocabulary. Items are term ids or names (created on
         * demand). A fixed number of statements whatever the number of items.
         */
        async setTerms(h, entityId, vocabulary, items = []) {
            assertEntityId(entityId);
            vocabOf(vocabulary);
            // Validate everything before the first statement.
            const wanted = items.map((item) => {
                if (typeof item === 'number') return { id: item };
                const label = cleanName(item);
                return { slug: slugify(label), label };
            });
            return h.tx(async (t) => {
                await lockKey(t, sql, `${L}:${entityId}:${vocabulary}`);
                await t.exec(sql`DELETE FROM ${l$} WHERE entity_id = ${entityId} AND term_id IN (SELECT id FROM ${t$} WHERE vocabulary = ${vocabulary})`);
                const ids = [...new Set(wanted.filter((w) => w.id != null).map((w) => w.id))];
                const byNumber = new Map();
                const validIds = ids.map(toId).filter((n) => n != null);
                if (validIds.length) {
                    for (const r of await t.many(sql`SELECT * FROM ${t$} WHERE id = ANY(${validIds}::bigint[])`)) byNumber.set(r.id, r);
                }
                const named = new Map();   // slug → label of its first occurrence
                for (const w of wanted) if (w.slug && !named.has(w.slug)) named.set(w.slug, w.label);
                const bySlugs = new Map();
                if (named.size) {
                    const slugs = [...named.keys()].sort();   // one insert order for every writer: no lock-order deadlock
                    await t.exec(sql`INSERT INTO ${t$} (vocabulary, slug, name, created_at)
                        SELECT ${vocabulary}, s, n, ${clock()}::bigint FROM unnest(${slugs}::text[], ${slugs.map((k) => named.get(k))}::text[]) AS x(s, n)
                        ON CONFLICT (vocabulary, slug) DO NOTHING`);
                    for (const r of await t.many(sql`SELECT * FROM ${t$} WHERE vocabulary = ${vocabulary} AND slug = ANY(${slugs}::text[])`)) bySlugs.set(r.slug, r);
                }
                const at = clock();
                const seen = new Set();
                const links = [];
                wanted.forEach((w, i) => {
                    const term = w.id != null ? byNumber.get(toId(w.id)) : bySlugs.get(w.slug);
                    if (!term) throw new PublishingError(404, 'term.not_found', `No term ${w.id}`);
                    if (term.vocabulary !== vocabulary) throw new PublishingError(400, 'term.vocabulary_mismatch', `Term ${term.id} is not a ${vocabulary}`);
                    if (seen.has(term.id)) return;
                    seen.add(term.id);
                    links.push({ entity_id: entityId, term_id: term.id, position: i, created_at: at });
                });
                if (links.length) await t.exec(sql`INSERT INTO ${l$} ${sql.insert(links)} ON CONFLICT DO NOTHING`);
                return termsFor(t, entityId, vocabulary, 10000);
            });
        },

        async termsFor(h, entityId, vocabulary, { limit = 1000 } = {}) {
            return termsFor(h, assertEntityId(entityId), vocabulary || null, limit);
        },

        /** The terms of several entities in one query (a feed's tags): entityIds (up to 1000) → term lists, same order. */
        async termsForMany(h, entityIds = [], vocabulary = null, { limit = 10000 } = {}) {
            if (!Array.isArray(entityIds)) throw new TypeError('entityIds must be an array');
            if (entityIds.length > 1000) throw new TypeError('at most 1000 entity ids per call');
            const ids = [...new Set(entityIds.map((e) => assertEntityId(e)))];
            const by = new Map();
            if (ids.length) {
                const only = vocabulary ? sql` AND t.vocabulary = ${vocabOf(vocabulary)}` : sql``;
                const rows = await h.many(sql`SELECT t.*, l.entity_id AS linked_entity, l.position FROM ${l$} l JOIN ${t$} t ON t.id = l.term_id
                    WHERE l.entity_id = ANY(${ids}::text[])${only} ORDER BY l.entity_id, t.vocabulary, l.position, t.name LIMIT ${boundedLimit(limit, 10000, 10000)}`);
                for (const r of rows) {
                    if (!by.has(r.linked_entity)) by.set(r.linked_entity, []);
                    by.get(r.linked_entity).push(shape(r));
                }
            }
            return entityIds.map((e) => by.get(e) || []);
        },

        /**
         * Entity ids tagged with the term (and, optionally, any of its descendants), in one query.
         * Keyset pages: `after` is the last entity id of the previous page.
         */
        async entitiesFor(h, termId, { includeDescendants = false, limit = 1000, after = null } = {}) {
            const n = toId(termId);
            if (n == null) return [];
            const cursor = after == null ? sql`` : sql` AND entity_id > ${String(after)}`;
            const lim = boundedLimit(limit);
            const rows = includeDescendants
                ? await h.many(sql`${descendantIds(n)}
                    SELECT DISTINCT entity_id FROM ${l$} WHERE term_id IN (SELECT id FROM down)${cursor} ORDER BY entity_id LIMIT ${lim}`)
                : await h.many(sql`SELECT entity_id FROM ${l$} WHERE term_id = ${n}${cursor} ORDER BY entity_id LIMIT ${lim}`);
            return rows.map((r) => r.entity_id);
        },

        /** Remove a term: its children move up to its parent, its links are dropped. */
        async remove(h, id) {
            await h.tx(async (t) => {
                await lockTree(t);
                const term = await mustGet(t, id);
                await t.exec(sql`UPDATE ${t$} SET parent_id = ${term.parent_id}::bigint WHERE parent_id = ${term.id}`);
                await t.exec(sql`DELETE FROM ${l$} WHERE term_id = ${term.id}`);
                await t.exec(sql`DELETE FROM ${t$} WHERE id = ${term.id}`);
            });
            return true;
        },
    };

    const api = bindHandles(db, impl);
    api.tables = { terms: T, links: L };
    api.schema = () => schema(prefix);
    /** Create the tables where the handle may (tests, PGlite); services put schema() in a migration. */
    api.ensureSchema = async () => { await db.query(schema(prefix)); return api; };
    return api;
}

module.exports = { createTaxonomy, schema, slugify };
