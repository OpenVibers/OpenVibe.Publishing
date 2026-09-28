-- phase: expand
-- Mini wiki: its own tables, then the openvibe-publishing stores it uses.
CREATE TABLE wiki_pages (
    id                 text PRIMARY KEY,
    slug               text NOT NULL UNIQUE,
    owner              text NOT NULL,
    visibility         text NOT NULL DEFAULT 'public',
    state              text NOT NULL DEFAULT 'draft',
    published_revision integer,
    published_at       bigint,
    updated_at         bigint NOT NULL
);
CREATE INDEX wiki_pages_published ON wiki_pages (published_at DESC, id) WHERE state = 'published';
CREATE TABLE wiki_outbox (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    envelope jsonb NOT NULL
);
-- openvibe-publishing/revisions (prefix wiki_page)
CREATE TABLE IF NOT EXISTS wiki_page_revisions (
    id            text PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    number        integer NOT NULL CHECK (number >= 1),
    parent_id     text,
    parent_number integer,
    kind          text NOT NULL CHECK (kind IN ('edit','revert','import')),
    reverted_to   integer,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    content_hash  text NOT NULL,
    author        text,
    message       text,
    created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_page_revisions_entity_num ON wiki_page_revisions (entity_id, number);
CREATE TABLE IF NOT EXISTS wiki_page_drafts (
    entity_id     text COLLATE "C" NOT NULL,
    owner         text COLLATE "C" NOT NULL,
    base_revision integer NOT NULL,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    PRIMARY KEY (entity_id, owner)
);
CREATE INDEX IF NOT EXISTS wiki_page_drafts_updated ON wiki_page_drafts (entity_id, updated_at DESC, owner);
CREATE TABLE IF NOT EXISTS wiki_page_revision_purges (
    entity_id   text COLLATE "C" PRIMARY KEY,
    reason      text NOT NULL,
    purged_by   text,
    purged_at   bigint NOT NULL
);
CREATE OR REPLACE FUNCTION wiki_page_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'wiki_page_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wiki_page_revision_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'wiki_page_revisions rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER wiki_page_revisions_no_update BEFORE UPDATE ON wiki_page_revisions FOR EACH ROW EXECUTE FUNCTION wiki_page_revisions_guard();
CREATE OR REPLACE TRIGGER wiki_page_revisions_no_delete BEFORE DELETE ON wiki_page_revisions FOR EACH ROW EXECUTE FUNCTION wiki_page_revisions_guard();

-- openvibe-publishing/citations (prefix wiki)
CREATE TABLE IF NOT EXISTS wiki_citations (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id      text COLLATE "C" NOT NULL,
    revision       integer NOT NULL CHECK (revision >= 1),
    anchor         text,
    source_item_id text COLLATE "C",
    url            text,
    title          text,
    retrieved_at   timestamptz,
    quote_text     text,
    quote_start    integer,
    quote_end      integer,
    license_note   text,
    carried_from   bigint REFERENCES wiki_citations(id),
    attached_by    text,
    attached_at    bigint NOT NULL,
    CHECK (source_item_id IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS wiki_citations_rev ON wiki_citations (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS wiki_citations_source ON wiki_citations (source_item_id, entity_id, revision, id) WHERE source_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wiki_citations_carried ON wiki_citations (carried_from) WHERE carried_from IS NOT NULL;
CREATE TABLE IF NOT EXISTS wiki_citation_purges (
    entity_id text COLLATE "C" PRIMARY KEY,
    reason    text NOT NULL,
    purged_by text,
    purged_at bigint NOT NULL
);
CREATE OR REPLACE FUNCTION wiki_citations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'wiki_citations rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wiki_citation_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'wiki_citations rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER wiki_citations_no_update BEFORE UPDATE ON wiki_citations FOR EACH ROW EXECUTE FUNCTION wiki_citations_guard();
CREATE OR REPLACE TRIGGER wiki_citations_no_delete BEFORE DELETE ON wiki_citations FOR EACH ROW EXECUTE FUNCTION wiki_citations_guard();

-- openvibe-publishing/seo (prefix wiki_page)
CREATE TABLE IF NOT EXISTS wiki_page_redirects (
    from_path  text COLLATE "C" PRIMARY KEY,
    entity_id  text COLLATE "C" NOT NULL,
    reason     text,
    created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS wiki_page_redirects_entity ON wiki_page_redirects (entity_id, created_at, from_path);

-- openvibe-publishing/authorship (prefix wiki_page)
CREATE TABLE IF NOT EXISTS wiki_page_reviews (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id   text COLLATE "C" NOT NULL,
    revision    integer NOT NULL,
    reviewer    text NOT NULL,
    decision    text NOT NULL CHECK (decision IN ('approved','rejected')),
    note        text,
    reviewed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS wiki_page_reviews_rev ON wiki_page_reviews (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS wiki_page_reviews_entity ON wiki_page_reviews (entity_id, id);
CREATE OR REPLACE FUNCTION wiki_page_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'wiki_page_reviews rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER wiki_page_reviews_no_update BEFORE UPDATE ON wiki_page_reviews FOR EACH ROW EXECUTE FUNCTION wiki_page_reviews_guard();

-- openvibe-publishing/index-hooks (prefix wiki)
CREATE TABLE IF NOT EXISTS wiki_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);
