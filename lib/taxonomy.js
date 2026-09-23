'use strict';
/**
 * openvibe-publishing/taxonomy — tags, terms with slugs and hierarchical categories.
 *
 *   const { createTaxonomy, slugify } = require('openvibe-publishing/taxonomy');
 *   const tax = createTaxonomy(db, { prefix: 'blog' });            // blog_terms, blog_term_links
 *   const cooking = tax.ensureTerm({ vocabulary: 'category', name: 'Cooking' });
 *   const bread = tax.ensureTerm({ vocabulary: 'category', name: 'Bread', parentId: cooking.id });
 *   tax.setTerms('post_1', 'tag', ['sourdough', 'Rye Bread']);      // names or term ids
 *   tax.ancestors(bread.id);                                          // [Cooking, Bread] — breadcrumbs
 *   tax.entitiesFor(cooking.id, { includeDescendants: true });
 *
 * Vocabularies are free-form names ('tag', 'category', 'series', …) chosen by the product. Slugs
 * are unique per vocabulary. Hierarchy is a parent pointer; cycles are refused.
 */
const { PublishingError, assertDb, assertPrefix, clockOf, assertEntityId } = require('./internal');

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

function createTaxonomy(db, { prefix, now } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const clock = clockOf(now);
    const T = `${prefix}_terms`;
    const L = `${prefix}_term_links`;

    db.exec(`
        CREATE TABLE IF NOT EXISTS ${T} (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            vocabulary  TEXT NOT NULL,
            slug        TEXT NOT NULL,
            name        TEXT NOT NULL,
            parent_id   INTEGER REFERENCES ${T}(id),
            description TEXT,
            created_at  INTEGER NOT NULL,
            UNIQUE (vocabulary, slug)
        );
        CREATE INDEX IF NOT EXISTS ${T}_parent ON ${T} (parent_id);
        CREATE TABLE IF NOT EXISTS ${L} (
            entity_id   TEXT NOT NULL,
            term_id     INTEGER NOT NULL REFERENCES ${T}(id),
            position    INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (entity_id, term_id)
        );
        CREATE INDEX IF NOT EXISTS ${L}_term ON ${L} (term_id);
    `);

    const q = {
        byId: db.prepare(`SELECT * FROM ${T} WHERE id = ?`),
        bySlug: db.prepare(`SELECT * FROM ${T} WHERE vocabulary = ? AND slug = ?`),
        insert: db.prepare(`INSERT INTO ${T} (vocabulary, slug, name, parent_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
        setParent: db.prepare(`UPDATE ${T} SET parent_id = ? WHERE id = ?`),
        rename: db.prepare(`UPDATE ${T} SET name = ? WHERE id = ?`),
        children: db.prepare(`SELECT * FROM ${T} WHERE parent_id = ? ORDER BY name`),
        vocab: db.prepare(`SELECT * FROM ${T} WHERE vocabulary = ? ORDER BY name`),
        ancestors: db.prepare(`WITH RECURSIVE up(id, parent_id, depth) AS (
                                   SELECT id, parent_id, 0 FROM ${T} WHERE id = ?
                                   UNION ALL SELECT t.id, t.parent_id, up.depth + 1 FROM ${T} t JOIN up ON t.id = up.parent_id WHERE up.depth < 64)
                               SELECT t.* FROM up JOIN ${T} t ON t.id = up.id ORDER BY up.depth DESC`),
        descendants: db.prepare(`WITH RECURSIVE down(id, depth) AS (
                                     SELECT id, 0 FROM ${T} WHERE id = ?
                                     UNION ALL SELECT t.id, down.depth + 1 FROM ${T} t JOIN down ON t.parent_id = down.id WHERE down.depth < 64)
                                 SELECT t.* FROM down JOIN ${T} t ON t.id = down.id WHERE down.depth > 0 ORDER BY t.name`),
        linksFor: db.prepare(`SELECT t.*, l.position FROM ${L} l JOIN ${T} t ON t.id = l.term_id WHERE l.entity_id = ? ORDER BY t.vocabulary, l.position, t.name`),
        unlinkVocab: db.prepare(`DELETE FROM ${L} WHERE entity_id = ? AND term_id IN (SELECT id FROM ${T} WHERE vocabulary = ?)`),
        link: db.prepare(`INSERT OR IGNORE INTO ${L} (entity_id, term_id, position, created_at) VALUES (?, ?, ?, ?)`),
        unlinkTerm: db.prepare(`DELETE FROM ${L} WHERE term_id = ?`),
        reparentChildren: db.prepare(`UPDATE ${T} SET parent_id = ? WHERE parent_id = ?`),
        deleteTerm: db.prepare(`DELETE FROM ${T} WHERE id = ?`),
    };

    function vocabOf(v) {
        if (typeof v !== 'string' || !VOCAB_RE.test(v)) throw new TypeError(`vocabulary must match ${VOCAB_RE}`);
        return v;
    }

    function mustGet(id) {
        const row = q.byId.get(Number(id));
        if (!row) throw new PublishingError(404, 'term.not_found', `No term ${id}`);
        return row;
    }

    function checkParent(termId, parentId, vocabulary) {
        if (parentId == null) return null;
        const parent = mustGet(parentId);
        if (parent.vocabulary !== vocabulary) throw new PublishingError(400, 'term.parent_vocabulary', 'A parent must be in the same vocabulary');
        if (termId != null) {
            const chain = q.ancestors.all(parent.id).map((r) => r.id);
            if (chain.includes(Number(termId))) throw new PublishingError(400, 'term.cycle', 'That parent would create a cycle');
        }
        return parent.id;
    }

    const api = {
        tables: { terms: T, links: L },

        get(id) { return shape(q.byId.get(Number(id))); },
        bySlug(vocabulary, slug) { return shape(q.bySlug.get(vocabOf(vocabulary), String(slug))); },

        /** Get-or-create by slug (derived from name unless given). The existing term is returned unchanged. */
        ensureTerm({ vocabulary, name, slug, parentId = null, description = null } = {}) {
            vocabOf(vocabulary);
            const label = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 200);
            if (!label) throw new TypeError('name is required');
            const s = slug ? slugify(slug) : slugify(label);
            return db.transaction(() => {
                const existing = q.bySlug.get(vocabulary, s);
                if (existing) return shape(existing);
                const pid = checkParent(null, parentId, vocabulary);
                const info = q.insert.run(vocabulary, s, label, pid, description, clock());
                return shape(q.byId.get(info.lastInsertRowid));
            })();
        },

        rename(id, name) {
            mustGet(id);
            const label = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            if (!label) throw new TypeError('name is required');
            q.rename.run(label, Number(id));
            return api.get(id);
        },

        setParent(id, parentId) {
            const term = mustGet(id);
            if (parentId != null && Number(parentId) === term.id) throw new PublishingError(400, 'term.cycle', 'A term cannot be its own parent');
            q.setParent.run(checkParent(term.id, parentId, term.vocabulary), term.id);
            return api.get(id);
        },

        /** Root first, the term itself last: a breadcrumb trail. */
        ancestors(id) { return q.ancestors.all(Number(id)).map(shape); },
        descendants(id) { return q.descendants.all(Number(id)).map(shape); },
        children(id) { return q.children.all(Number(id)).map(shape); },

        /** Nested tree of a vocabulary: [{ ...term, children: [...] }]. */
        tree(vocabulary) {
            const rows = q.vocab.all(vocabOf(vocabulary)).map((r) => ({ ...shape(r), children: [] }));
            const byId = new Map(rows.map((r) => [r.id, r]));
            const roots = [];
            for (const r of rows) (r.parentId != null && byId.has(r.parentId) ? byId.get(r.parentId).children : roots).push(r);
            return roots;
        },

        terms(vocabulary) { return q.vocab.all(vocabOf(vocabulary)).map(shape); },

        /** Replace the entity's terms in one vocabulary. Items are term ids or names (created on demand). */
        setTerms(entityId, vocabulary, items = []) {
            assertEntityId(entityId);
            vocabOf(vocabulary);
            return db.transaction(() => {
                q.unlinkVocab.run(entityId, vocabulary);
                const t = clock();
                const seen = new Set();
                items.forEach((item, i) => {
                    const term = typeof item === 'number' ? mustGet(item) : q.bySlug.get(vocabulary, slugify(item)) || q.byId.get(api.ensureTerm({ vocabulary, name: item }).id);
                    if (term.vocabulary !== vocabulary) throw new PublishingError(400, 'term.vocabulary_mismatch', `Term ${term.id} is not a ${vocabulary}`);
                    if (seen.has(term.id)) return;
                    seen.add(term.id);
                    q.link.run(entityId, term.id, i, t);
                });
                return api.termsFor(entityId, vocabulary);
            })();
        },

        termsFor(entityId, vocabulary) {
            const rows = q.linksFor.all(assertEntityId(entityId));
            return rows.filter((r) => !vocabulary || r.vocabulary === vocabulary).map(shape);
        },

        /** Entity ids tagged with the term (and, optionally, any of its descendants). */
        entitiesFor(termId, { includeDescendants = false, limit = 1000 } = {}) {
            const ids = [Number(termId), ...(includeDescendants ? q.descendants.all(Number(termId)).map((r) => r.id) : [])];
            const marks = ids.map(() => '?').join(',');
            return db.prepare(`SELECT DISTINCT entity_id FROM ${L} WHERE term_id IN (${marks}) ORDER BY entity_id LIMIT ?`)
                .all(...ids, Math.max(1, Math.min(10000, limit))).map((r) => r.entity_id);
        },

        /** Remove a term: its children move up to its parent, its links are dropped. */
        remove(id) {
            const term = mustGet(id);
            db.transaction(() => {
                q.reparentChildren.run(term.parent_id, term.id);
                q.unlinkTerm.run(term.id);
                q.deleteTerm.run(term.id);
            })();
            return true;
        },
    };
    return api;
}

module.exports = { createTaxonomy, slugify };
