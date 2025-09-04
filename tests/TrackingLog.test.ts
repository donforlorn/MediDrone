// TrackingLog.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface DeliveryDetails {
  status: string;
  operator: string;
  supplier: string;
  recipient: string;
  startTimestamp: number;
  expectedArrival: number;
  actualArrival: number | null;
  payloadHash: Buffer;
  logSequence: number;
  completed: boolean;
  failureReason: string | null;
}

interface EventLog {
  timestamp: number;
  gpsLat: string;
  gpsLon: string;
  altitude: number;
  statusUpdate: string;
  updater: string;
  notes: string;
  verifiedByOracle: boolean;
}

interface AuthorizedRoles {
  roles: number[];
}

interface ContractState {
  deliveryLogs: Map<number, DeliveryDetails>;
  eventLogs: Map<string, EventLog>; // Key: `${deliveryId}-${sequence}`
  authorizedRoles: Map<string, AuthorizedRoles>; // Key: `${user}-${deliveryId}`
  contractOwner: string;
  contractPaused: boolean;
  oracleRegistry: string[];
  logCounter: number;
}

// Mock contract implementation
class TrackingLogMock {
  private state: ContractState = {
    deliveryLogs: new Map(),
    eventLogs: new Map(),
    authorizedRoles: new Map(),
    contractOwner: "deployer",
    contractPaused: false,
    oracleRegistry: [],
    logCounter: 0,
  };

  private ERR_UNAUTHORIZED = 100;
  private ERR_INVALID_DELIVERY_ID = 101;
  private ERR_INVALID_STATUS = 102;
  private ERR_INVALID_GPS = 103;
  private ERR_SEQUENCE_MISMATCH = 104;
  private ERR_DELIVERY_COMPLETED = 105;
  private ERR_INVALID_PAYLOAD_HASH = 106;
  private ERR_INVALID_ORACLE = 107;
  private ERR_PAUSED = 108;
  private ERR_INVALID_TIMESTAMP = 109;
  private ERR_MAX_LOGS_EXCEEDED = 110;
  private ERR_INVALID_ROLE = 111;
  private ERR_ALREADY_INITIALIZED = 112;

  private STATUS_PENDING = "pending";
  private STATUS_ASSIGNED = "assigned";
  private STATUS_IN_TRANSIT = "in-transit";
  private STATUS_DELAYED = "delayed";
  private STATUS_ARRIVED = "arrived";
  private STATUS_DELIVERED = "delivered";
  private STATUS_FAILED = "failed";
  private STATUS_CANCELLED = "cancelled";

  private ROLE_OPERATOR = 1;
  private ROLE_ORACLE = 2;
  private ROLE_ADMIN = 3;
  private ROLE_SUPPLIER = 4;
  private ROLE_RECIPIENT = 5;

  private MAX_LOGS_PER_DELIVERY = 100;

  private blockHeight = 1000; // Mock block height

  // Helper to simulate block height increase
  private incrementBlockHeight() {
    this.blockHeight += 1;
  }

  initializeDelivery(
    caller: string,
    deliveryId: number,
    operator: string,
    supplier: string,
    recipient: string,
    expectedArrival: number,
    payloadHash: Buffer
  ): ClarityResponse<boolean> {
    if (this.state.deliveryLogs.has(deliveryId)) {
      return { ok: false, value: this.ERR_ALREADY_INITIALIZED };
    }
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    this.state.deliveryLogs.set(deliveryId, {
      status: this.STATUS_PENDING,
      operator,
      supplier,
      recipient,
      startTimestamp: this.blockHeight,
      expectedArrival,
      actualArrival: null,
      payloadHash,
      logSequence: 0,
      completed: false,
      failureReason: null,
    });
    // Assign roles
    this.state.authorizedRoles.set(`${caller}-${deliveryId}`, { roles: [this.ROLE_ADMIN] });
    this.state.authorizedRoles.set(`${operator}-${deliveryId}`, { roles: [this.ROLE_OPERATOR] });
    this.state.authorizedRoles.set(`${supplier}-${deliveryId}`, { roles: [this.ROLE_SUPPLIER] });
    this.state.authorizedRoles.set(`${recipient}-${deliveryId}`, { roles: [this.ROLE_RECIPIENT] });
    return { ok: true, value: true };
  }

