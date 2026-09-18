-- Levonis migration 0091 — two words the owner types, and the index could not
-- reach.
-- NONDESTRUCTIVE: two guarded inserts into an existing table. Nothing is
-- changed and nothing is removed.
--
-- «طبعات» and «طبعه» are «طابعات» and «طابعه» with the alif dropped — how the
-- word is actually typed in a hurry, and two of the owner's own examples. Both
-- returned NOTHING on the live shop while «طابعه» returned all three printers.
--
-- WHY THE TYPO PASS CANNOT REACH THEM, which is the whole reason this is a row
-- and not a code change. A search is two reads, and the first one fetches the
-- candidate vocabulary by each query token's first TWO characters — that bound
-- is what makes a fuzzy pass affordable at all (docs/SEARCH.md §4). «طبعات»
-- begins «طب» and «طابعات» begins «طا», so the edit-distance pass never sees
-- the word it would have forgiven. A misspelling INSIDE the first two letters
-- is invisible to a prefix scan however generous the budget is.
--
-- Widening the prefix scan to reach it would mean scanning a far larger slice
-- of the vocabulary on EVERY search to rescue a case the owner can fix in one
-- row — which is exactly the trade `search_synonyms` exists to make, and why
-- docs/SEARCH.md §7 calls the vocabulary the owner's rather than the code's.
--
-- INSERT OR IGNORE, like migration 0089's seed: if the owner has already
-- corrected either word through /api/admin/taxonomy/search-vocabulary, their
-- meaning is kept and this is a no-op.

INSERT OR IGNORE INTO search_synonyms (term, canonical, owner_added) VALUES ('طبعات', 'printer', 0);
INSERT OR IGNORE INTO search_synonyms (term, canonical, owner_added) VALUES ('طبعه', 'printer', 0);
