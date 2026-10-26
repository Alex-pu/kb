UPDATE roles
SET permissions = (
      (permissions - 'pos:write') ||
      '["pos:read", "shift:open", "shift:close", "restaurant:read", "restaurant:settle"]'::jsonb
    ),
    description = 'Open and close cashier shifts and clear restaurant and bar bills'
WHERE role_key = 'cashier'
   OR LOWER(TRIM(name)) = 'cashier';