  logEvent(
    caller: string,
    deliveryId: number,
    gpsLat: string,
    gpsLon: string,
    altitude: number,
    statusUpdate: string,
    notes: string
  ): ClarityResponse<number> {
    const delivery = this.state.deliveryLogs.get(deliveryId);
    if (!delivery) {
      return { ok: false, value: this.ERR_INVALID_DELIVERY_ID };
    }
    const currentSequence = delivery.logSequence;
    const newSequence = currentSequence + 1;
    const isOracleUpdate = this.state.oracleRegistry.includes(caller);
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (delivery.completed) {
      return { ok: false, value: this.ERR_DELIVERY_COMPLETED };
    }
    const isAuthorized = this.hasRole(caller, deliveryId, this.ROLE_OPERATOR) || isOracleUpdate;
    if (!isAuthorized) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (!this.validateStatus(statusUpdate) || !this.validateGps(gpsLat, gpsLon)) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    if (currentSequence >= this.MAX_LOGS_PER_DELIVERY) {
      return { ok: false, value: this.ERR_MAX_LOGS_EXCEEDED };
    }
    this.state.eventLogs.set(`${deliveryId}-${newSequence}`, {
      timestamp: this.blockHeight,
      gpsLat,
      gpsLon,
      altitude,
      statusUpdate,
      updater: caller,
      notes,
      verifiedByOracle: isOracleUpdate,
    });
    delivery.status = statusUpdate;
    delivery.logSequence = newSequence;
    if ([this.STATUS_DELIVERED, this.STATUS_FAILED, this.STATUS_CANCELLED].includes(statusUpdate)) {
      delivery.completed = true;
      delivery.actualArrival = this.blockHeight;
    }
    this.incrementBlockHeight();
    return { ok: true, value: newSequence };
  }

  logFailure(
    caller: string,
    deliveryId: number,
    reason: string
  ): ClarityResponse<boolean> {
    const delivery = this.state.deliveryLogs.get(deliveryId);
    if (!delivery) {
      return { ok: false, value: this.ERR_INVALID_DELIVERY_ID };
    }
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (delivery.completed) {
      return { ok: false, value: this.ERR_DELIVERY_COMPLETED };
    }
    if (!this.hasRole(caller, deliveryId, this.ROLE_OPERATOR)) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    delivery.status = this.STATUS_FAILED;
    delivery.completed = true;
    delivery.failureReason = reason;
    return { ok: true, value: true };
  }

  addOracle(caller: string, oracle: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (this.state.oracleRegistry.length >= 10) {
      return { ok: false, value: this.ERR_INVALID_ORACLE };
    }
    this.state.oracleRegistry.push(oracle);
    return { ok: true, value: true };
  }

  removeOracle(caller: string, oracle: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.oracleRegistry = this.state.oracleRegistry.filter(o => o !== oracle);
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.contractPaused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.contractPaused = false;
    return { ok: true, value: true };
  }

  assignRole(caller: string, user: string, deliveryId: number, role: number): ClarityResponse<boolean> {
    const delivery = this.state.deliveryLogs.get(deliveryId);
    if (!delivery) {
      return { ok: false, value: this.ERR_INVALID_DELIVERY_ID };
    }
    if (!this.hasRole(caller, deliveryId, this.ROLE_ADMIN)) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    const key = `${user}-${deliveryId}`;
    const currentRoles = this.state.authorizedRoles.get(key) || { roles: [] };
    if (currentRoles.roles.length >= 5) {
      return { ok: false, value: this.ERR_INVALID_ROLE };
    }
    currentRoles.roles.push(role);
    this.state.authorizedRoles.set(key, currentRoles);
    return { ok: true, value: true };
  }

  removeRole(caller: string, user: string, deliveryId: number, role: number): ClarityResponse<boolean> {
    const delivery = this.state.deliveryLogs.get(deliveryId);
    if (!delivery) {
      return { ok: false, value: this.ERR_INVALID_DELIVERY_ID };
    }
    if (!this.hasRole(caller, deliveryId, this.ROLE_ADMIN)) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    const key = `${user}-${deliveryId}`;
    const currentRoles = this.state.authorizedRoles.get(key);
    if (currentRoles) {
      currentRoles.roles = currentRoles.roles.filter(r => r !== role);
      this.state.authorizedRoles.set(key, currentRoles);
    }
    return { ok: true, value: true };
  }

