-- Levonis migration 0090 — two tables the /auth screen needed.
-- NONDESTRUCTIVE: both are new. Nothing existing is touched.
--
-- 1. signup_tickets — PROOF OF A DESTINATION, HELD FOR FIFTEEN MINUTES.
--
-- A phone number could sign IN to this shop and could not sign UP with one
-- unless the person went through Telegram. That is not a policy, it is an
-- accident of which flow was built first, and it left a real customer holding
-- a number the shop could reach looking at a screen that said "no verified
-- account with this number" with nothing to do about it.
--
-- Creating an account on a destination needs TWO things: proof that the person
-- controls it, and the account details. `auth_otp` proves the first and is
-- consumed the moment it does — single-use is the whole point of it. This
-- table is where that proof waits while the person types a name.
--
-- IT IS NOT A SESSION AND MUST NEVER BECOME ONE. A row authorises exactly one
-- thing: creating one account on this one destination. It carries no user id
-- because no user exists yet, and it is consumed by the insert that creates
-- one, in the same batch, so a ticket can never make two accounts.
--
-- 2. blocked_terms — THE WORDS THE OWNER DOES NOT WANT NEXT TO THEIR SHOP.
--
-- Seeded from worker/lib/nameGuard.ts, which is also the floor that applies
-- when this table is missing. `scope` is the safety story, not a detail:
-- 'word' matches only between non-letters, which is what keeps «كس» from
-- rejecting «مكسور» and `ass` from rejecting `Cassandra`. A term moved to
-- 'any' without reading the note at the top of that file is a real customer
-- refused their own name.
--
-- Rows the owner adds carry owner_added = 1, and the seed below is
-- INSERT OR IGNORE, so a correction of theirs is never reset by a re-run.

CREATE TABLE IF NOT EXISTS signup_tickets (
  id TEXT PRIMARY KEY,
  -- sha256 of the opaque token handed to the browser. The token itself is
  -- never stored, for the same reason an OTP is not: a readable table is a
  -- table that hands out accounts if it is ever read.
  token_hash TEXT NOT NULL UNIQUE,
  -- The same two channels `auth_otp` carries, and for the same reason: a
  -- ticket is only ever issued by a consumed code from one of them. Telegram
  -- is absent deliberately — it proves ownership its own way and creates the
  -- account in `/telegram/complete`, so a ticket there would be a second road
  -- to the same place and a second thing to keep correct.
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  -- NORMALIZED: lowercased email, or E.164 exactly as worker/lib/phone.ts
  -- produces it. It is what the account will be created ON, so a different
  -- spelling here is a different account.
  destination TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

-- The lookup is by token, which is already UNIQUE. This index is the sweeper's
-- (worker/lib/jobs.ts prunes past expires_at on the */15 cron), and it matters
-- for the same reason auth_otp's does: an unswept table of proofs grows.
CREATE INDEX IF NOT EXISTS idx_signup_tickets_expires ON signup_tickets(expires_at);

CREATE TABLE IF NOT EXISTS blocked_terms (
  -- Stored NORMALIZED (folded, no diacritics), so «قندرة» and «قندره» are one
  -- row and the owner never has to think about spelling variants.
  term TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('word', 'any')),
  owner_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('fuck', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('fuk', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('fuq', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('phuck', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('shit', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('bitch', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('cunt', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('whore', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('slut', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('asshole', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('bastard', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('nigger', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('nigga', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('faggot', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('wanker', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('pussy', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('dickhead', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('motherfucker', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('rapist', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('porno', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('fk', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('fck', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('fak', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('ass', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('arse', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('cock', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('dick', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('tits', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('hoe', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('rape', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('penis', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('vagina', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('porn', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('sex', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('stfu', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('wtf', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('شرموط', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('شرموطه', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('قحبه', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('كحبه', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('منيوك', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('منيوج', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('منيوچ', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('كسمك', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('كسمج', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('كسختك', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('ديوث', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('صرمايه', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('عرصات', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('طيزك', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('زبي', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('متناك', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('خرايي', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('كس', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('كسم', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('عير', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('عيري', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('ايري', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('ايره', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('نيج', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('نيك', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('نيچ', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('خرا', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('خره', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('بلاع', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('مطي', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('حمار', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('حمير', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('قندره', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('زربه', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('طيز', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('زب', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('عرص', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('خول', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('لوطي', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('زقه', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('kos', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('kus', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('koss', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('kosom', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('kusom', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('ayre', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('ayri', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('neek', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('neik', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('manyak', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('manyuk', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('sharmoot', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('sharmota', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('gahba', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('qahba', 'any', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('khara', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('5ara', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('7mar', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('3ars', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('zobi', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('zubi', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('teez', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('كير', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('قون', 'word', 0);
INSERT OR IGNORE INTO blocked_terms (term, scope, owner_added) VALUES ('كوس', 'word', 0);
