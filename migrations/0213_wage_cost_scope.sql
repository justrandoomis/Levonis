ALTER TABLE finance_wage_targets ADD COLUMN line_ids_json TEXT
  CHECK(line_ids_json IS NULL OR (json_valid(line_ids_json) AND json_type(line_ids_json)='array'))