  getDeliveryDetails(deliveryId: number): ClarityResponse<DeliveryDetails | null> {
    return { ok: true, value: this.state.deliveryLogs.get(deliveryId) ?? null };
  }

  getEventLog(deliveryId: number, sequence: number): ClarityResponse<EventLog | null> {
    return { ok: true, value: this.state.eventLogs.get(`${deliveryId}-${sequence}`) ?? null };
  }

  getLatestSequence(deliveryId: number): ClarityResponse<number> {
    const delivery = this.state.deliveryLogs.get(deliveryId);
    if (!delivery) {
      return { ok: false, value: this.ERR_INVALID_DELIVERY_ID };
    }
    return { ok: true, value: delivery.logSequence };
  }

  isDeliveryCompleted(deliveryId: number): ClarityResponse<boolean> {
    const delivery = this.state.deliveryLogs.get(deliveryId);
    if (!delivery) {
      return { ok: false, value: this.ERR_INVALID_DELIVERY_ID };
    }
    return { ok: true, value: delivery.completed };
  }

  getOracles(): ClarityResponse<string[]> {
    return { ok: true, value: this.state.oracleRegistry };
  }

  hasRole(user: string, deliveryId: number, role: number): boolean {
    const roles = this.state.authorizedRoles.get(`${user}-${deliveryId}`);
    return roles ? roles.roles.includes(role) : false;
  }

  getContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.contractPaused };
  }

  getContractOwner(): ClarityResponse<string> {
    return { ok: true, value: this.state.contractOwner };
  }

  private validateStatus(status: string): boolean {
    return [
      this.STATUS_PENDING,
      this.STATUS_ASSIGNED,
      this.STATUS_IN_TRANSIT,
      this.STATUS_DELAYED,
      this.STATUS_ARRIVED,
      this.STATUS_DELIVERED,
      this.STATUS_FAILED,
      this.STATUS_CANCELLED,
    ].includes(status);
  }

  private validateGps(lat: string, lon: string): boolean {
    return lat.length > 0 && lon.length > 0;
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  operator: "operator",
  supplier: "supplier",
  recipient: "recipient",
  oracle: "oracle",
  unauthorized: "unauthorized",
};

