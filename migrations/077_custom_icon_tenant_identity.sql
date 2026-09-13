-- custom icon identifiers are tenant-local. The original schema used a global
-- primary key on id, which allowed one account to collide with another account's
-- imported icon identifier. Existing rows are already globally unique, so this
-- migration is lossless while permitting the same id in different accounts.
ALTER TABLE custom_icons
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (user_id, id);
