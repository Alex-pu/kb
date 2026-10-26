import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { hash } from "bcryptjs";
import { Pool, type PoolClient } from "pg";

loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ quiet: true });

interface Fixture {
  companyId: string;
  propertyId: string;
  outletId: string;
  stationId: string;
  roleId: string;
  userId: string;
  requesterRoleId: string;
  requesterUserId: string;
  identifier: string;
  password: string;
  pin: string;
  requesterIdentifier: string;
  requesterPassword: string;
}

interface ApiResult {
  response: Response;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectionNeedsSsl(connectionString: string) {
  if (/sslmode=require|sslmode=verify/i.test(connectionString)) return true;
  try {
    const host = new URL(connectionString).hostname;
    return host !== "localhost" && host !== "127.0.0.1" && !host.endsWith(".internal");
  } catch {
    return false;
  }
}

async function seedFixture(pool: Pool): Promise<Fixture> {
  const fixtureKey = randomUUID();
  const fixture: Fixture = {
    companyId: "",
    propertyId: "",
    outletId: "",
    stationId: "",
    roleId: "",
    userId: "",
    requesterRoleId: "",
    requesterUserId: "",
    identifier: `stock-workflow-${fixtureKey}@example.invalid`,
    password: randomBytes(32).toString("base64url"),
    pin: String(randomBytes(2).readUInt16BE(0) % 10000).padStart(4, "0"),
    requesterIdentifier: `stock-requester-${fixtureKey}@example.invalid`,
    requesterPassword: randomBytes(32).toString("base64url"),
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const company = await client.query<{ id: string }>(
      `INSERT INTO companies (name) VALUES ($1) RETURNING id`,
      [`Stock Workflow Test ${fixtureKey}`]
    );
    fixture.companyId = company.rows[0].id;

    const property = await client.query<{ id: string }>(
      `INSERT INTO properties (company_id, name, code, property_type)
       VALUES ($1, $2, $3, 'restaurant') RETURNING id`,
      [fixture.companyId, `Stock Workflow Test ${fixtureKey}`, `SWT-${fixtureKey.slice(0, 8)}`]
    );
    fixture.propertyId = property.rows[0].id;

    const outlet = await client.query<{ id: string }>(
      `INSERT INTO outlets (property_id, name, code, outlet_type)
       VALUES ($1, $2, $3, 'restaurant') RETURNING id`,
      [fixture.propertyId, "Automated stock test outlet", `ST-${fixtureKey.slice(0, 8)}`]
    );
    fixture.outletId = outlet.rows[0].id;

    const station = await client.query<{ id: string }>(
      `INSERT INTO stations (outlet_id, name, station_type)
       VALUES ($1, 'Automated stock test till', 'pos_till') RETURNING id`,
      [fixture.outletId]
    );
    fixture.stationId = station.rows[0].id;

    const role = await client.query<{ id: string }>(
      `INSERT INTO roles (company_id, name, role_key, description, permissions, is_system_role)
       VALUES ($1, 'Stock Workflow Test', 'stock_workflow_test',
               'Temporary role for automated stock workflow tests', $2::jsonb, FALSE)
       RETURNING id`,
      [
        fixture.companyId,
        JSON.stringify(["catalog:manage", "inventory:manage", "pos:write", "restaurant:write", "restaurant:settle", "settings:manage", "shift:open"]),
      ]
    );
    fixture.roleId = role.rows[0].id;

    const user = await client.query<{ id: string }>(
      `INSERT INTO users (company_id, full_name, email, password_hash, pin_hash)
       VALUES ($1, 'Automated Stock Workflow Test', $2, $3, $4) RETURNING id`,
      [fixture.companyId, fixture.identifier, await hash(fixture.password, 10), await hash(fixture.pin, 10)]
    );
    fixture.userId = user.rows[0].id;

    await client.query(
      `INSERT INTO user_assignments (user_id, property_id, outlet_id, station_id, role_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [fixture.userId, fixture.propertyId, fixture.outletId, fixture.stationId, fixture.roleId]
    );

    const requesterRole = await client.query<{ id: string }>(
      `INSERT INTO roles (company_id, name, role_key, description, permissions, is_system_role)
       VALUES ($1, 'Stock Requester Test', 'stock_requester_test',
               'Temporary request-only role for automated stock workflow tests', $2::jsonb, FALSE)
       RETURNING id`,
      [fixture.companyId, JSON.stringify(["inventory:request"])]
    );
    fixture.requesterRoleId = requesterRole.rows[0].id;

    const requesterUser = await client.query<{ id: string }>(
      `INSERT INTO users (company_id, full_name, email, password_hash)
       VALUES ($1, 'Automated Supply Requester', $2, $3) RETURNING id`,
      [fixture.companyId, fixture.requesterIdentifier, await hash(fixture.requesterPassword, 10)]
    );
    fixture.requesterUserId = requesterUser.rows[0].id;

    await client.query(
      `INSERT INTO user_assignments (user_id, property_id, outlet_id, station_id, role_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [fixture.requesterUserId, fixture.propertyId, fixture.outletId, fixture.stationId, fixture.requesterRoleId]
    );
    await client.query("COMMIT");
    return fixture;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixture(pool: Pool, fixture: Fixture) {
  if (!fixture.companyId) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM stock_movements WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM stock_requisition_lines WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM stock_requisitions WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM payments WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM order_lines WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM orders WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM restaurant_check_payments WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM etims_submissions WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM restaurant_checks WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM restaurant_kots WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM shifts WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM stock_levels WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM central_stock_levels WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM item_outlets WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM items WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM categories WHERE property_id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM cashier_outlet_sessions WHERE user_id = $1`, [fixture.userId]);
    await client.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [[fixture.userId, fixture.requesterUserId]]);
    await client.query(`DELETE FROM user_assignments WHERE user_id = ANY($1::uuid[])`, [[fixture.userId, fixture.requesterUserId]]);
    await client.query(`DELETE FROM audit_log WHERE company_id = $1`, [fixture.companyId]);
    await client.query(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [[fixture.roleId, fixture.requesterRoleId]]);
    await client.query(`DELETE FROM stations WHERE id = $1`, [fixture.stationId]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[fixture.userId, fixture.requesterUserId]]);
    await client.query(`DELETE FROM outlets WHERE id = $1`, [fixture.outletId]);
    await client.query(`DELETE FROM properties WHERE id = $1`, [fixture.propertyId]);
    await client.query(`DELETE FROM companies WHERE id = $1`, [fixture.companyId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requestJson(
  baseUrl: string,
  route: string,
  method: "GET" | "POST" | "PATCH",
  body?: Record<string, unknown>,
  cookie?: string
): Promise<ApiResult> {
  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      "user-agent": "stock-workflow-integration-test",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const value: unknown = await response.json();
  assert.ok(isRecord(value), `${method} ${route} returned a non-object response`);
  return { response, body: value };
}

function assertSuccess(result: ApiResult, label: string) {
  assert.equal(
    result.body.success,
    true,
    `${label} failed with HTTP ${result.response.status}: ${String(result.body.message ?? "No error message")}`
  );
}

function responseId(result: ApiResult, label: string) {
  const id = result.body.id;
  if (typeof id !== "string") throw new Error(`${label} response omitted its id`);
  return id;
}

async function postStockAction(
  baseUrl: string,
  cookie: string,
  outletId: string,
  action: string,
  values: Record<string, unknown>
) {
  return requestJson(baseUrl, "/api/stock", "POST", {
    action,
    outlet_id: outletId,
    ...values,
  }, cookie);
}

async function readWorkspace(baseUrl: string, cookie: string, outletId: string) {
  const result = await requestJson(
    baseUrl,
    `/api/stock?outlet_id=${encodeURIComponent(outletId)}`,
    "GET",
    undefined,
    cookie
  );
  assertSuccess(result, "Reloading persisted stock workspace");
  return result.body;
}

function findItem(workspace: Record<string, unknown>, itemId: string) {
  assert.ok(Array.isArray(workspace.items), "Stock response has no items array");
  const item = workspace.items.find((candidate: unknown) => isRecord(candidate) && candidate.id === itemId);
  assert.ok(isRecord(item), "Test item was missing from the stock workspace");
  return item;
}

function findRequisition(workspace: Record<string, unknown>, requisitionId: string) {
  assert.ok(Array.isArray(workspace.requisitions), "Stock response has no requisitions array");
  const requisition = workspace.requisitions.find(
    (candidate: unknown) => isRecord(candidate) && candidate.id === requisitionId
  );
  assert.ok(isRecord(requisition), "Test requisition was missing from the stock workspace");
  return requisition;
}

function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  assert.ok(year && month && day, "Could not determine the current Kenya business date");
  return `${year}-${month}-${day}`;
}

async function runWorkflow(baseUrl: string, fixture: Fixture) {
  const pinLogin = await requestJson(baseUrl, "/api/auth/login", "POST", {
    identifier: fixture.identifier,
    pin: fixture.pin,
  });
  assertSuccess(pinLogin, "Authenticating test cashier with four-digit PIN");
  const pinCookie = pinLogin.response.headers.get("set-cookie");
  assert.ok(pinCookie, "PIN login response did not set a session cookie");
  const pinSession = pinCookie.split(";")[0];
  const changedPassword = `${randomBytes(18).toString("base64url")}Aa1!`;
  const passwordUpdate = await requestJson(baseUrl, "/api/auth/credentials", "PATCH", {
    current_pin: fixture.pin,
    new_password: changedPassword,
  }, pinSession);
  assertSuccess(passwordUpdate, "Changing password from signed-in PIN session");
  const currentAccount = await requestJson(baseUrl, "/api/auth/credentials", "GET", undefined, pinSession);
  assertSuccess(currentAccount, "Keeping current session after credential change");
  fixture.password = changedPassword;
  const pinLogout = await requestJson(baseUrl, "/api/auth/logout", "POST", undefined, pinCookie.split(";")[0]);
  assertSuccess(pinLogout, "Signing out test PIN session");
  console.log("PASS signed-in user changed password with PIN confirmation and kept the current session");

  const login = await requestJson(baseUrl, "/api/auth/login", "POST", {
    identifier: fixture.identifier,
    password: fixture.password,
  });
  assertSuccess(login, "Authenticating temporary test cashier");
  const setCookie = login.response.headers.get("set-cookie");
  assert.ok(setCookie, "Login response did not set a session cookie");
  let cookie = setCookie.split(";")[0];
  assert.ok(cookie.startsWith("kb_session="), "Login response used an unexpected session cookie");
  const changedPin = String(randomBytes(2).readUInt16BE(0) % 10000).padStart(4, "0");
  const pinUpdate = await requestJson(baseUrl, "/api/auth/credentials", "PATCH", {
    current_password: fixture.password,
    new_pin: changedPin,
  }, cookie);
  assertSuccess(pinUpdate, "Changing PIN from signed-in password session");
  fixture.pin = changedPin;
  const pinLogoutAfterChange = await requestJson(baseUrl, "/api/auth/logout", "POST", undefined, cookie);
  assertSuccess(pinLogoutAfterChange, "Signing out after changing PIN");
  const changedPinLogin = await requestJson(baseUrl, "/api/auth/login", "POST", {
    identifier: fixture.identifier,
    pin: fixture.pin,
  });
  assertSuccess(changedPinLogin, "Signing in with the changed four-digit PIN");
  const changedPinCookie = changedPinLogin.response.headers.get("set-cookie");
  assert.ok(changedPinCookie, "Changed PIN login response did not set a session cookie");
  const changedPinLogout = await requestJson(baseUrl, "/api/auth/logout", "POST", undefined, changedPinCookie.split(";")[0]);
  assertSuccess(changedPinLogout, "Signing out changed PIN test session");
  const operationalLogin = await requestJson(baseUrl, "/api/auth/login", "POST", {
    identifier: fixture.identifier,
    password: fixture.password,
  });
  assertSuccess(operationalLogin, "Signing in for cashier workflow tests");
  const operationalCookie = operationalLogin.response.headers.get("set-cookie");
  assert.ok(operationalCookie, "Cashier workflow login response did not set a session cookie");
  cookie = operationalCookie.split(";")[0];
  console.log("PASS signed-in user changed PIN and authenticated with the new PIN");

  const catalog = await requestJson(baseUrl, "/api/pos/catalog", "POST", {
    outlet_id: fixture.outletId,
    name: `Stock workflow item ${randomUUID().slice(0, 8)}`,
    sku: "MANUAL-SKU-SHOULD-BE-IGNORED",
    unit: "test-unit",
    category: "Automated test",
    price: 3.25,
    reorder_level: 0,
    initial_stock_kitchen: 0,
    initial_stock_bar: 0,
    stock_tracked: true,
    prep_station: "kitchen",
  }, cookie);
  assertSuccess(catalog, "Creating tracked test catalog item");
  if (!isRecord(catalog.body.item) || typeof catalog.body.item.id !== "string") {
    throw new Error("Catalog response omitted the item id");
  }
  if (typeof catalog.body.item.sku !== "string" || !/^SKU-\d{6,}$/.test(catalog.body.item.sku)) {
    throw new Error("Catalog response did not include a generated SKU");
  }
  const itemId = catalog.body.item.id;
  const itemSku = catalog.body.item.sku;
  const itemMapping = await requestJson(baseUrl, "/api/pos/catalog", "PATCH", {
    outlet_id: fixture.outletId,
    item_id: itemId,
    etims_item_code: "KE1TEST000001",
    etims_tax_code: "B",
  }, cookie);
  assertSuccess(itemMapping, "Saving eTIMS item mapping");
  const insecureEtimsConfig = await requestJson(baseUrl, "/api/integrations/etims-config", "PATCH", {
    outlet_id: fixture.outletId,
    enabled: true,
    business_name: "Automated test property",
    endpoint: "http://127.0.0.1:8888/api/v1/",
    username: "test-user",
    password: "test-password",
  }, cookie);
  assert.equal(insecureEtimsConfig.response.status, 400, "Insecure HTTP eTIMS endpoint was accepted");

  const concurrentCatalogItems = await Promise.all([1, 2].map((index) =>
    requestJson(baseUrl, "/api/pos/catalog", "POST", {
      outlet_id: fixture.outletId,
      name: `Concurrent SKU test ${index} ${randomUUID().slice(0, 8)}`,
      sku: `MANUAL-SKU-${index}`,
      unit: "each",
      category: "Automated test",
      price: 1,
      stock_tracked: false,
      prep_station: "kitchen",
    }, cookie)
  ));
  for (const result of concurrentCatalogItems) assertSuccess(result, "Creating concurrent SKU test product");
  const allSkus = [
    itemSku,
    ...concurrentCatalogItems.map((result) => {
      if (!isRecord(result.body.item) || typeof result.body.item.sku !== "string") {
        throw new Error("Concurrent catalog response omitted its generated SKU");
      }
      return result.body.item.sku;
    }),
  ];
  assert.ok(allSkus.every((sku) => /^SKU-\d{6,}$/.test(sku)), "A product did not receive an automatic SKU");
  assert.equal(new Set(allSkus).size, allSkus.length, "Concurrent item creation assigned duplicate SKUs");
  console.log("PASS created a tracked test item through the catalog API");
  console.log("PASS ignored manual SKU input and generated unique SKUs during concurrent creation");

  const supplyCatalog = await requestJson(baseUrl, "/api/pos/catalog", "POST", {
    outlet_id: fixture.outletId,
    name: `Non-sale supply ${randomUUID().slice(0, 8)}`,
    item_type: "supply",
    unit: "each",
    category: "Automated test",
    price: 0,
    stock_tracked: true,
    prep_station: "kitchen",
  }, cookie);
  assertSuccess(supplyCatalog, "Creating non-sale supply catalog item");
  if (!isRecord(supplyCatalog.body.item) || typeof supplyCatalog.body.item.id !== "string") {
    throw new Error("Supply catalog response omitted the item id");
  }
  const supplyItemId = supplyCatalog.body.item.id;

  const supplyReceipt = await postStockAction(baseUrl, cookie, fixture.outletId, "receive", {
    item_id: supplyItemId,
    supplier_name: "Automated supplies test",
    quantity: 8,
    unit_cost: 0.5,
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assertSuccess(supplyReceipt, "Receiving non-sale supplies into Central Store");

  const requesterLogin = await requestJson(baseUrl, "/api/auth/login", "POST", {
    identifier: fixture.requesterIdentifier,
    password: fixture.requesterPassword,
  });
  assertSuccess(requesterLogin, "Authenticating supply requester");
  const requesterSetCookie = requesterLogin.response.headers.get("set-cookie");
  assert.ok(requesterSetCookie, "Requester login response did not set a session cookie");
  const requesterCookie = requesterSetCookie.split(";")[0];
  assert.ok(requesterCookie.startsWith("kb_session="), "Requester login response used an unexpected session cookie");

  const requesterWorkspace = await requestJson(
    baseUrl,
    `/api/stock/requests?outlet_id=${encodeURIComponent(fixture.outletId)}`,
    "GET",
    undefined,
    requesterCookie
  );
  assertSuccess(requesterWorkspace, "Loading request-only supplies workspace");
  assert.ok(Array.isArray(requesterWorkspace.body.supplies));
  const requestableSupply = requesterWorkspace.body.supplies.find(
    (candidate: unknown) => isRecord(candidate) && candidate.id === supplyItemId
  );
  assert.ok(isRecord(requestableSupply), "Request-only user could not see the supply catalog");
  assert.equal("central_quantity" in requestableSupply, false, "Request-only workspace exposed Central Store balances");

  const forbiddenStockRead = await requestJson(
    baseUrl,
    `/api/stock?outlet_id=${encodeURIComponent(fixture.outletId)}`,
    "GET",
    undefined,
    requesterCookie
  );
  assert.equal(forbiddenStockRead.response.status, 403, "Request-only user could read the stock workspace");
  const forbiddenCatalogRead = await requestJson(
    baseUrl,
    `/api/pos/catalog?outlet_id=${encodeURIComponent(fixture.outletId)}&include_supplies=true`,
    "GET",
    undefined,
    requesterCookie
  );
  assert.equal(forbiddenCatalogRead.response.status, 403, "Request-only user could read the full catalog");

  const supplyRequest = await postStockAction(baseUrl, requesterCookie, fixture.outletId, "request", {
    warehouse: "supplies",
    note: "Automated supplies request test",
    lines: [{ item_id: supplyItemId, quantity: 5 }],
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assertSuccess(supplyRequest, "Submitting request-only Supplies requisition");
  const supplyRequestId = responseId(supplyRequest, "Supplies request");

  const rejectedSupplyDestination = await postStockAction(baseUrl, requesterCookie, fixture.outletId, "request", {
    warehouse: "kitchen",
    lines: [{ item_id: supplyItemId, quantity: 1 }],
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assert.equal(rejectedSupplyDestination.response.status, 400, "Supply item was accepted into a Kitchen request");
  const rejectedSaleDestination = await postStockAction(baseUrl, requesterCookie, fixture.outletId, "request", {
    warehouse: "supplies",
    lines: [{ item_id: itemId, quantity: 1 }],
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assert.equal(rejectedSaleDestination.response.status, 400, "Sale item was accepted into a Supplies request");

  const requesterHistory = await requestJson(
    baseUrl,
    `/api/stock/requests?outlet_id=${encodeURIComponent(fixture.outletId)}`,
    "GET",
    undefined,
    requesterCookie
  );
  assertSuccess(requesterHistory, "Reloading requester's Supplies history");
  assert.ok(Array.isArray(requesterHistory.body.requests));
  assert.ok(requesterHistory.body.requests.some(
    (candidate: unknown) => isRecord(candidate) && candidate.id === supplyRequestId
  ), "Requester could not see their own Supplies request");
  const unauthorizedFulfillment = await postStockAction(baseUrl, requesterCookie, fixture.outletId, "fulfill", {
    requisition_id: supplyRequestId,
    item_id: supplyItemId,
    quantity: 1,
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assert.equal(unauthorizedFulfillment.response.status, 403, "Request-only user could fulfill a Supplies request");

  const supplyCancelRequest = await postStockAction(baseUrl, requesterCookie, fixture.outletId, "request", {
    warehouse: "supplies",
    lines: [{ item_id: supplyItemId, quantity: 0.5 }],
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assertSuccess(supplyCancelRequest, "Submitting Supplies cancellation test request");
  const supplyCancellation = await postStockAction(baseUrl, requesterCookie, fixture.outletId, "cancel", {
    requisition_id: responseId(supplyCancelRequest, "Supplies cancellation request"),
  });
  assertSuccess(supplyCancellation, "Cancelling requester's Supplies requisition");

  for (const quantity of [2, 3]) {
    const fulfillment = await postStockAction(baseUrl, cookie, fixture.outletId, "fulfill", {
      requisition_id: supplyRequestId,
      item_id: supplyItemId,
      quantity,
      idempotency_key: `stock-test:${randomUUID()}`,
    });
    assertSuccess(fulfillment, "Fulfilling Supplies requisition");
    const workspace = await readWorkspace(baseUrl, cookie, fixture.outletId);
    assert.equal(
      findRequisition(workspace, supplyRequestId).status,
      quantity === 2 ? "partially_fulfilled" : "fulfilled"
    );
  }

  const invalidSupplyTransfer = await postStockAction(baseUrl, cookie, fixture.outletId, "transfer", {
    item_id: supplyItemId,
    warehouse: "bar",
    quantity: 1,
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assert.equal(invalidSupplyTransfer.response.status, 400, "Supply item was transferred into Bar stock");

  const supplyWastage = await postStockAction(baseUrl, cookie, fixture.outletId, "wastage", {
    item_id: supplyItemId,
    warehouse: "supplies",
    quantity: 1,
    reason: "Automated non-sale supplies wastage test",
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assertSuccess(supplyWastage, "Recording Supplies balance wastage");
  console.log("PASS request-only access, supply restrictions, partial issue, cancellation, and Supplies balance movements");

  const receiptKey = `stock-test:${randomUUID()}`;
  const receipt = await postStockAction(baseUrl, cookie, fixture.outletId, "receive", {
    item_id: itemId,
    supplier_name: "Automated stock workflow test",
    quantity: 10,
    unit_cost: 1.25,
    idempotency_key: receiptKey,
  });
  assertSuccess(receipt, "Receiving purchase into Central Store");
  const duplicateReceipt = await postStockAction(baseUrl, cookie, fixture.outletId, "receive", {
    item_id: itemId,
    supplier_name: "Automated stock workflow test",
    quantity: 10,
    unit_cost: 1.25,
    idempotency_key: receiptKey,
  });
  assert.equal(duplicateReceipt.response.status, 409, "Duplicate purchase receipt was not rejected");
  console.log("PASS received stock into Central Store and rejected a duplicate idempotency key");

  const directTransfer = await postStockAction(baseUrl, cookie, fixture.outletId, "transfer", {
    item_id: itemId,
    warehouse: "bar",
    quantity: 3,
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assertSuccess(directTransfer, "Transferring stock to Bar");

  const requisition = await postStockAction(baseUrl, cookie, fixture.outletId, "request", {
    warehouse: "kitchen",
    note: "Automated partial fulfillment test",
    lines: [{ item_id: itemId, quantity: 4 }],
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assertSuccess(requisition, "Submitting Kitchen stock request");
  const requisitionId = responseId(requisition, "Stock request");

  for (let issue = 0; issue < 2; issue += 1) {
    const fulfillment = await postStockAction(baseUrl, cookie, fixture.outletId, "fulfill", {
      requisition_id: requisitionId,
      item_id: itemId,
      quantity: 2,
      idempotency_key: `stock-test:${randomUUID()}`,
    });
    assertSuccess(fulfillment, `Partially fulfilling Kitchen request (${issue + 1}/2)`);
    const workspace = await readWorkspace(baseUrl, cookie, fixture.outletId);
    const current = findRequisition(workspace, requisitionId);
    assert.equal(current.status, issue === 0 ? "partially_fulfilled" : "fulfilled");
  }
  console.log("PASS transferred stock directly and partially fulfilled a Kitchen requisition");

  const rejectedRequest = await postStockAction(baseUrl, cookie, fixture.outletId, "request", {
    warehouse: "bar",
    lines: [{ item_id: itemId, quantity: 0.25 }],
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assertSuccess(rejectedRequest, "Submitting request for rejection test");
  const rejected = await postStockAction(baseUrl, cookie, fixture.outletId, "reject", {
    requisition_id: responseId(rejectedRequest, "Rejection test request"),
    reason: "Automated rejection-path test",
  });
  assertSuccess(rejected, "Rejecting stock request");

  const cancelledRequest = await postStockAction(baseUrl, cookie, fixture.outletId, "request", {
    warehouse: "kitchen",
    lines: [{ item_id: itemId, quantity: 0.25 }],
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assertSuccess(cancelledRequest, "Submitting request for cancellation test");
  const cancelled = await postStockAction(baseUrl, cookie, fixture.outletId, "cancel", {
    requisition_id: responseId(cancelledRequest, "Cancellation test request"),
  });
  assertSuccess(cancelled, "Cancelling stock request");
  console.log("PASS rejected and cancelled outstanding stock requests");

  const excessiveTransfer = await postStockAction(baseUrl, cookie, fixture.outletId, "transfer", {
    item_id: itemId,
    warehouse: "bar",
    quantity: 99,
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assert.equal(excessiveTransfer.response.status, 409, "Transfer exceeding Central Store balance was not rejected");

  const wastage = await postStockAction(baseUrl, cookie, fixture.outletId, "wastage", {
    item_id: itemId,
    warehouse: "bar",
    quantity: 0.5,
    reason: "Automated stock workflow test",
    idempotency_key: `stock-test:${randomUUID()}`,
  });
  assertSuccess(wastage, "Recording Bar wastage");

  const shift = await requestJson(baseUrl, "/api/pos/shifts", "POST", {
    outlet_id: fixture.outletId,
    station_id: fixture.stationId,
    opening_float: 0,
    area: "pos",
    period: "morning",
    business_date: currentBusinessDate(),
  }, cookie);
  assertSuccess(shift, "Opening a temporary cashier shift");
  assert.ok(isRecord(shift.body.shift) && typeof shift.body.shift.id === "string", "Shift response omitted its id");
  const shiftId = shift.body.shift.id;

  const supplySaleAttempt = await requestJson(baseUrl, "/api/pos/orders", "POST", {
    outlet_id: fixture.outletId,
    station_id: fixture.stationId,
    shift_id: shiftId,
    lines: [{ item_id: supplyItemId, quantity: 1 }],
    tenders: [{ type: "cash", amount: 0.01 }],
    idempotency_key: `stock-test:${randomUUID()}`,
  }, cookie);
  assert.equal(supplySaleAttempt.response.status, 400, "Non-sale supply was accepted as a POS sale");
  assert.match(String(supplySaleAttempt.body.message), /could not be found/i);

  const insufficientSale = await requestJson(baseUrl, "/api/pos/orders", "POST", {
    outlet_id: fixture.outletId,
    station_id: fixture.stationId,
    shift_id: shiftId,
    lines: [{ item_id: itemId, quantity: 99 }],
    tenders: [{ type: "cash", amount: 321.75 }],
    idempotency_key: `stock-test:${randomUUID()}`,
  }, cookie);
  assert.equal(insufficientSale.response.status, 409, "Sale exceeding Kitchen stock was not rejected");

  const sale = await requestJson(baseUrl, "/api/pos/orders", "POST", {
    outlet_id: fixture.outletId,
    station_id: fixture.stationId,
    shift_id: shiftId,
    lines: [{ item_id: itemId, quantity: 1 }],
    tenders: [{ type: "cash", amount: 3.25 }],
    idempotency_key: `stock-test:${randomUUID()}`,
  }, cookie);
  assertSuccess(sale, "Posting POS sale");
  const tableId = `SWT-${randomUUID().slice(0, 8)}`;
  const tableName = "Automated stock test table";
  const savedCheck = await requestJson(baseUrl, "/api/restaurant/checks", "POST", {
    action: "save",
    outlet_id: fixture.outletId,
    table_id: tableId,
    table_name: tableName,
    lines: [{
      item_id: itemId,
      quantity: 1,
      round: 1,
      sent_to_kitchen: false,
    }],
    create_kots: false,
  }, cookie);
  assertSuccess(savedCheck, "Saving restaurant check");
  if (typeof savedCheck.body.check_id !== "string") {
    throw new Error("Saved restaurant check response omitted its id");
  }
  if (typeof savedCheck.body.bill_number !== "string" || !/^\d{6}$/.test(savedCheck.body.bill_number)) {
    throw new Error("Saved restaurant check response omitted its unique bill number");
  }

  const settlementKey = `stock-test:${randomUUID()}`;
  const settlementBody = {
    action: "settle",
    outlet_id: fixture.outletId,
    table_id: tableId,
    table_name: tableName,
    check_id: savedCheck.body.check_id,
    tenders: [{ type: "cash", amount: 3.25 }],
    idempotency_key: settlementKey,
  };
  const settlement = await requestJson(baseUrl, "/api/restaurant/checks", "POST", settlementBody, cookie);
  assertSuccess(settlement, "Settling restaurant check");
  assert.ok(isRecord(settlement.body.fiscalization), "Settled bill omitted its eTIMS status");
  assert.equal(settlement.body.fiscalization.status, "blocked", "Bill without configured eTIMS mappings/provider should remain blocked");
  assert.match(String(settlement.body.message), /paid but not yet eTIMS-signed/i);
  const blockedRetry = await requestJson(baseUrl, "/api/restaurant/etims", "POST", {
    outlet_id: fixture.outletId,
    check_id: savedCheck.body.check_id,
    action: "retry_blocked",
  }, cookie);
  assertSuccess(blockedRetry, "Checking retry of a blocked eTIMS bill");
  assert.equal((blockedRetry.body.fiscalization as Record<string, unknown>).status, "blocked");
  const billHistory = await requestJson(
    baseUrl,
    `/api/restaurant/bills?outlet_id=${encodeURIComponent(fixture.outletId)}&business_date=${currentBusinessDate()}`,
    "GET",
    undefined,
    cookie
  );
  assertSuccess(billHistory, "Loading fiscal status in bill history");
  assert.ok(Array.isArray(billHistory.body.bills));
  const fiscalBill = billHistory.body.bills.find((bill: unknown) => isRecord(bill) && bill.id === savedCheck.body.check_id);
  assert.ok(isRecord(fiscalBill), "Settled bill was missing from cashier bill history");
  assert.equal(fiscalBill.etims_status, "blocked");
  assert.equal(fiscalBill.etims_signature, null);
  const duplicateSettlement = await requestJson(
    baseUrl,
    "/api/restaurant/checks",
    "POST",
    settlementBody,
    cookie
  );
  assert.equal(duplicateSettlement.response.status, 409, "Duplicate restaurant settlement was not rejected");
  console.log("PASS rejected overselling, recorded Bar wastage, and deducted POS and dining sales");

  const workspace = await readWorkspace(baseUrl, cookie, fixture.outletId);
  const item = findItem(workspace, itemId);
  const supplyItem = findItem(workspace, supplyItemId);
  assert.equal(Number(item.central_quantity), 3);
  assert.equal(Number(item.kitchen_quantity), 2);
  assert.equal(Number(item.bar_quantity), 2.5);
  assert.equal(item.available_at_outlet, true);
  assert.equal(Number(supplyItem.central_quantity), 3);
  assert.equal(Number(supplyItem.supplies_quantity), 4);
  assert.equal(supplyItem.item_type, "supply");
  assert.equal(supplyItem.available_at_outlet, true);
  assert.equal(findRequisition(workspace, supplyRequestId).status, "fulfilled");
  assert.equal(
    findRequisition(workspace, responseId(supplyCancelRequest, "Supplies cancellation request")).status,
    "cancelled"
  );
  assert.equal(findRequisition(workspace, responseId(rejectedRequest, "Rejection test request")).status, "rejected");
  assert.equal(findRequisition(workspace, responseId(cancelledRequest, "Cancellation test request")).status, "cancelled");

  assert.ok(Array.isArray(workspace.movements), "Stock response has no movement ledger");
  const itemMovements = workspace.movements.filter(
    (movement: unknown) => isRecord(movement) && movement.item_id === itemId
  );
  const movementTotals = new Map<string, number>();
  for (const movement of itemMovements) {
    if (!isRecord(movement) || typeof movement.movement_type !== "string") continue;
    movementTotals.set(
      movement.movement_type,
      (movementTotals.get(movement.movement_type) ?? 0) + Number(movement.quantity)
    );
  }
  assert.equal(movementTotals.get("purchase_receipt"), 10);
  assert.equal(movementTotals.get("stock_transfer"), 7);
  assert.equal(movementTotals.get("wastage"), 0.5);
  assert.equal(movementTotals.get("pos_sale"), 1);
  assert.equal(movementTotals.get("restaurant_sale"), 1);
  const supplyMovements = workspace.movements.filter(
    (movement: unknown) => isRecord(movement) && movement.item_id === supplyItemId
  );
  const supplyMovementTotals = new Map<string, number>();
  for (const movement of supplyMovements) {
    if (!isRecord(movement) || typeof movement.movement_type !== "string") continue;
    supplyMovementTotals.set(
      movement.movement_type,
      (supplyMovementTotals.get(movement.movement_type) ?? 0) + Number(movement.quantity)
    );
  }
  assert.equal(supplyMovementTotals.get("purchase_receipt"), 8);
  assert.equal(supplyMovementTotals.get("stock_transfer"), 5);
  assert.equal(supplyMovementTotals.get("wastage"), 1);

  const catalogAfterTransfer = await requestJson(
    baseUrl,
    `/api/pos/catalog?outlet_id=${encodeURIComponent(fixture.outletId)}`,
    "GET",
    undefined,
    cookie
  );
  assertSuccess(catalogAfterTransfer, "Reloading outlet catalog");
  assert.ok(Array.isArray(catalogAfterTransfer.body.items));
  const catalogItem = catalogAfterTransfer.body.items.find(
    (candidate: unknown) => isRecord(candidate) && candidate.id === itemId
  );
  assert.ok(isRecord(catalogItem), "Transferred item did not appear in outlet catalog");
  assert.equal(catalogItem.unit, "test-unit");
  assert.equal(catalogItem.sku, itemSku);
  assert.equal(catalogItem.etims_item_code, "KE1TEST000001");
  assert.equal(catalogItem.etims_tax_code, "B");
  assert.equal(
    catalogAfterTransfer.body.items.some(
      (candidate: unknown) => isRecord(candidate) && candidate.id === supplyItemId
    ),
    false,
    "Non-sale supply appeared in the POS catalog"
  );

  console.log("PASS non-sale supplies remain excluded from POS and retain persisted Supplies balances and ledger history");
  console.log("PASS reloaded persisted balances, requisitions, shared catalog item, and stock movement ledger");
  console.log("Stock workflow integration test passed.");

  const logout = await requestJson(baseUrl, "/api/auth/logout", "POST", undefined, cookie);
  assertSuccess(logout, "Revoking temporary test session");
  const requesterLogout = await requestJson(baseUrl, "/api/auth/logout", "POST", undefined, requesterCookie);
  assertSuccess(requesterLogout, "Revoking temporary requester session");
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("DATABASE_URL or POSTGRES_URL is required.");
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
    throw new Error("SESSION_SECRET must be configured to run the authenticated API workflow test.");
  }

  const baseUrl = (process.env.STOCK_WORKFLOW_TEST_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const pool = new Pool({
    connectionString,
    ssl: connectionNeedsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  let fixture: Fixture | undefined;
  let primaryError: unknown;
  try {
    const health = await fetch(new URL("/login", baseUrl), { signal: AbortSignal.timeout(5_000) });
    assert.equal(health.status, 200, `Start the built application at ${baseUrl} before running this test`);
    fixture = await seedFixture(pool);
    await runWorkflow(baseUrl, fixture);
  } catch (error) {
    primaryError = error;
  }

  try {
    if (fixture) await cleanupFixture(pool, fixture);
  } catch (error) {
    if (primaryError) {
      primaryError = new AggregateError([primaryError, error], "The test failed and its temporary database fixture could not be fully cleaned up.");
    } else {
      primaryError = error;
    }
  } finally {
    await pool.end();
  }

  if (primaryError) {
    const message = primaryError instanceof Error ? primaryError.message : "Unknown test failure";
    throw new Error(message);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown test failure";
  console.error(`Stock workflow integration test failed: ${message}`);
  process.exitCode = 1;
});