describe("TrackingLog Contract", () => {
  let contract: TrackingLogMock;

  beforeEach(() => {
    contract = new TrackingLogMock();
    vi.resetAllMocks();
  });

  it("should initialize a new delivery", () => {
    const payloadHash = Buffer.from("test-hash");
    const initResult = contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );
    expect(initResult).toEqual({ ok: true, value: true });

    const details = contract.getDeliveryDetails(1);
    expect(details.ok).toBe(true);
    expect(details.value).toMatchObject({
      status: "pending",
      operator: accounts.operator,
      supplier: accounts.supplier,
      recipient: accounts.recipient,
      logSequence: 0,
      completed: false,
    });
  });

  it("should prevent duplicate initialization", () => {
    const payloadHash = Buffer.from("test-hash");
    contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );

    const duplicateInit = contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );
    expect(duplicateInit).toEqual({ ok: false, value: 112 });
  });

  it("should allow authorized operator to log event", () => {
    const payloadHash = Buffer.from("test-hash");
    contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );

    const logResult = contract.logEvent(
      accounts.operator,
      1,
      "40.7128",
      "-74.0060",
      100,
      "in-transit",
      "Flight started"
    );
    expect(logResult).toEqual({ ok: true, value: 1 });

    const event = contract.getEventLog(1, 1);
    expect(event.ok).toBe(true);
    expect(event.value).toMatchObject({
      gpsLat: "40.7128",
      gpsLon: "-74.0060",
      altitude: 100,
      statusUpdate: "in-transit",
      updater: accounts.operator,
      notes: "Flight started",
      verifiedByOracle: false,
    });
  });

  it("should allow oracle to log event", () => {
    const payloadHash = Buffer.from("test-hash");
    contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );
    contract.addOracle(accounts.deployer, accounts.oracle);

    const logResult = contract.logEvent(
      accounts.oracle,
      1,
      "40.7128",
      "-74.0060",
      100,
      "in-transit",
      "Automated update"
    );
    expect(logResult).toEqual({ ok: true, value: 1 });

    const event = contract.getEventLog(1, 1);
    expect(event.value?.verifiedByOracle).toBe(true);
  });

  it("should prevent unauthorized user from logging event", () => {
    const payloadHash = Buffer.from("test-hash");
    contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );

    const logResult = contract.logEvent(
      accounts.unauthorized,
      1,
      "40.7128",
      "-74.0060",
      100,
      "in-transit",
      "Unauthorized"
    );
    expect(logResult).toEqual({ ok: false, value: 100 });
  });

  it("should mark delivery as completed on final status", () => {
    const payloadHash = Buffer.from("test-hash");
    contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );

    contract.logEvent(
      accounts.operator,
      1,
      "40.7128",
      "-74.0060",
      100,
      "delivered",
      "Package handed over"
    );

    const completed = contract.isDeliveryCompleted(1);
    expect(completed).toEqual({ ok: true, value: true });
  });

  it("should allow logging failure", () => {
    const payloadHash = Buffer.from("test-hash");
    contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );

    const failureResult = contract.logFailure(
      accounts.operator,
      1,
      "Weather issues"
    );
    expect(failureResult).toEqual({ ok: true, value: true });

    const details = contract.getDeliveryDetails(1);
    expect(details.value?.status).toBe("failed");
    expect(details.value?.completed).toBe(true);
    expect(details.value?.failureReason).toBe("Weather issues");
  });

  it("should add and remove oracles", () => {
    const addResult = contract.addOracle(accounts.deployer, accounts.oracle);
    expect(addResult).toEqual({ ok: true, value: true });
    expect(contract.getOracles()).toEqual({ ok: true, value: [accounts.oracle] });

    const removeResult = contract.removeOracle(accounts.deployer, accounts.oracle);
    expect(removeResult).toEqual({ ok: true, value: true });
    expect(contract.getOracles()).toEqual({ ok: true, value: [] });
  });

  it("should pause and unpause contract", () => {
    const pauseResult = contract.pauseContract(accounts.deployer);
    expect(pauseResult).toEqual({ ok: true, value: true });
    expect(contract.getContractPaused()).toEqual({ ok: true, value: true });

    const payloadHash = Buffer.from("test-hash");
    const initDuringPause = contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );
    expect(initDuringPause).toEqual({ ok: false, value: 108 });

    const unpauseResult = contract.unpauseContract(accounts.deployer);
    expect(unpauseResult).toEqual({ ok: true, value: true });
    expect(contract.getContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should assign and remove roles", () => {
    const payloadHash = Buffer.from("test-hash");
    contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );

    const assignResult = contract.assignRole(
      accounts.deployer,
      accounts.unauthorized,
      1,
      2 // ROLE_ORACLE, but this is not actual oracle registry
    );
    expect(assignResult).toEqual({ ok: true, value: true });

    expect(contract.hasRole(accounts.unauthorized, 1, 2)).toBe(true);

    const removeResult = contract.removeRole(
      accounts.deployer,
      accounts.unauthorized,
      1,
      2
    );
    expect(removeResult).toEqual({ ok: true, value: true });
    expect(contract.hasRole(accounts.unauthorized, 1, 2)).toBe(false);
  });

  it("should prevent logging after max logs exceeded", () => {
    const payloadHash = Buffer.from("test-hash");
    contract.initializeDelivery(
      accounts.deployer,
      1,
      accounts.operator,
      accounts.supplier,
      accounts.recipient,
      2000,
      payloadHash
    );

    // Simulate max logs
    const delivery = contract.state.deliveryLogs.get(1)!;
    delivery.logSequence = 100;

    const logResult = contract.logEvent(
      accounts.operator,
      1,
      "40.7128",
      "-74.0060",
      100,
      "in-transit",
      "Max exceeded"
    );
    expect(logResult).toEqual({ ok: false, value: 110 });
  });
});