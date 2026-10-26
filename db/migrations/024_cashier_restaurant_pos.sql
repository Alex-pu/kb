UPDATE roles
SET permissions = permissions - 'pos:write',
    description = 'Open and close cashier shifts and clear restaurant and bar bills'
WHERE role_key = 'cashier'
  AND is_system_role = TRUE
  AND permissions ? 'restaurant:settle';
