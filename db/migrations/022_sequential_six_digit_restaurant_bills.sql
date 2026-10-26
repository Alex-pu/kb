CREATE TEMPORARY TABLE restaurant_bill_number_migration ON COMMIT DROP AS
SELECT id,
       bill_number AS old_bill_number,
       LPAD(ROW_NUMBER() OVER (ORDER BY created_at, id)::text, 6, '0') AS new_bill_number
FROM restaurant_checks;

CREATE TABLE IF NOT EXISTS restaurant_bill_number_aliases (
  legacy_bill_number VARCHAR(12) PRIMARY KEY,
  check_id UUID NOT NULL REFERENCES restaurant_checks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO restaurant_bill_number_aliases (legacy_bill_number, check_id)
SELECT old_bill_number, id
FROM restaurant_bill_number_migration
WHERE old_bill_number IS NOT NULL AND old_bill_number <> new_bill_number
ON CONFLICT (legacy_bill_number) DO NOTHING;

UPDATE daraja_payments payment
SET bill_reference = CASE
      WHEN payment.bill_reference = bill.old_bill_number OR payment.bill_reference IS NULL
        THEN bill.new_bill_number
      ELSE payment.bill_reference
    END,
    order_id = CASE
      WHEN payment.order_id = bill.old_bill_number THEN bill.new_bill_number
      ELSE payment.order_id
    END
FROM restaurant_bill_number_migration bill
WHERE payment.bill_reference = bill.old_bill_number
   OR payment.order_id = bill.old_bill_number;

UPDATE restaurant_checks check_row
SET bill_number = bill.new_bill_number
FROM restaurant_bill_number_migration bill
WHERE check_row.id = bill.id;

ALTER SEQUENCE restaurant_bill_number_seq MAXVALUE 999999;

ALTER TABLE restaurant_checks
  ALTER COLUMN bill_number
  SET DEFAULT (LPAD(NEXTVAL('restaurant_bill_number_seq')::text, 6, '0'));

SELECT SETVAL(
  'restaurant_bill_number_seq',
  COALESCE(MAX(new_bill_number::bigint), 1),
  COUNT(*) > 0
)
FROM restaurant_bill_number_migration;
