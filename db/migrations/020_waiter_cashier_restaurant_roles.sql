UPDATE roles
SET permissions = permissions || '["restaurant:read", "restaurant:settle"]'::jsonb
WHERE role_key = 'cashier'
  AND is_system_role = TRUE
  AND NOT (permissions @> '["restaurant:read", "restaurant:settle"]'::jsonb);

INSERT INTO roles (company_id, name, role_key, description, permissions, is_system_role)
SELECT c.id, 'Waiter', 'waiter', 'Create restaurant orders and follow their payment status',
       '["restaurant:read", "restaurant:write"]'::jsonb, TRUE
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM roles r
  WHERE r.company_id = c.id AND r.role_key = 'waiter'
);
