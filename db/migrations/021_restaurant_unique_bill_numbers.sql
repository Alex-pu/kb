CREATE SEQUENCE IF NOT EXISTS restaurant_bill_number_seq
  AS BIGINT
  START WITH 1
  MAXVALUE 99999999999;

ALTER TABLE restaurant_checks
  ADD COLUMN IF NOT EXISTS bill_number VARCHAR(12);

UPDATE restaurant_checks
SET bill_number = 'B' || LPAD(NEXTVAL('restaurant_bill_number_seq')::text, 11, '0')
WHERE bill_number IS NULL;

ALTER TABLE restaurant_checks
  ALTER COLUMN bill_number SET DEFAULT ('B' || LPAD(NEXTVAL('restaurant_bill_number_seq')::text, 11, '0')),
  ALTER COLUMN bill_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_restaurant_checks_bill_number
  ON restaurant_checks (bill_number);
