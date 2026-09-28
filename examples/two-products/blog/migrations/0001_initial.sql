-- phase: expand
-- Mini blog: its own table, then the openvibe-publishing stores it uses.
CREATE TABLE blog_posts (
    id                 text PRIMARY KEY,
    slug               text NOT NULL UNIQUE,
    author_name        text,
    visibility         text NOT NULL DEFAULT 'public',
    state              text NOT NULL DEFAULT 'draft',
    published_revision integer,
    published_at       bigint,
    updated_at         bigint NOT NULL
);
CREATE INDEX blog_posts_published ON blog_posts (published_at DESC, id) WHERE state = 'published';
-- openvibe-publishing/revisions (prefix blog_post)
CREATE TABLE IF NOT EXISTS blog_post_revisions (
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
CREATE UNIQUE INDEX IF NOT EXISTS blog_post_revisions_entity_num ON blog_post_revisions (entity_id, number);
CREATE TABLE IF NOT EXISTS blog_post_drafts (
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
CREATE INDEX IF NOT EXISTS blog_post_drafts_updated ON blog_post_drafts (entity_id, updated_at DESC, owner);
CREATE TABLE IF NOT EXISTS blog_post_revision_purges (
    entity_id   text COLLATE "C" PRIMARY KEY,
    reason      text NOT NULL,
    purged_by   text,
    purged_at   bigint NOT NULL
);
CREATE OR REPLACE FUNCTION blog_post_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'blog_post_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM blog_post_revision_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'blog_post_revisions rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER blog_post_revisions_no_update BEFORE UPDATE ON blog_post_revisions FOR EACH ROW EXECUTE FUNCTION blog_post_revisions_guard();
CREATE OR REPLACE TRIGGER blog_post_revisions_no_delete BEFORE DELETE ON blog_post_revisions FOR EACH ROW EXECUTE FUNCTION blog_post_revisions_guard();

-- openvibe-publishing/citations (prefix blog_post)
CREATE TABLE IF NOT EXISTS blog_post_citations (
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
    carried_from   bigint REFERENCES blog_post_citations(id),
    attached_by    text,
    attached_at    bigint NOT NULL,
    CHECK (source_item_id IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS blog_post_citations_rev ON blog_post_citations (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS blog_post_citations_source ON blog_post_citations (source_item_id, entity_id, revision, id) WHERE source_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS blog_post_citations_carried ON blog_post_citations (carried_from) WHERE carried_from IS NOT NULL;
CREATE TABLE IF NOT EXISTS blog_post_citation_purges (
    entity_id text COLLATE "C" PRIMARY KEY,
    reason    text NOT NULL,
    purged_by text,
    purged_at bigint NOT NULL
);
CREATE OR REPLACE FUNCTION blog_post_citations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'blog_post_citations rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM blog_post_citation_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'blog_post_citations rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER blog_post_citations_no_update BEFORE UPDATE ON blog_post_citations FOR EACH ROW EXECUTE FUNCTION blog_post_citations_guard();
CREATE OR REPLACE TRIGGER blog_post_citations_no_delete BEFORE DELETE ON blog_post_citations FOR EACH ROW EXECUTE FUNCTION blog_post_citations_guard();

-- openvibe-publishing/taxonomy (prefix blog)
CREATE TABLE IF NOT EXISTS blog_terms (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vocabulary  text NOT NULL,
    slug        text NOT NULL,
    name        text NOT NULL,
    parent_id   bigint REFERENCES blog_terms(id),
    description text,
    created_at  bigint NOT NULL,
    UNIQUE (vocabulary, slug)
);
CREATE INDEX IF NOT EXISTS blog_terms_parent ON blog_terms (parent_id, name);
CREATE INDEX IF NOT EXISTS blog_terms_vocab ON blog_terms (vocabulary, name);
CREATE TABLE IF NOT EXISTS blog_term_links (
    entity_id   text COLLATE "C" NOT NULL,
    term_id     bigint NOT NULL REFERENCES blog_terms(id),
    position    integer NOT NULL DEFAULT 0,
    created_at  bigint NOT NULL,
    PRIMARY KEY (entity_id, term_id)
);
CREATE INDEX IF NOT EXISTS blog_term_links_term ON blog_term_links (term_id, entity_id);

-- openvibe-publishing/schedule (prefix blog)
CREATE TABLE IF NOT EXISTS blog_schedule_jobs (
    id          text COLLATE "C" PRIMARY KEY,
    idem_key    text NOT NULL UNIQUE,
    entity_id   text COLLATE "C" NOT NULL,
    action      text NOT NULL CHECK (action IN ('publish','unpublish')),
    revision    integer,
    run_at      bigint NOT NULL,
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
    attempts    integer NOT NULL DEFAULT 0,
    lease_owner text,
    lease_until bigint,
    last_error  text,
    result      jsonb,
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_schedule_jobs_due ON blog_schedule_jobs (run_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS blog_schedule_jobs_lease ON blog_schedule_jobs (lease_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS blog_schedule_jobs_entity ON blog_schedule_jobs (entity_id, run_at, id);

-- openvibe-publishing/media (prefix blog_post)
CREATE TABLE IF NOT EXISTS blog_post_attachments (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    revision      integer,
    media_id      text COLLATE "C" NOT NULL,
    role          text NOT NULL DEFAULT 'inline',
    variant       text,
    alt           text,
    caption       text,
    position      integer NOT NULL DEFAULT 0,
    state         text NOT NULL DEFAULT 'unverified' CHECK (state IN ('unverified','available','broken')),
    broken_reason text CHECK (broken_reason IS NULL OR broken_reason IN ('not_found','deleted','forbidden')),
    checked_at    bigint,
    created_at    bigint NOT NULL,
    CHECK ((state = 'broken') = (broken_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS blog_post_attachments_entity ON blog_post_attachments (entity_id, position, id);
CREATE INDEX IF NOT EXISTS blog_post_attachments_media ON blog_post_attachments (media_id, entity_id);
